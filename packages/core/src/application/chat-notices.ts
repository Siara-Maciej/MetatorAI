import type { MetatorError } from "../domain/errors.ts";
import { stoppedAt } from "../domain/overview.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { PaneSensor } from "./pane-sensor.ts";
import type { Panes } from "./panes.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

export interface ChatNoticesDependencies {
  readonly panes: Pick<Panes, "view">;
  readonly repo: Pick<RunRepository, "load">;
  readonly journal: Pick<RunJournal, "questions" | "activity" | "record">;
  readonly sensor: Pick<PaneSensor, "state">;
  /** Types a line into a pane as a new message: the words, then Enter as its own write. */
  readonly nudge: (paneId: string, text: string) => Promise<Result<void, MetatorError>>;
}

/**
 * Where a run of another repository is read and noted: the chat of a folder (ADR-0114) starts
 * runs in the folder's repositories, each of which keeps its own runs.
 */
export interface RunsElsewhere {
  readonly repo: Pick<RunRepository, "load">;
  readonly journal: Pick<RunJournal, "questions" | "activity" | "record">;
}

/** What happened to a task that its chat is told: one line each, once. */
export interface ChatNotice {
  readonly paneId: string;
  readonly runId: string;
  /** done, planned, aborted, escalated, approval: what the line says happened. */
  readonly event: string;
  readonly line: string;
}

/** The mark in the run's activity that a line was typed into the chat: `told the chat (pane w1:p1, done)`. */
const told = (paneId: string, key: string) => `told the chat (pane ${paneId}, ${key})`;

/**
 * The chat where a person gave a task learns what became of it (ADR-0092): when the run started
 * from it (`startedRun`) finishes, stops for the person (escalated) or waits for a person's
 * approval, one line is typed into the chat's agent as a new message, once per event, when that
 * agent is idle at its prompt; until then it waits. The run's activity records each line.
 */
export class ChatNotices {
  constructor(private readonly d: ChatNoticesDependencies) {}

  /** `elsewhere`: the repositories a run this place does not hold is looked for in (a folder's chat). */
  async tick(elsewhere: readonly RunsElsewhere[] = []): Promise<Result<readonly ChatNotice[], MetatorError>> {
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const out: ChatNotice[] = [];
    for (const pane of view.value.panes) {
      if (!pane.startedRun || !pane.live?.alive || pane.ended || pane.paused) continue;
      const at = await this.holderOf(pane.startedRun, elsewhere);
      const event = await this.eventOf(pane.startedRun, at);
      if (event.isErr()) return err(event.error);
      if (!event.value) continue;
      const activity = await at.journal.activity(pane.startedRun);
      if (activity.isErr()) return err(activity.error);
      const mark = told(pane.id, event.value.key);
      if (activity.value.some((a) => a.text.startsWith(mark))) continue;
      // Only into an agent at rest: never over its work, nor over a person typing (which is work too).
      const state = await this.d.sensor.state(pane.id);
      if (state.isErr() || state.value.state !== "idle") continue;
      const typed = await this.d.nudge(pane.id, event.value.line);
      if (typed.isErr()) continue;
      const noted = await at.journal.record(pane.startedRun, {
        type: "agent",
        origin: "run",
        text: `${mark}: ${event.value.line}`,
      });
      if (noted.isErr()) return err(noted.error);
      out.push({ paneId: pane.id, runId: pane.startedRun, event: event.value.kind, line: event.value.line });
    }
    return ok(out);
  }

  /** Where the run is kept: here, else the first of the other repositories that can read it. */
  private async holderOf(runId: string, elsewhere: readonly RunsElsewhere[]): Promise<RunsElsewhere> {
    if (elsewhere.length === 0 || (await this.d.repo.load(runId)).isOk()) return this.d;
    for (const other of elsewhere) if ((await other.repo.load(runId)).isOk()) return other;
    return this.d;
  }

  /** What the chat is to be told about its run now, if anything: the latest event, with its key. */
  private async eventOf(
    runId: string,
    at: RunsElsewhere,
  ): Promise<
    Result<{ readonly kind: string; readonly key: string; readonly line: string } | undefined, MetatorError>
  > {
    const record = await at.repo.load(runId);
    // A run that cannot be read now is told about later.
    if (record.isErr()) return ok(undefined);
    const r = record.value;
    const status = r.state.status;
    const what = `The task ${runId} (${r.task.split("\n")[0]})`;
    if (status === "done")
      return ok({
        kind: "done",
        key: "done",
        line: `[metator] ${what} is done. Tell the person what was done.`,
      });
    // A plan made on demand is ready (ADR-0096): the chat may offer to keep it in the Backlog.
    if (status === "planned")
      return ok({
        kind: "planned",
        key: "planned",
        line: `[metator] ${what} has its plan approved and stopped there (plan ready). Ask the person whether to put the plan in the Backlog (\`metator issue from-plan --run ${runId}\`).`,
      });
    if (status === "aborted")
      return ok({
        kind: "aborted",
        key: "aborted",
        line: `[metator] ${what} was closed as aborted. Tell the person.`,
      });
    if (status === "escalated") {
      const at = stoppedAt(r.state.stage, status, r.state.context.history);
      return ok({
        kind: "escalated",
        key: `escalated ${r.updatedAt}`,
        line: `[metator] ${what} stopped at ${at} and needs the person. Tell the person what it needs (Home in the app shows it).`,
      });
    }
    const questions = await at.journal.questions(runId);
    if (questions.isErr()) return err(questions.error);
    const gate = questions.value.find((q) => q.source === "gate" && !q.answer);
    if (gate)
      return ok({
        kind: "approval",
        key: `approval ${gate.id}`,
        line: `[metator] ${what} waits for a person's approval at ${gate.stage}. Tell the person to approve it in the app (Home).`,
      });
    return ok(undefined);
  }
}
