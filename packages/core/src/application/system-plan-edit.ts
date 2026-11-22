import { MetatorError } from "../domain/errors.ts";
import { PlanDocument } from "../domain/plan.ts";
import {
  documentDigest,
  documentFromBody,
  editLogOf,
  fieldChanges,
  itemChanges,
  type PlanEdit,
  PlanEditDocument,
  type PlanLintView,
  PlanRevisionDocument,
  previousOf,
  type SystemPlanStepView,
  type SystemPlanSummary,
  type SystemPlanView,
} from "../domain/plan-edit.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { appDir } from "../domain/system-map.ts";
import {
  approvalHolds,
  type SystemPlan,
  SystemPlanDocument,
  type SystemPlanProblem,
  systemPlanWaves,
} from "../domain/system-plan.ts";
import { parseJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { readDocument, readJsonLines } from "./document-io.ts";
import type { ApproveSystemPlan, LintSystemPlan, SystemPlanStore } from "./system-plans.ts";
import type { RepositoryRuns } from "./system-runs.ts";
import type { SystemSources } from "./system-sources.ts";

export interface SystemPlansDependencies {
  readonly fs: FileSystem;
  readonly store: Pick<SystemPlanStore, "list" | "load" | "save" | "file" | "exists" | "loadAnalysis">;
  readonly lint: Pick<LintSystemPlan, "check">;
  readonly approve: Pick<ApproveSystemPlan, "execute">;
  readonly sources: Pick<SystemSources, "locate" | "location">;
  /** The runs of the repository at a root: where a step's child run is read back. */
  readonly at: (root: string) => Pick<RepositoryRuns, "runs">;
  readonly clock: Clock;
}

/** A system plan's problems as the app lists them (`stale-approval` is the code approving again fixes). */
export const systemLintView = (problems: readonly SystemPlanProblem[]): PlanLintView => ({
  problems: problems.map((p) => ({
    severity: p.severity,
    message: p.message,
    ...(p.code ? { code: p.code } : {}),
    ...(p.step ? { step: p.step } : {}),
  })),
});

/**
 * System plans in the app (`/system/plans`, ADR-0087): listed, shown with their lint, waves and
 * the child runs of their steps, changed by a person, approved. A change of what an approval
 * covers sends an approved plan back to draft; a step that already has a child run stays as it
 * is; every change is a line of the plan's edit log (`<id>.edits.jsonl`) with who made it.
 */
export class SystemPlans {
  constructor(private readonly d: SystemPlansDependencies) {}

  async list(): Promise<Result<readonly SystemPlanSummary[], MetatorError>> {
    const plans = await this.d.store.list();
    if (plans.isErr()) return err(plans.error);
    const out: SystemPlanSummary[] = [];
    for (const plan of plans.value) {
      const edits = await this.edits(plan.id);
      out.push({
        id: plan.id,
        task: plan.task,
        status: plan.status,
        steps: plan.steps.length,
        done: plan.steps.filter((s) => s.status === "done").length,
        ...(plan.approval
          ? { approval: { by: plan.approval.by, at: plan.approval.at, stale: !approvalHolds(plan) } }
          : {}),
        updatedAt: latest([edits.at(-1)?.at, plan.approval?.at]),
      });
    }
    return ok(out);
  }

  async view(id: string): Promise<Result<SystemPlanView, MetatorError>> {
    const plan = await this.d.store.load(id);
    if (plan.isErr()) return err(plan.error);
    return this.viewOf(plan.value);
  }

  /** The lint of a plan as given, without writing it: schema problems name their field. */
  async lint(id: string, raw: unknown): Promise<Result<PlanLintView, MetatorError>> {
    const parsed = documentFromBody(SystemPlanDocument, raw, this.d.store.file(id));
    if (!parsed.ok) return ok({ problems: parsed.problems });
    if (parsed.value.id !== id)
      return ok({
        problems: [{ severity: "error", field: "id", message: `the plan is ${id}, not ${parsed.value.id}` }],
      });
    return (await this.d.lint.check(parsed.value)).map((l) => systemLintView(l.problems));
  }

  async approve(id: string, by: string): Promise<Result<SystemPlanView, MetatorError>> {
    if (by.trim() === "") return err(MetatorError.usage("say who approves: by"));
    const approved = await this.d.approve.execute({ id, by: by.trim() });
    if (approved.isErr()) return err(approved.error);
    return this.viewOf(approved.value);
  }

  /** The plan's edits, the oldest first (empty before the first). */
  async edits(id: string): Promise<readonly PlanEdit[]> {
    const log = await readJsonLines(this.d.fs, editLogOf(this.d.store.file(id)), PlanEditDocument, "skip");
    return log.isOk() ? log.value : [];
  }

  /** The version its planner replaced and what changed since, when the plan is not that version. */
  private async previous(
    plan: SystemPlan,
  ): Promise<{ previous: NonNullable<SystemPlanView["previous"]>; changes: string[] } | undefined> {
    const kept = await readDocument(
      this.d.fs,
      previousOf(this.d.store.file(plan.id)),
      PlanRevisionDocument,
      "json",
    );
    if (kept.isErr() || !kept.value || kept.value.digest === documentDigest(plan)) return undefined;
    const before = SystemPlanDocument.parse(
      SystemPlanDocument.stamp(kept.value.plan as SystemPlan),
      "previous",
    );
    if (before.isErr()) return undefined;
    return {
      previous: { plan: before.value, digest: kept.value.digest, at: kept.value.at },
      changes: [
        ...fieldChanges(before.value, plan, ["task", "strategies"]),
        ...itemChanges("step", before.value.steps, plan.steps),
      ],
    };
  }

  /** A step's plan run in its application's repository: where it is, and its plan once written. */
  private async planRunOf(root: string, runId: string): Promise<SystemPlanStepView["planRun"]> {
    const runs = this.d.at(root).runs;
    const run = await runs.load(runId);
    if (run.isErr()) return undefined;
    const text = await runs.readFile(runId, "plan.json");
    const steps = planStepsOf(text.isOk() ? text.value : undefined);
    return {
      runId,
      status: run.value.state.status,
      stage: run.value.state.stage,
      root,
      ...(steps ? { steps } : {}),
    };
  }

  private async viewOf(plan: SystemPlan): Promise<Result<SystemPlanView, MetatorError>> {
    const linted = await this.d.lint.check(plan);
    const lint = linted.isOk()
      ? systemLintView(linted.value.problems)
      : { problems: [{ severity: "error" as const, message: linted.error.message }] };
    const map = await this.d.sources.location.load();
    const apps = map.isOk() && map.value ? map.value.applications : [];
    const analysis = await this.d.store.loadAnalysis(plan.id);
    const filesOf = (app: string) => {
      const files = analysis.isOk()
        ? analysis.value?.applications.find((a) => a.id === app)?.files
        : undefined;
      return files && files.length > 0 ? files : undefined;
    };
    const steps: SystemPlanStepView[] = [];
    for (const s of plan.steps) {
      const app = apps.find((a) => a.id === s.app);
      const located = app ? await this.d.sources.locate(app) : undefined;
      const root = located?.isOk() ? located.value?.root : undefined;
      const repo = root ?? (app ? ("repo" in app.source ? app.source.repo : appDir(app)) : s.app);
      let runState: { status: string; stage: string } | undefined;
      if (s.run && root) {
        const run = await this.d.at(root).runs.load(s.run);
        if (run.isOk()) runState = { status: run.value.state.status, stage: run.value.state.stage };
      }
      const files = filesOf(s.app);
      const planRun = s.planRunId && root ? await this.planRunOf(root, s.planRunId) : undefined;
      steps.push({
        id: s.id,
        app: s.app,
        repo,
        task: s.summary,
        dependsOn: s.dependsOn,
        status: s.status,
        ...(s.run ? { run: s.run } : {}),
        ...(runState ? { runState: runState.status, runStage: runState.stage } : {}),
        summary: s.summary,
        contracts: s.contracts,
        ...(files ? { files } : {}),
        ...(s.planRunId ? { planRunId: s.planRunId } : {}),
        ...(planRun ? { planRun } : {}),
      });
    }
    const waves = (systemPlanWaves(plan) ?? []).map((ids, i) => ({ wave: i + 1, steps: ids }));
    const previous = await this.previous(plan);
    return ok({
      plan,
      digest: documentDigest(plan),
      ...(previous ? { previous: previous.previous, changes: previous.changes } : {}),
      status: plan.status,
      lint,
      ...(plan.approval ? { approval: { ...plan.approval, stale: !approvalHolds(plan) } } : {}),
      waves,
      steps,
      editable: plan.status !== "done",
      ...(plan.status === "done" ? { readOnlyBecause: "the plan is done: every step's run is" } : {}),
      file: this.d.store.file(plan.id),
    });
  }
}

/** The plan's steps of a run, when it wrote a plan.json that reads. */
function planStepsOf(text: string | undefined): NonNullable<SystemPlanStepView["planRun"]>["steps"] {
  if (!text) return undefined;
  const plan = parseJsonDocument(text, "plan.json").andThen((raw) => PlanDocument.parse(raw, "plan.json"));
  return plan.isOk()
    ? plan.value.steps.map((s) => ({ id: s.id, action: s.action, path: s.path, intent: s.intent }))
    : undefined;
}

const latest = (times: readonly (string | undefined)[]): string | null =>
  times
    .filter((t): t is string => t !== undefined)
    .sort()
    .at(-1) ?? null;
