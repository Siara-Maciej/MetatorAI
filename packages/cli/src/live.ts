import type { Question, RunActivity } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { Terminal } from "./terminal.ts";

/** One activity entry as one line of the live view; null for entries the view leaves out. */
export function formatActivity(e: RunActivity): string | null {
  const who = e.agent ? `${e.agent}: ` : "";
  switch (e.type) {
    case "stage":
      return `▸ ${e.stage} · ${e.text}`;
    case "agent":
      return `  ${e.text}`;
    case "text":
      return `  ${who}${e.text.split("\n").find((l) => l.trim() !== "") ?? ""}`;
    case "tool":
      return `    ${e.text}`;
    case "gate":
      return `  gate ${e.text}`;
    case "advance":
      return e.text.startsWith("FAIL") ? `  ✗ ${e.text}` : `  ✓ ${e.text}`;
    case "answer":
      return `  ↳ ${e.text}`;
    case "error":
      return `  ! ${e.text}`;
    case "drive":
      return `· ${e.text}`;
    case "question":
      return null; // asked in place
    default:
      return null;
  }
}

export interface FollowResult {
  readonly runId: string;
  readonly status: string;
  readonly stage: string;
  /** The person left the view (Ctrl+C); the run goes on without them. */
  readonly detached: boolean;
}

/**
 * The live view of a driven run: prints new activity, asks each open question in place and
 * records the answer, until the run ends or its driver is gone, or the person leaves.
 */
export async function follow(
  c: MetatorContainer,
  runId: string,
  terminal: Terminal,
  by: string,
  pollMs = 300,
): Promise<FollowResult> {
  const journal = c.resolve("runJournal");
  const drivers = c.resolve("runDrivers");
  const repo = c.resolve("runRepository");
  let shown = 0;
  for (;;) {
    const activity = await journal.activity(runId);
    if (activity.isOk()) {
      for (const e of activity.value.slice(shown)) {
        const line = formatActivity(e);
        if (line !== null) terminal.show(line);
      }
      shown = activity.value.length;
    }
    const open = (await journal.questions(runId)).map((qs) => qs.filter((q) => !q.answer));
    const question: Question | undefined = open.isOk() ? open.value[0] : undefined;
    if (question) {
      const answer = await terminal.answer(question);
      if (answer === null) return { ...(await state()), detached: true };
      const saved = await journal.answer(runId, question.id, { ...answer, by });
      if (saved.isErr()) terminal.show(`  ! ${saved.error.message}`);
      continue;
    }
    const driver = await drivers.status(runId);
    const s = await state();
    if (s.status !== "active" || !(driver.isOk() && driver.value?.alive)) {
      // One last read, so the final lines are not lost.
      const last = await journal.activity(runId);
      if (last.isOk())
        for (const e of last.value.slice(shown)) {
          const line = formatActivity(e);
          if (line !== null) terminal.show(line);
        }
      return { ...s, detached: false };
    }
    await Bun.sleep(pollMs);
  }

  async function state(): Promise<Omit<FollowResult, "detached">> {
    const r = await repo.load(runId);
    return r.isOk()
      ? { runId, status: r.value.state.status, stage: r.value.state.stage }
      : { runId, status: "unknown", stage: "unknown" };
  }
}

/** Who answers: METATOR_USER, else the login name. */
export function person(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.METATOR_USER ?? env.USER ?? env.USERNAME ?? "you";
}
