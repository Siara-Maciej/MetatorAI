import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { PaneSensor } from "./pane-sensor.ts";
import type { Panes, ResumeNotice } from "./panes.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

export interface ResumeNoticesDependencies {
  readonly panes: Pick<Panes, "resumeNotices" | "resumeNoticeTold">;
  readonly sensor: Pick<PaneSensor, "state">;
  /** Who holds the run's keyboard (its driver lock): never typed over a person. */
  readonly repo: Pick<RunRepository, "load">;
  readonly journal: Pick<RunJournal, "record">;
  /** The supervisor's nudge: the words, then Enter as its own write. */
  readonly nudge: (paneId: string, text: string) => Promise<Result<void, MetatorError>>;
  /** A pane whose agent asked the person in words and waits: nothing is typed into it meanwhile. */
  readonly asksInPane?: (paneId: string) => boolean;
}

/** The line a resumed session's agent reads, by what it is in its run. */
export function resumeLine(n: Pick<ResumeNotice, "role" | "why" | "at">): string {
  return n.role === "conductor"
    ? `[metator] Your session was resumed after the daemon stopped (${n.why}, at ${n.at}). Continue where you stopped: check \`metator run status\` and your workers (\`metator run workers\`).`
    : "[metator] Your session was resumed after the daemon stopped. Continue your card where you stopped and report with `metator run result`.";
}

/**
 * A host's own resume (`claude --resume`) brings back the conversation, not the turn: the agent
 * sits at its prompt after "Interrupted". Once it is idle there and no person holds the run's
 * keyboard, it is told in one line to go on, once per resume (ADR-0092); the run's activity
 * records it. Until then the line waits.
 */
export class ResumeNotices {
  constructor(private readonly d: ResumeNoticesDependencies) {}

  async tick(): Promise<
    Result<
      readonly { readonly paneId: string; readonly runId: string; readonly line: string }[],
      MetatorError
    >
  > {
    const out: { paneId: string; runId: string; line: string }[] = [];
    for (const n of this.d.panes.resumeNotices()) {
      const record = await this.d.repo.load(n.runId);
      if (record.isOk() && record.value.driver?.by === "human") continue;
      if (this.d.asksInPane?.(n.paneId)) continue;
      const state = await this.d.sensor.state(n.paneId);
      if (state.isErr() || state.value.state !== "idle") continue;
      const line = resumeLine(n);
      const typed = await this.d.nudge(n.paneId, line);
      if (typed.isErr()) continue;
      this.d.panes.resumeNoticeTold(n.paneId);
      const noted = await this.d.journal.record(n.runId, {
        type: "agent",
        origin: "run",
        text: `told the resumed session in pane ${n.paneId}: ${line}`,
      });
      if (noted.isErr()) return err(noted.error);
      out.push({ paneId: n.paneId, runId: n.runId, line });
    }
    return ok(out);
  }
}
