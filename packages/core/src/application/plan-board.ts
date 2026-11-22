import { WorkerResultDocument } from "../domain/conductor.ts";
import type { MetatorError } from "../domain/errors.ts";
import { type GateReport, GateReportDocument } from "../domain/gate.ts";
import { planId } from "../domain/ids.ts";
import { PlanDocument } from "../domain/plan.ts";
import {
  type BoardSystemPlan,
  type BoardWorker,
  type PlanBoardView,
  planBoardOf,
  withLiveWorker,
} from "../domain/plan-board.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { RunRecord } from "../domain/run-record.ts";
import { parseJsonDocument } from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";
import type { Conductor } from "./conductor.ts";
import { parseDocumentText } from "./document-io.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";
import type { SystemPlans } from "./system-plan-edit.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

export interface PlanBoardDependencies {
  readonly fs: FileSystem;
  readonly repo: RunRepository;
  readonly journal: Pick<RunJournal, "questions" | "activity">;
  readonly catalog: Pick<WorkflowCatalog, "get">;
  readonly conductor: Pick<Conductor, "workers">;
  readonly paths: Pick<MetatorPaths, "gates">;
  /** System plans, for a run that carries one out (a system run, or a child run of one). */
  readonly systemPlans?: Pick<SystemPlans, "view">;
}

/**
 * The system plan a run carries out: a child run's names it; a system run's (a workflow whose
 * scripts work on `system plan`) is the plan of its task, as `metator system plan --run` finds it.
 */
export function systemPlanOf(
  record: Pick<RunRecord, "task" | "system">,
  owners: readonly string[],
): { readonly id: string; readonly step?: string } | undefined {
  if (record.system) return { id: record.system.plan, step: record.system.step };
  return owners.some((o) => o.includes("system plan")) ? { id: planId(record.task) } : undefined;
}

/** `metator run board`, `GET /runs/:id/board` (S2): the run's plan board, computed from its files. */
export class PlanBoard {
  constructor(private readonly d: PlanBoardDependencies) {}

  async execute(input: {
    readonly runId?: string;
    readonly timeline?: number;
  }): Promise<Result<PlanBoardView, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    const record = await this.d.repo.load(runId);
    if (record.isErr()) return err(record.error);
    const r = record.value;
    const spec = await this.d.catalog.get(r.workflow.id);
    const stages = spec.isOk()
      ? spec.value.spec.stages.map((s) => ({
          id: s.id,
          hitl: s.hitl,
          owners: ownersOf(s),
          produces: s.produces ?? [],
        }))
      : [{ id: r.state.stage, owners: [], produces: [] }];
    const dir = this.d.repo.runDir(runId);
    const files = (await this.d.fs.glob([`${dir}/*`, `${dir}/results/*.json`])).map((f) =>
      f.slice(dir.length + 1),
    );
    const planText = files.includes("plan.json") ? await this.d.fs.read(`${dir}/plan.json`) : undefined;
    const plan =
      planText?.isOk() === true
        ? parseJsonDocument(planText.value, `${dir}/plan.json`).andThen((raw) =>
            PlanDocument.parse(raw, "plan.json"),
          )
        : undefined;
    const results = [];
    for (const f of files.filter((x) => x.startsWith("results/"))) {
      const text = await this.d.fs.read(`${dir}/${f}`);
      if (text.isErr()) continue;
      const parsed = parseDocumentText(text.value, f, WorkerResultDocument, "json");
      if (parsed.isOk()) results.push(parsed.value);
    }
    const workers = await this.d.conductor.workers(runId);
    if (workers.isErr()) return err(workers.error);
    const boardWorkers: BoardWorker[] = workers.value.map((w) => ({
      name: w.name,
      stage: w.stage,
      agent: w.agent,
      paneId: w.paneId,
      alive: w.alive,
      state: w.alive ? (w.idle ? "idle" : "working") : "exited",
      ...(w.result
        ? { result: { status: w.result.status, summary: w.result.summary, at: w.result.at } }
        : {}),
    }));
    const questions = await this.d.journal.questions(runId);
    if (questions.isErr()) return err(questions.error);
    const activity = await this.d.journal.activity(runId);
    if (activity.isErr()) return err(activity.error);
    const gates: GateReport[] = [];
    for (const gate of ["quick", "full"] as const) {
      const file = `${this.d.paths.gates}/${gate}.json`;
      if (!(await this.d.fs.exists(file))) continue;
      const text = await this.d.fs.read(file);
      if (text.isErr()) continue;
      const parsed = parseDocumentText(text.value, file, GateReportDocument, "json");
      if (parsed.isOk()) gates.push(parsed.value);
    }
    const carried = systemPlanOf(
      r,
      stages.flatMap((s) => s.owners),
    );
    const systemView = carried && this.d.systemPlans ? await this.d.systemPlans.view(carried.id) : undefined;
    const system: BoardSystemPlan | undefined = systemView?.isOk()
      ? {
          id: systemView.value.plan.id,
          status: systemView.value.status,
          ...(systemView.value.approval ? { approval: systemView.value.approval } : {}),
          waves: systemView.value.waves,
          steps: systemView.value.steps,
          lint: systemView.value.lint,
          ...(carried?.step ? { step: carried.step } : {}),
        }
      : undefined;
    const board = planBoardOf({
      runId,
      task: r.task,
      workflow: r.workflow.id,
      status: r.state.status,
      stage: r.state.stage,
      history: r.state.context.history,
      stages,
      ...(plan?.isOk() ? { plan: plan.value } : {}),
      results,
      workers: boardWorkers,
      questions: questions.value,
      activity: activity.value,
      files,
      gates,
      resumes: r.resumes,
      ...(input.timeline ? { timelineLength: input.timeline } : {}),
      ...(system ? { system } : {}),
    });
    return ok(withLiveWorker(board));
  }
}

const ownersOf = (stage: { readonly owner?: unknown; readonly parallel?: unknown }): string[] => {
  const one = (o: unknown): string[] =>
    typeof o === "string" ? [o] : Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];
  return [...one(stage.owner), ...one(stage.parallel)];
};
