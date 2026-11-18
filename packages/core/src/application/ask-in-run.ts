import type { Question, QuestionAnswer } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Timer } from "../ports/index.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

export interface AskInRunInput {
  readonly runId?: string;
  readonly prompt: string;
  /** The choices offered; "Other" (own words) is always added. */
  readonly options: readonly string[];
  /** Who asks (a worker's name, the conductor's agent). */
  readonly agent?: string;
  readonly multiSelect?: boolean;
  /** Block until the person answers (or the run moves on, or the timeout passes). */
  readonly wait?: boolean;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export interface AskedInRun {
  readonly question: Question;
  /** The person's answer, once there is one (with `wait`). */
  readonly answer?: QuestionAnswer;
}

/** How long `--wait` waits by default before it says there is no answer yet (30 min). */
export const ASK_WAIT_MS = 30 * 60_000;

/**
 * `metator run ask` (an agent in a terminal asks the person): the question is the run's, at its
 * stage, so it reaches every front (the inbox card, `run questions`, a notification) exactly as a
 * driven agent's would; `--wait` blocks until the answer is recorded, wherever it was given.
 */
export class AskInRun {
  constructor(
    private readonly repo: Pick<RunRepository, "resolveId" | "load">,
    private readonly journal: Pick<RunJournal, "ask" | "questions">,
    private readonly timer: Timer,
  ) {}

  async execute(input: AskInRunInput): Promise<Result<AskedInRun, MetatorError>> {
    if (input.prompt.trim() === "") return err(MetatorError.usage("say what you ask"));
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    if (record.value.state.status !== "active")
      return err(MetatorError.usage(`run ${id.value} is ${record.value.state.status}: nobody will answer`));
    const asked = await this.journal.ask(id.value, {
      stage: record.value.state.stage,
      source: "agent",
      ...(input.agent ? { agent: input.agent } : {}),
      prompt: input.prompt.trim(),
      options: input.options.map((label) => ({ label })),
      multiSelect: input.multiSelect ?? false,
    });
    if (asked.isErr()) return err(asked.error);
    if (!input.wait) return ok({ question: asked.value });
    return this.wait({
      runId: id.value,
      question: asked.value.id,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
    });
  }

  /** Waits for the answer of a question already asked; it ends when the run leaves its stage. */
  async wait(input: {
    readonly runId?: string;
    readonly question: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
  }): Promise<Result<AskedInRun, MetatorError>> {
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    const timeout = input.timeoutMs ?? ASK_WAIT_MS;
    const every = input.pollMs ?? 500;
    for (let waited = 0; ; waited += every) {
      const all = await this.journal.questions(runId);
      if (all.isErr()) return err(all.error);
      const q = all.value.find((x) => x.id === input.question);
      if (!q) return err(MetatorError.notFound(`question ${input.question} of run ${runId}`));
      if (q.answer) return ok({ question: q, answer: q.answer });
      const record = await this.repo.load(runId);
      if (record.isErr()) return err(record.error);
      if (record.value.state.status !== "active" || record.value.state.stage !== q.stage)
        return err(
          new MetatorError("CONFLICT", `the run left ${q.stage} while ${q.id} waited: nobody will answer it`),
        );
      if (waited >= timeout)
        return err(
          new MetatorError("WAITING", `${q.id} has no answer after ${Math.round(waited / 1000)} s`, {
            hint: `Wait again: \`metator run ask --question ${q.id} --wait --run ${runId}\`.`,
          }),
        );
      await this.timer.sleep(every);
    }
  }
}
