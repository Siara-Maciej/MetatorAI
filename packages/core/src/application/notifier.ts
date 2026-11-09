import { type Question, QuestionDocument } from "../domain/drive.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type { ProcessRunner } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";

export interface NotifierDependencies {
  readonly journal: Pick<RunJournal, "record" | "activity">;
  readonly process: Pick<ProcessRunner, "run">;
  readonly root: string;
  /** `notify.command` of the configuration; none means no notifications. */
  readonly command?: string;
}

/**
 * Tells a person a question waits (P5, R3): runs `notify.command` once per question, with the
 * question in the environment (`METATOR_QUESTION` as JSON, `METATOR_QUESTION_PROMPT`, `METATOR_RUN`,
 * `METATOR_QUESTION_ID`). A failure is a line in the run's activity, never fatal.
 */
export class Notifier {
  constructor(private readonly d: NotifierDependencies) {}

  async notify(q: Question): Promise<void> {
    if (!this.d.command) return;
    const activity = await this.d.journal.activity(q.runId);
    const mark = `notified ${q.id}`;
    if (activity.isOk() && activity.value.some((a) => a.type === "drive" && a.text.startsWith(mark))) return;
    const r = await this.d.process.run(
      {
        argv: ["sh", "-c", this.d.command],
        cwd: this.d.root,
        env: {
          METATOR_RUN: q.runId,
          METATOR_QUESTION_ID: q.id,
          METATOR_QUESTION_PROMPT: q.prompt,
          METATOR_QUESTION: serializeJsonDocument(QuestionDocument.stamp(q)),
        },
      },
      { timeoutMs: 30_000 },
    );
    await this.d.journal.record(q.runId, {
      type: r.exitCode === 0 ? "drive" : "error",
      stage: q.stage,
      text:
        r.exitCode === 0
          ? mark
          : `notify.command failed for ${q.id} (exit ${r.exitCode}): ${r.stderr.trim().slice(-300)}`,
    });
  }
}
