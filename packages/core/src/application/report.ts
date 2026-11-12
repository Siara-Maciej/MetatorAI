import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type FleetReport, fleetReport, type RunFacts } from "../domain/telemetry.ts";
import type { Clock } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { RunRepository } from "./run-repository.ts";

/**
 * `metator report` (P6): what the runs cost (tokens, money, agent time), what they asked of
 * people (questions, waiting, answers a policy gave), how often gates sent them back, per agent.
 */
export class BuildReport {
  constructor(
    private readonly runs: RunRepository,
    private readonly journal: Pick<RunJournal, "questions" | "usage">,
    private readonly clock: Clock,
  ) {}

  /** The facts of every run started at or after `since` (default: every run). */
  async facts(since?: string): Promise<Result<readonly RunFacts[], MetatorError>> {
    const out: RunFacts[] = [];
    // A run whose record cannot be read has no facts; `metator status` names it.
    for (const r of (await this.runs.loadAll()).runs) {
      const runId = r.runId;
      if (since && r.createdAt < since) continue;
      const questions = await this.journal.questions(runId);
      if (questions.isErr()) return err(questions.error);
      const usage = await this.journal.usage(runId);
      if (usage.isErr()) return err(usage.error);
      out.push({
        runId,
        workflow: r.workflow.id,
        status: r.state.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        history: r.state.context.history,
        questions: questions.value,
        usage: usage.value,
      });
    }
    return ok(out);
  }

  async execute(since?: string): Promise<Result<FleetReport, MetatorError>> {
    const facts = await this.facts(since);
    return facts.map((f) => fleetReport(f, this.clock.now()));
  }
}
