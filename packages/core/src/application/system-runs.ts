import { MetatorError } from "../domain/errors.ts";
import { progressOf } from "../domain/plan-progress.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { approvalHolds, readySteps, type SystemPlan, stepTask } from "../domain/system-plan.ts";
import type { Clock } from "../ports/index.ts";
import type { RunRepository } from "./run-repository.ts";
import type { InitRun } from "./runs.ts";
import type { SystemPlanStore } from "./system-plans.ts";
import type { LocatedSource, SystemSources } from "./system-sources.ts";

/** The workflow each step's child run follows: W1, a feature in that application's repository. */
export const STEP_WORKFLOW = "mt-feature";

/** Runs of a repository on this machine, through its own container (the runtime builds it). */
export interface RepositoryRuns {
  readonly init: Pick<InitRun, "execute">;
  readonly runs: Pick<RunRepository, "load">;
}

export interface StartedStep {
  readonly step: string;
  readonly app: string;
  /** The repository the child run is in. */
  readonly root: string;
  readonly run: string;
  readonly task: string;
}

/**
 * `system plan run` (F7.6, ADR-0071): the steps of an approved plan that can start, each as a
 * child run (W1) in its application's repository, linked to the system run as its parent. A step
 * runs only in a checkout a person works in (this repository or `system.roots`), never in a
 * clone; every ready step is located before any starts, so a wave starts whole or not at all.
 */
export class RunSystemPlan {
  constructor(
    private readonly store: SystemPlanStore,
    private readonly sources: Pick<SystemSources, "locate" | "location">,
    private readonly at: (root: string) => RepositoryRuns,
    private readonly clock: Clock,
    private readonly parents: Pick<RunRepository, "load" | "save" | "appendLog">,
  ) {}

  async execute(input: {
    readonly id: string;
    /** The system run (W13) the children belong to, in this repository. */
    readonly parent?: string;
    readonly base?: string;
    /** The workflow of the child runs (default W1, `mt-feature`). */
    readonly workflow?: string;
  }): Promise<Result<{ readonly plan: SystemPlan; readonly started: readonly StartedStep[] }, MetatorError>> {
    const loaded = await this.store.load(input.id);
    if (loaded.isErr()) return err(loaded.error);
    let plan = loaded.value;
    if (plan.status === "draft" || !plan.approval)
      return err(
        MetatorError.usage(
          `${plan.id} is not approved`,
          `A person approves it: \`metator system plan approve ${plan.id}\`.`,
        ),
      );
    if (!approvalHolds(plan))
      return err(
        MetatorError.usage(
          `the steps of ${plan.id} changed after ${plan.approval.by} approved them`,
          "Approve the plan again.",
        ),
      );
    const map = await this.sources.location.require();
    if (map.isErr()) return err(map.error);
    let parent = input.parent ? await this.parents.load(input.parent) : undefined;
    if (parent?.isErr()) return err(parent.error);

    const ready: { step: SystemPlan["steps"][number]; at: LocatedSource }[] = [];
    for (const step of readySteps(plan)) {
      const app = map.value.applications.find((a) => a.id === step.app);
      if (!app) return err(MetatorError.usage(`step ${step.id}: application ${step.app} is not in the map`));
      const located = await this.sources.locate(app);
      if (located.isErr()) return err(located.error);
      if (!located.value || located.value.via === "clone" || located.value.via === "map")
        return err(
          MetatorError.usage(
            `no checkout of ${app.id} to run step ${step.id} in`,
            `Clone it and set \`system.roots.${app.id}\` in metator.config.yml; clones in .metator/system are read-only.`,
          ),
        );
      ready.push({ step, at: located.value });
    }

    const started: StartedStep[] = [];
    for (const { step, at } of ready) {
      const task = stepTask(plan, step, at.dir);
      const run = await this.at(at.root).init.execute({
        workflow: input.workflow ?? STEP_WORKFLOW,
        task,
        ...(input.base ? { worktree: { base: input.base } } : {}),
        ...(input.parent ? { parent: input.parent } : {}),
        system: { plan: plan.id, step: step.id, app: step.app },
      });
      if (run.isErr()) return err(run.error);
      started.push({ step: step.id, app: step.app, root: at.root, run: run.value.runId, task });
      plan = {
        ...plan,
        status: "running",
        steps: plan.steps.map((s) =>
          s.id === step.id ? { ...s, status: "running", run: run.value.runId } : s,
        ),
      };
      const saved = await this.store.save(plan);
      if (saved.isErr()) return err(saved.error);
      if (parent?.isOk()) {
        const record = { ...parent.value, children: [...(parent.value.children ?? []), run.value.runId] };
        const kept = await this.parents.save(record);
        if (kept.isErr()) return err(kept.error);
        const logged = await this.parents.appendLog(
          record.runId,
          `${this.clock.now().toISOString()} · child · ${run.value.runId} (${step.id} in ${step.app})`,
        );
        if (logged.isErr()) return err(logged.error);
        parent = ok(record);
      }
    }
    return ok({ plan, started });
  }
}

export interface StepStatus {
  readonly id: string;
  readonly app: string;
  readonly status: SystemPlan["steps"][number]["status"];
  readonly run?: string;
  readonly runStatus?: string;
  readonly stage?: string;
  readonly root?: string;
}

/**
 * `system status` (F7.6): each step's child run read back from its repository (done, blocked when
 * escalated or aborted) and saved into the plan; the plan is done when every step is.
 */
export class SystemPlanStatus {
  constructor(
    private readonly store: SystemPlanStore,
    private readonly sources: Pick<SystemSources, "locate" | "location">,
    private readonly at: (root: string) => Pick<RepositoryRuns, "runs">,
  ) {}

  async execute(
    id: string,
  ): Promise<Result<{ readonly plan: SystemPlan; readonly steps: readonly StepStatus[] }, MetatorError>> {
    const loaded = await this.store.load(id);
    if (loaded.isErr()) return err(loaded.error);
    const map = await this.sources.location.require();
    if (map.isErr()) return err(map.error);
    const steps: StepStatus[] = [];
    const next: SystemPlan["steps"] = [];
    for (const step of loaded.value.steps) {
      const app = map.value.applications.find((a) => a.id === step.app);
      const located = app && step.run ? await this.sources.locate(app) : ok(undefined);
      if (located.isErr()) return err(located.error);
      if (!step.run || !located.value) {
        next.push(step);
        steps.push({
          id: step.id,
          app: step.app,
          status: step.status,
          ...(step.run ? { run: step.run } : {}),
        });
        continue;
      }
      const run = await this.at(located.value.root).runs.load(step.run);
      if (run.isErr()) return err(run.error);
      const status = progressOf(run.value.state.status, step.status);
      next.push({ ...step, status });
      steps.push({
        id: step.id,
        app: step.app,
        status,
        run: step.run,
        runStatus: run.value.state.status,
        stage: run.value.state.stage,
        root: located.value.root,
      });
    }
    const done = next.length > 0 && next.every((s) => s.status === "done");
    const plan: SystemPlan = { ...loaded.value, steps: next, ...(done ? { status: "done" as const } : {}) };
    const saved = await this.store.save(plan);
    return saved.isErr() ? err(saved.error) : ok({ plan, steps });
  }
}
