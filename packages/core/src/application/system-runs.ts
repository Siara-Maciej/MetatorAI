import { stageWork } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { planId } from "../domain/ids.ts";
import { progressOf, requireApproved, settled } from "../domain/plan-progress.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type SystemGate, systemGate } from "../domain/system-gate.ts";
import { readySteps, type SystemPlan, stepTask, systemPlanDigest } from "../domain/system-plan.ts";
import type { Clock } from "../ports/index.ts";
import type { StartRun } from "./run-operations.ts";
import type { RunRepository } from "./run-repository.ts";
import type { GateApprovals } from "./runs.ts";
import type { ApproveSystemPlan, LintSystemPlan, SystemPlanStore } from "./system-plans.ts";
import type { LocatedSource, SystemSources } from "./system-sources.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

/** The workflow each step's child run follows: W1, a feature in that application's repository. */
export const STEP_WORKFLOW = "mt-feature";

/** Runs of a repository on this machine, through its own container (the runtime builds it). */
export interface RepositoryRuns {
  /** A run started as every front starts one: its worktree set up, and driven when asked. */
  readonly start: Pick<StartRun, "execute">;
  readonly runs: Pick<RunRepository, "load">;
}

export interface StartedStep {
  readonly step: string;
  readonly app: string;
  /** The repository the child run is in. */
  readonly root: string;
  readonly run: string;
  readonly task: string;
  /** Its drive: started on the parent's host (else the repository's default host). */
  readonly drive?: { readonly stage: string; readonly started: boolean; readonly host?: string };
  /** Why it could not be driven: the run waits for a person to start it. */
  readonly driveError?: string;
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
    private readonly parents: Pick<RunRepository, "load" | "update" | "appendLog">,
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
    const approved = requireApproved(
      loaded.value,
      systemPlanDigest(loaded.value),
      "steps",
      `A person approves it: \`metator system plan approve ${loaded.value.id}\`.`,
    );
    if (approved.isErr()) return err(approved.error);
    let plan: SystemPlan = approved.value;
    const map = await this.sources.location.require();
    if (map.isErr()) return err(map.error);
    // The parent must be there before any step starts; its record is changed under its lock later.
    const parent = input.parent ? await this.parents.load(input.parent) : undefined;
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
      // Started and driven at once, on the host the system run itself uses: nobody has to open a
      // session for each child, and a worktree gets its dependencies first.
      const host = parent?.isOk() ? parent.value.host : undefined;
      const created = await this.at(at.root).start.execute({
        workflow: input.workflow ?? STEP_WORKFLOW,
        task,
        ...(input.base ? { worktree: { base: input.base } } : {}),
        ...(input.parent ? { parent: input.parent } : {}),
        system: { plan: plan.id, step: step.id, app: step.app },
        drive: host ? { host } : {},
      });
      if (created.isErr()) return err(created.error);
      const run = { value: created.value.run };
      started.push({
        step: step.id,
        app: step.app,
        root: at.root,
        run: run.value.runId,
        task,
        ...(created.value.drive ? { drive: created.value.drive } : {}),
        ...(created.value.driveError ? { driveError: created.value.driveError.message } : {}),
      });
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
        // Read, change and write as one step: the parent's own drive may change it meanwhile (R5).
        const kept = await this.parents.update(parent.value.runId, (record) =>
          ok({ ...record, children: [...(record.children ?? []), run.value.runId] }),
        );
        if (kept.isErr()) return err(kept.error);
        const logged = await this.parents.appendLog(
          parent.value.runId,
          `${this.clock.now().toISOString()} · child · ${run.value.runId} (${step.id} in ${step.app})`,
        );
        if (logged.isErr()) return err(logged.error);
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
    const done = settled(next);
    const plan: SystemPlan = { ...loaded.value, steps: next, ...(done ? { status: "done" as const } : {}) };
    const saved = await this.store.save(plan);
    return saved.isErr() ? err(saved.error) : ok({ plan, steps });
  }
}

/** How long a system run waits on its children before it escalates (6 h), unless its gate says. */
export const SYSTEM_GATE_TIMEOUT_MS = 6 * 3_600_000;

/**
 * The W13 gate (`system plan status --run <run> --gate`): the children read back, then what they
 * say about going on (`systemGate`). How long the run has waited is counted from its last change:
 * the moment it reached this gate.
 */
export class SystemRunGate {
  constructor(
    private readonly status: Pick<SystemPlanStatus, "execute">,
    private readonly runs: Pick<RunRepository, "load">,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly id: string;
    readonly run?: string;
    readonly timeoutMs?: number;
  }): Promise<Result<SystemGate & { readonly steps: readonly StepStatus[] }, MetatorError>> {
    const read = await this.status.execute(input.id);
    if (read.isErr()) return err(read.error);
    const parent = input.run ? await this.runs.load(input.run) : undefined;
    if (parent?.isErr()) return err(parent.error);
    const since = parent?.isOk() ? new Date(parent.value.updatedAt).getTime() : this.clock.now().getTime();
    const gate = systemGate({
      steps: read.value.steps,
      ready: readySteps(read.value.plan).map((s) => s.id),
      waitedMs: Math.max(0, this.clock.now().getTime() - since),
      timeoutMs: input.timeoutMs ?? SYSTEM_GATE_TIMEOUT_MS,
    });
    return ok({ ...gate, steps: read.value.steps });
  }
}

/**
 * A system run's plan-approval approves its system plan (F7.5): one Approve, on the card or with
 * `run approve`, approves the gate and the plan by the same person, with the plan as it is now.
 * The gate is the human gate right before the stage that starts the children; the plan is the
 * run's own (its id comes from the task). A plan whose lint has errors refuses the approval.
 */
export class SystemPlanApprovals implements GateApprovals {
  constructor(
    private readonly runs: Pick<RunRepository, "load">,
    private readonly catalog: Pick<WorkflowCatalog, "get">,
    private readonly store: Pick<SystemPlanStore, "exists">,
    private readonly lint: Pick<LintSystemPlan, "execute">,
    private readonly approveSystemPlan: Pick<ApproveSystemPlan, "execute">,
  ) {}

  async refusal(runId: string, stage: string): Promise<Result<MetatorError | undefined, MetatorError>> {
    const id = await this.planOf(runId, stage);
    if (!id) return ok(undefined);
    const linted = await this.lint.execute(id);
    if (linted.isErr()) return err(linted.error);
    // A stale approval is exactly what approving again fixes.
    const errors = linted.value.problems.filter((p) => p.severity === "error" && p.code !== "stale-approval");
    if (errors.length === 0) return ok(undefined);
    return ok(
      new MetatorError(
        "CHECK_FAILED",
        `the system plan ${id} has ${errors.length} lint error${errors.length === 1 ? "" : "s"}: ${errors.map((e) => e.message).join("; ")}`,
        {
          hint: `Fix the plan (\`metator system plan lint ${id}\` lists the problems), then approve again.`,
          details: { problems: linted.value.problems },
        },
      ),
    );
  }

  async approve(runId: string, stage: string, by: string): Promise<Result<unknown, MetatorError>> {
    const id = await this.planOf(runId, stage);
    if (!id) return ok(undefined);
    return this.approveSystemPlan.execute({ id, by });
  }

  /** The system plan this gate approves: the run's own plan, when the gate lets its steps start. */
  private async planOf(runId: string, stage: string): Promise<string | undefined> {
    const record = await this.runs.load(runId);
    if (record.isErr()) return undefined;
    const entry = await this.catalog.get(record.value.workflow.id);
    if (entry.isErr()) return undefined;
    const stages = entry.value.spec.stages;
    const at = stages.findIndex((s) => s.id === stage);
    const next = stages[at + 1];
    if (at < 0 || !stages[at]?.hitl || !next) return undefined;
    if (!stageWork(next).scripts.some((s) => /\bsystem plan run\b/.test(s))) return undefined;
    const id = planId(record.value.task);
    return (await this.store.exists(id)) ? id : undefined;
  }
}
