import { type Question, QuestionDocument, type RunActivity } from "../domain/drive.ts";
import type { MetatorError } from "../domain/errors.ts";
import type { Result } from "../domain/result.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type { ProcessRunner } from "../ports/index.ts";

/** The run journal as the notifier needs it (structural, so the journal may depend on the notifier). */
export interface NotifierJournal {
  record(runId: string, entry: Omit<RunActivity, "at">): Promise<Result<void, MetatorError>>;
  activity(runId: string): Promise<Result<readonly RunActivity[], MetatorError>>;
}

export interface NotifierDependencies {
  readonly journal: NotifierJournal;
  readonly process: Pick<ProcessRunner, "run">;
  readonly root: string;
  /** `notify.command` of the configuration; none means no notifications. */
  readonly command?: string;
}

/** A review of a person's own request that brought new threads (T3, design/14 §4). */
export interface ReviewNotice {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly url?: string;
  /** How many threads are new. */
  readonly fresh: number;
}

/** The line a person reads in the notification of a review. */
export function reviewNoticeText(n: ReviewNotice): string {
  return `Review on #${n.number} ${n.title}: ${n.fresh} new ${n.fresh === 1 ? "thread" : "threads"}`;
}

/**
 * Tells a person a question waits (P5, R3): runs `notify.command` once per question, with the
 * question in the environment (`METATOR_QUESTION` as JSON, `METATOR_QUESTION_PROMPT`, `METATOR_RUN`,
 * `METATOR_QUESTION_ID`). A failure is a line in the run's activity, never fatal.
 *
 * Every notification says what it is about in `METATOR_EVENT` (`question` or `review`) and
 * carries one readable line in `METATOR_NOTIFY_TEXT`.
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
          METATOR_EVENT: "question",
          METATOR_NOTIFY_TEXT: q.prompt,
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

  /**
   * Tells a person their request was reviewed: the same command, with `METATOR_EVENT=review`, the
   * review's id, number, title and url. `METATOR_QUESTION_PROMPT` carries the line too, so a
   * command written for questions shows it. Answers why the command failed, when it did.
   */
  async review(n: ReviewNotice): Promise<string | undefined> {
    if (!this.d.command) return undefined;
    const text = reviewNoticeText(n);
    const r = await this.d.process.run(
      {
        argv: ["sh", "-c", this.d.command],
        cwd: this.d.root,
        env: {
          METATOR_EVENT: "review",
          METATOR_NOTIFY_TEXT: text,
          METATOR_QUESTION_PROMPT: text,
          METATOR_REVIEW_ID: n.id,
          METATOR_REVIEW_NUMBER: String(n.number),
          METATOR_REVIEW_TITLE: n.title,
          ...(n.url ? { METATOR_REVIEW_URL: n.url } : {}),
        },
      },
      { timeoutMs: 30_000 },
    );
    return r.exitCode === 0
      ? undefined
      : `notify.command failed for ${n.id} (exit ${r.exitCode}): ${r.stderr.trim().slice(-300)}`;
  }
}
