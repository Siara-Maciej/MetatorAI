import { MetatorError } from "../domain/errors.ts";
import { digestOf } from "../domain/ids.ts";
import {
  changeSummary,
  documentDigest,
  documentFromBody,
  editLogOf,
  fieldChanges,
  itemChanges,
  type PlanEdit,
  PlanEditDocument,
  type PlanLintProblem,
  type PlanLintView,
  type SystemPlanStepView,
  type SystemPlanSummary,
  type SystemPlanView,
  staleDigest,
} from "../domain/plan-edit.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { appDir } from "../domain/system-map.ts";
import {
  approvalHolds,
  type SystemPlan,
  SystemPlanDocument,
  type SystemPlanProblem,
  systemPlanDigest,
  systemPlanWaves,
} from "../domain/system-plan.ts";
import { serializeJsonLine } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { readJsonLines } from "./document-io.ts";
import type { ApproveSystemPlan, LintSystemPlan, SystemPlanStore } from "./system-plans.ts";
import type { RepositoryRuns } from "./system-runs.ts";
import type { SystemSources } from "./system-sources.ts";

export interface SystemPlansDependencies {
  readonly fs: FileSystem;
  readonly store: Pick<SystemPlanStore, "list" | "load" | "save" | "file" | "exists">;
  readonly lint: Pick<LintSystemPlan, "check">;
  readonly approve: Pick<ApproveSystemPlan, "execute">;
  readonly sources: Pick<SystemSources, "locate" | "location">;
  /** The runs of the repository at a root: where a step's child run is read back. */
  readonly at: (root: string) => Pick<RepositoryRuns, "runs">;
  readonly clock: Clock;
}

export interface SaveSystemPlanInput {
  readonly plan: unknown;
  readonly digest: string;
  readonly by: string;
  readonly note?: string;
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

/** The fields of a step a person may not change once it has a child run: everything it is. */
const frozen = (s: SystemPlan["steps"][number]) => digestOf(s);

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

  async save(id: string, input: SaveSystemPlanInput): Promise<Result<SystemPlanView, MetatorError>> {
    const by = input.by.trim();
    if (by === "") return err(MetatorError.usage("say who changes the plan: by"));
    const current = await this.d.store.load(id);
    if (current.isErr()) return err(current.error);
    const before = current.value;
    if (input.digest !== documentDigest(before)) {
      const view = await this.viewOf(before);
      return err(
        new MetatorError("CONFLICT", staleDigest(`system plan ${id}`), {
          hint: "Reload the plan; your change is not saved.",
          details: { current: view.isOk() ? view.value : null },
        }),
      );
    }
    if (before.status === "done")
      return err(new MetatorError("TRANSITION_DENIED", `system plan ${id} is done: it cannot be changed`));
    const file = this.d.store.file(id);
    const parsed = documentFromBody(SystemPlanDocument, input.plan, file);
    if (!parsed.ok) return err(invalid(parsed.problems));
    if (parsed.value.id !== id)
      return err(
        invalid([{ severity: "error", field: "id", message: `the plan is ${id}, not ${parsed.value.id}` }]),
      );
    // What a step's run made of it is the plan's, not the editor's: a step with a run stays as it is.
    const now = new Map(parsed.value.steps.map((s) => [s.id, s]));
    for (const s of before.steps.filter((x) => x.run)) {
      const edited = now.get(s.id);
      if (!edited || frozen({ ...edited, status: s.status, run: s.run }) !== frozen(s))
        return err(
          new MetatorError(
            "TRANSITION_DENIED",
            `step ${s.id} of system plan ${id} already has a run (${s.run}): it cannot be ${edited ? "changed" : "removed"}`,
            {
              hint: "Add a new step instead; the run of this one is in its repository.",
              details: { step: s.id },
            },
          ),
        );
    }
    const was = new Map(before.steps.map((s) => [s.id, s]));
    // Progress is read back from the runs, never typed: a step keeps its status and run, a new one is pending.
    const steps = parsed.value.steps.map((s) => {
      const old = was.get(s.id);
      const { run: _run, ...rest } = s;
      return old
        ? { ...rest, status: old.status, ...(old.run ? { run: old.run } : {}) }
        : { ...rest, status: "pending" as const };
    });
    // Status and approval are the plan's own: a person approves with `approve`, never by editing.
    const { approval: _given, ...edited } = parsed.value;
    const content: SystemPlan = {
      ...edited,
      steps,
      status: before.status,
      ...(before.approval ? { approval: before.approval } : {}),
    };
    // An approval covers exactly what was approved: a change to it sends the plan back to draft.
    const covered = before.approval !== undefined && before.approval.digest === systemPlanDigest(before);
    const unapproved = covered && systemPlanDigest(content) !== systemPlanDigest(before);
    const plan: SystemPlan = unapproved ? withoutApproval(content) : content;
    const changes = [
      ...fieldChanges(before, plan, ["task", "strategies"]),
      ...itemChanges("step", before.steps, plan.steps),
      ...(unapproved ? [`approval by ${before.approval?.by} dropped: the plan is a draft again`] : []),
    ];
    const saved = await this.d.store.save(plan);
    if (saved.isErr()) return err(saved.error);
    const entry: PlanEdit = {
      at: this.d.clock.now().toISOString(),
      by,
      target: "system-plan",
      id,
      before: input.digest,
      after: documentDigest(plan),
      changes: changes.length > 0 ? changes : [changeSummary(changes)],
      ...(unapproved && before.approval
        ? { unapproved: { by: before.approval.by, at: before.approval.at } }
        : {}),
      ...(input.note ? { note: input.note } : {}),
    };
    const logged = await this.d.fs.append(editLogOf(file), serializeJsonLine(PlanEditDocument.stamp(entry)));
    if (logged.isErr()) return err(logged.error);
    return this.viewOf(plan);
  }

  /** A person approves the plan as it is (`ApproveSystemPlan`: lint must be clean); then its view. */
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

  private async viewOf(plan: SystemPlan): Promise<Result<SystemPlanView, MetatorError>> {
    const linted = await this.d.lint.check(plan);
    const lint = linted.isOk()
      ? systemLintView(linted.value.problems)
      : { problems: [{ severity: "error" as const, message: linted.error.message }] };
    const map = await this.d.sources.location.load();
    const apps = map.isOk() && map.value ? map.value.applications : [];
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
      steps.push({
        id: s.id,
        app: s.app,
        repo,
        task: s.summary,
        dependsOn: s.dependsOn,
        status: s.status,
        ...(s.run ? { run: s.run } : {}),
        ...(runState ? { runState: runState.status, runStage: runState.stage } : {}),
      });
    }
    const waves = (systemPlanWaves(plan) ?? []).map((ids, i) => ({ wave: i + 1, steps: ids }));
    return ok({
      plan,
      digest: documentDigest(plan),
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

function withoutApproval(plan: SystemPlan): SystemPlan {
  const { approval: _, ...rest } = plan;
  return { ...rest, status: "draft" };
}

const latest = (times: readonly (string | undefined)[]): string | null =>
  times
    .filter((t): t is string => t !== undefined)
    .sort()
    .at(-1) ?? null;

const invalid = (problems: readonly PlanLintProblem[]) =>
  new MetatorError(
    "USAGE",
    `the plan does not fit its schema: ${problems.map((p) => (p.field ? `${p.field}: ${p.message}` : p.message)).join("; ")}`,
    { hint: "Nothing was saved.", details: { problems } },
  );
