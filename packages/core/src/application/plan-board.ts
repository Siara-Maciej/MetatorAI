import { WorkerResultDocument } from "../domain/conductor.ts";
import type { MetatorError } from "../domain/errors.ts";
import { type GateReport, GateReportDocument } from "../domain/gate.ts";
import { PlanDocument } from "../domain/plan.ts";
import { type BoardWorker, type PlanBoardView, planBoardOf, withLiveWorker } from "../domain/plan-board.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument } from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";
import type { Conductor } from "./conductor.ts";
import type { RunJournal } from "./drive.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

export interface PlanBoardDependencies {
  readonly fs: FileSystem;
  readonly repo: RunRepository;
  readonly journal: Pick<RunJournal, "questions" | "activity">;
  readonly catalog: Pick<WorkflowCatalog, "get">;
  readonly conductor: Pick<Conductor, "workers">;
  readonly paths: Pick<MetatorPaths, "gates">;
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
      const parsed = parseJsonDocument(text.value, f).andThen((raw) => WorkerResultDocument.parse(raw, f));
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
      const parsed = parseJsonDocument(text.value, file).andThen((raw) =>
        GateReportDocument.parse(raw, file),
      );
      if (parsed.isOk()) gates.push(parsed.value);
    }
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
      ...(input.timeline ? { timelineLength: input.timeline } : {}),
    });
    return ok(withLiveWorker(board));
  }
}

const ownersOf = (stage: { readonly owner?: unknown; readonly parallel?: unknown }): string[] => {
  const one = (o: unknown): string[] =>
    typeof o === "string" ? [o] : Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];
  return [...one(stage.owner), ...one(stage.parallel)];
};
