import {
  type DecisionCard,
  labelFor,
  nextQuestionId,
  type Question,
  type QuestionAnswer,
  QuestionDocument,
  type RunActivity,
  RunActivityDocument,
  RunSeenDocument,
} from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type AgentUsage, AgentUsageDocument } from "../domain/telemetry.ts";
import { serializeJsonLine } from "../domain/versioned.ts";
import type { Clock, FileSystem, Timer } from "../ports/index.ts";
import { loadDocument, readDocument, readJsonLines, writeDocument } from "./document-io.ts";
import type { RunRepository } from "./run-repository.ts";

/** The free-text option every question has, so a person is never forced into a listed choice. */
export const OTHER = "Other";

export type ActivityInput = Omit<RunActivity, "at">;

/** What a drive leaves in the run directory: the activity line by line, and the questions. */
export class RunJournal {
  constructor(
    private readonly fs: FileSystem,
    private readonly repo: RunRepository,
    private readonly clock: Clock,
  ) {}

  activityFile(runId: string): string {
    return `${this.repo.runDir(runId)}/activity.jsonl`;
  }

  usageFile(runId: string): string {
    return `${this.repo.runDir(runId)}/usage.jsonl`;
  }

  /** The time now, from the journal's clock: how long an agent call took. */
  now(): Date {
    return this.clock.now();
  }

  /** One agent call's usage, appended to `usage.jsonl`. */
  async recordUsage(runId: string, entry: Omit<AgentUsage, "at">): Promise<Result<void, MetatorError>> {
    const line = serializeJsonLine(
      AgentUsageDocument.stamp({ at: this.clock.now().toISOString(), ...entry }),
    );
    return this.fs.append(this.usageFile(runId), line);
  }

  async usage(runId: string): Promise<Result<readonly AgentUsage[], MetatorError>> {
    return readJsonLines(this.fs, this.usageFile(runId), AgentUsageDocument, "fail");
  }

  seenFile(runId: string): string {
    return `${this.repo.runDir(runId)}/seen.json`;
  }

  /** When a person last read the run's brief; undefined before the first. */
  async seen(runId: string): Promise<Result<string | undefined, MetatorError>> {
    const file = this.seenFile(runId);
    return (await readDocument(this.fs, file, RunSeenDocument, "json")).map((d) => d?.at);
  }

  /** A person has read the run up to now: the next brief starts here. */
  async markSeen(runId: string): Promise<Result<string, MetatorError>> {
    const at = this.clock.now().toISOString();
    const written = await writeDocument(this.fs, this.seenFile(runId), RunSeenDocument, { at }, "json");
    return written.map(() => at);
  }

  questionFile(runId: string, id: string): string {
    return `${this.repo.runDir(runId)}/questions/${id}.json`;
  }

  /** One line appended in one step: hooks, the daemon and the CLI record at once without losing a line. */
  async record(runId: string, entry: ActivityInput): Promise<Result<void, MetatorError>> {
    const line = serializeJsonLine(
      RunActivityDocument.stamp({ at: this.clock.now().toISOString(), ...entry }),
    );
    return this.fs.append(this.activityFile(runId), line);
  }

  async activity(runId: string): Promise<Result<readonly RunActivity[], MetatorError>> {
    // A torn line (a writer killed mid-append) is skipped: the rest of the journal still reads.
    return readJsonLines(this.fs, this.activityFile(runId), RunActivityDocument, "skip");
  }

  async questions(runId: string): Promise<Result<readonly Question[], MetatorError>> {
    const files = await this.fs.glob([`${this.repo.runDir(runId)}/questions/q*.json`]);
    const out: Question[] = [];
    for (const file of files) {
      const q = await loadDocument(this.fs, file, QuestionDocument, "json");
      if (q.isErr()) return err(q.error);
      out.push(q.value);
    }
    return ok(out.sort((a, b) => a.id.localeCompare(b.id)));
  }

  /**
   * Asks a person. A drive that restarts (`run continue`) asks again: the question it asked before
   * stands, and so does an answer given after `pendingSince` (the run's last change), which no
   * drive has acted on yet.
   */
  async ask(
    runId: string,
    q: Pick<Question, "stage" | "source" | "prompt" | "options" | "multiSelect"> & {
      readonly agent?: string;
      readonly card?: DecisionCard;
    },
    pendingSince?: string,
  ): Promise<Result<Question, MetatorError>> {
    const existing = await this.questions(runId);
    if (existing.isErr()) return err(existing.error);
    const standing = existing.value.find(
      (e) =>
        e.stage === q.stage &&
        e.source === q.source &&
        e.prompt === q.prompt &&
        (!e.answer || (pendingSince !== undefined && e.answer.at > pendingSince)),
    );
    if (standing) return ok(standing);
    const options = q.options.some((o) => o.label === OTHER)
      ? q.options
      : [...q.options, { label: OTHER, description: "Answer in your own words" }];
    const question: Question = {
      id: nextQuestionId(existing.value.map((e) => e.id)),
      runId,
      stage: q.stage,
      source: q.source,
      ...(q.agent ? { agent: q.agent } : {}),
      prompt: q.prompt,
      options,
      multiSelect: q.multiSelect,
      askedAt: this.clock.now().toISOString(),
      ...(q.card ? { card: q.card } : {}),
    };
    const saved = await this.save(question);
    if (saved.isErr()) return err(saved.error);
    const logged = await this.record(runId, {
      type: "question",
      stage: q.stage,
      ...(q.agent ? { agent: q.agent } : {}),
      text: `${question.id}: ${q.prompt}`,
    });
    if (logged.isErr()) return err(logged.error);
    return ok(question);
  }

  /** Records a person's answer; the drive waiting on the question picks it up. */
  async answer(
    runId: string,
    id: string,
    input: {
      readonly choices: readonly string[];
      readonly text?: string;
      readonly by: string;
      /** `inbox`: answered from the decision card, without opening the session (11a). */
      readonly origin?: "inbox";
    },
  ): Promise<Result<Question, MetatorError>> {
    if (input.by.trim() === "")
      return err(MetatorError.usage("say who answers: --by <name>", "An answer records who gave it."));
    const file = this.questionFile(runId, id);
    if (!(await this.fs.exists(file))) return err(MetatorError.notFound(`question ${id} of run ${runId}`));
    const q = await this.load(file);
    if (q.isErr()) return err(q.error);
    if (q.value.answer) return err(MetatorError.usage(`question ${id} is already answered`));
    // A run that ended asks nothing any more: an answer now would change nothing (R3).
    const run = await this.repo.load(runId);
    if (run.isOk() && run.value.state.status !== "active")
      return err(
        MetatorError.usage(
          `run ${runId} is ${run.value.state.status}: question ${id} no longer waits for an answer`,
          run.value.state.status === "escalated"
            ? `Resume the run first: \`metator run resume --run ${runId} --by <name>\`.`
            : "Nothing is left to answer in this run.",
        ),
      );
    const labels = q.value.options.map((o) => o.label);
    const choices =
      input.choices.length === 0 && input.text ? [OTHER] : input.choices.map((c) => labelFor(labels, c));
    const unknown = choices.filter((c) => !labels.includes(c));
    if (choices.length === 0 || unknown.length > 0) {
      return err(
        MetatorError.usage(
          `choose from: ${labels.join(", ")}`,
          "Give --choice <label>, or --text for Other.",
        ),
      );
    }
    if (!q.value.multiSelect && choices.length > 1)
      return err(MetatorError.usage("this question takes one choice"));
    if (choices.includes(OTHER) && !input.text) return err(MetatorError.usage(`${OTHER} needs --text`));
    const answered: Question = {
      ...q.value,
      answer: {
        choices,
        ...(input.text ? { text: input.text } : {}),
        by: input.by,
        at: this.clock.now().toISOString(),
      },
    };
    return this.settle(answered, input.origin);
  }

  /**
   * A gate approved outside its question (`run approve <gate>`, R8): the stage's open gate
   * questions get that approval as their answer, so no card asks for a decision already made.
   */
  async settleGate(
    runId: string,
    stage: string,
    by: string,
  ): Promise<Result<readonly Question[], MetatorError>> {
    const all = await this.questions(runId);
    if (all.isErr()) return err(all.error);
    const out: Question[] = [];
    for (const q of all.value) {
      if (q.answer || q.stage !== stage || q.source !== "gate") continue;
      const settled = await this.settle({
        ...q,
        answer: { choices: ["Approve"], by, at: this.clock.now().toISOString() },
      });
      if (settled.isErr()) return err(settled.error);
      out.push(settled.value);
    }
    return ok(out);
  }

  private async settle(answered: Question, origin?: "inbox"): Promise<Result<Question, MetatorError>> {
    const a = answered.answer as QuestionAnswer;
    const saved = await this.save(answered);
    if (saved.isErr()) return err(saved.error);
    const logged = await this.record(answered.runId, {
      type: "answer",
      stage: answered.stage,
      text: `${answered.id}: ${a.choices.join(", ")}${a.text ? ` (${a.text})` : ""} · ${a.by}`,
      ...(origin ? { origin } : {}),
    });
    if (logged.isErr()) return err(logged.error);
    return ok(answered);
  }

  /**
   * Waits until the question has an answer; the answer comes from another process or this one.
   * Undefined when the run left the question's stage or ended meanwhile (an approval or an abort
   * from another terminal, R3 and R8): nobody will answer, and the caller looks at the run again.
   */
  async waitFor(
    runId: string,
    id: string,
    timer: Timer,
    pollMs: number,
  ): Promise<Result<QuestionAnswer | undefined, MetatorError>> {
    const file = this.questionFile(runId, id);
    for (;;) {
      const q = await this.load(file);
      if (q.isErr()) return err(q.error);
      if (q.value.answer) return ok(q.value.answer);
      const run = await this.repo.load(runId);
      if (run.isOk() && (run.value.state.status !== "active" || run.value.state.stage !== q.value.stage))
        return ok(undefined);
      await timer.sleep(pollMs);
    }
  }

  private async load(file: string): Promise<Result<Question, MetatorError>> {
    return loadDocument(this.fs, file, QuestionDocument, "json");
  }

  private save(q: Question): Promise<Result<void, MetatorError>> {
    return writeDocument(this.fs, this.questionFile(q.runId, q.id), QuestionDocument, q, "json");
  }
}
