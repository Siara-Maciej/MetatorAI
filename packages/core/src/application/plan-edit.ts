import { MetatorError } from "../domain/errors.ts";
import { type Plan, PlanDocument, type PlanLint } from "../domain/plan.ts";
import {
  changeSummary,
  documentDigest,
  documentFromBody,
  fieldChanges,
  itemChanges,
  type PlanLintProblem,
  type PlanLintView,
  type RunPlanView,
  staleDigest,
} from "../domain/plan-edit.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { RunRecord } from "../domain/run-record.ts";
import type { StageSpec } from "../domain/workflow-spec.ts";
import type { FileSystem } from "../ports/index.ts";
import { readDocument, writeDocument } from "./document-io.ts";
import type { LintPlan, ScopePlan } from "./plans.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";
import type { GateApprovals } from "./runs.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

/** The run's implementation plan, in its run directory. */
export const RUN_PLAN_FILE = "plan.json";

export interface RunPlansDependencies {
  readonly fs: FileSystem;
  readonly repo: Pick<RunRepository, "resolveId" | "load" | "runDir">;
  readonly journal: Pick<RunJournal, "record" | "questions">;
  readonly catalog: Pick<WorkflowCatalog, "get">;
  readonly lint: Pick<LintPlan, "check">;
  /** Writes the edit scope next to the plan again, when the run has one (`plan-scope.json`). */
  readonly scope: Pick<ScopePlan, "execute">;
}

export interface SaveRunPlanInput {
  readonly plan: unknown;
  /** The digest of the plan the edit is based on; null when the run has no plan yet. */
  readonly digest: string | null;
  readonly by: string;
  readonly note?: string;
}

/** Problems of the plan's lint as the app lists them. */
export const lintView = (lint: PlanLint): PlanLintView => ({
  problems: lint.problems.map((p) => ({
    severity: p.severity,
    message: p.message,
    ...(p.step ? { step: p.step } : {}),
  })),
});

/**
 * Where the plan freezes: the first stage that writes `plan.json`, and the first person's gate
 * (`hitl`) after it, whose approval covers the plan. Undefined when no stage writes a plan.
 */
export function planStages(
  stages: readonly Pick<StageSpec, "id" | "hitl" | "produces">[],
): { readonly plan: number; readonly approval?: number } | undefined {
  const plan = stages.findIndex((s) => (s.produces ?? []).includes(RUN_PLAN_FILE));
  if (plan < 0) return undefined;
  const approval = stages.findIndex((s, i) => i > plan && s.hitl === true);
  return approval < 0 ? { plan } : { plan, approval };
}

/**
 * Why a person may not change the run's plan now, or undefined when they may: the run is over,
 * or it passed the gate that approved the plan (an escalated run before that gate still may).
 */
export function planReadOnlyBecause(
  record: Pick<RunRecord, "state" | "workflow">,
  stages: readonly Pick<StageSpec, "id" | "hitl" | "produces">[],
): string | undefined {
  const where = planStages(stages);
  if (!where)
    return `the workflow ${record.workflow.id} has no implementation plan: no stage writes ${RUN_PLAN_FILE}`;
  const { status, stage } = record.state;
  if (status === "done" || status === "aborted") return `the run is ${status}`;
  const at = stages.findIndex((s) => s.id === stage);
  const last = where.approval ?? where.plan;
  if (at > last) {
    const gate = stages[last]?.id ?? "";
    return where.approval !== undefined
      ? `the run passed ${gate}, where a person approved the plan, and is at ${stage}: the plan is what was approved`
      : `the run is at ${stage}, past ${gate}, which wrote the plan`;
  }
  return undefined;
}

/**
 * The run's implementation plan in the app (`GET`/`PUT /runs/:run/plan`, ADR-0087): read, linted
 * as `plan lint` lints it, and changed by a person until the gate that approves it. A write names
 * the digest it was based on (a stale one is CONFLICT), is checked against the plan's schema
 * (nothing invalid is written), and is recorded in the run's activity with what changed.
 */
export class RunPlans {
  constructor(private readonly d: RunPlansDependencies) {}

  async view(runId: string | undefined): Promise<Result<RunPlanView, MetatorError>> {
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const record = await this.d.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const file = this.file(id.value);
    const plan = await readDocument(this.d.fs, file, PlanDocument, "json");
    if (plan.isErr()) return err(plan.error);
    return this.viewOf(record.value, plan.value ?? null);
  }

  /** The lint of a plan as given, without writing it: schema problems name their field. */
  async lint(runId: string | undefined, raw: unknown): Promise<Result<PlanLintView, MetatorError>> {
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const parsed = documentFromBody(PlanDocument, raw, this.file(id.value));
    if (!parsed.ok) return ok({ problems: parsed.problems });
    return (await this.d.lint.check(parsed.value)).map(lintView);
  }

  async save(runId: string | undefined, input: SaveRunPlanInput): Promise<Result<RunPlanView, MetatorError>> {
    const by = input.by.trim();
    if (by === "") return err(MetatorError.usage("say who changes the plan: by"));
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const record = await this.d.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const file = this.file(id.value);
    const current = await readDocument(this.d.fs, file, PlanDocument, "json");
    if (current.isErr()) return err(current.error);
    const before = current.value ?? null;
    const now = before ? documentDigest(before) : null;
    if (input.digest !== now) {
      const view = await this.viewOf(record.value, before);
      return err(
        new MetatorError("CONFLICT", staleDigest(`the plan of run ${id.value}`), {
          hint: "Reload the plan; your change is not saved.",
          details: { current: view.isOk() ? view.value : null },
        }),
      );
    }
    const stages = await this.stagesOf(record.value);
    const refused = planReadOnlyBecause(record.value, stages);
    if (refused)
      return err(
        new MetatorError("TRANSITION_DENIED", `the plan of run ${id.value} cannot be changed: ${refused}`),
      );
    const parsed = documentFromBody(PlanDocument, input.plan, file);
    if (!parsed.ok)
      return err(
        new MetatorError(
          "USAGE",
          `the plan does not fit its schema: ${parsed.problems.map(describe).join("; ")}`,
          { hint: "Nothing was saved.", details: { problems: parsed.problems } },
        ),
      );
    const plan = parsed.value;
    const changes = before
      ? [...fieldChanges(before, plan, ["task", "scope"]), ...itemChanges("step", before.steps, plan.steps)]
      : [`plan written with ${plan.steps.length} step(s)`];
    const saved = await writeDocument(this.d.fs, file, PlanDocument, plan, "json");
    if (saved.isErr()) return err(saved.error);
    // The edit scope the hooks enforce follows the plan it was made from.
    if (await this.d.fs.exists(`${this.d.repo.runDir(id.value)}/plan-scope.json`)) {
      const scoped = await this.d.scope.execute({ file });
      if (scoped.isErr()) return err(scoped.error);
    }
    const noted = await this.d.journal.record(id.value, {
      type: "plan-edited",
      stage: record.value.state.stage,
      text: `plan edited by ${by}: ${changeSummary(changes)}${input.note ? ` (${input.note})` : ""}`,
      origin: "run",
    });
    if (noted.isErr()) return err(noted.error);
    return this.viewOf(record.value, plan);
  }

  private file(runId: string): string {
    return `${this.d.repo.runDir(runId)}/${RUN_PLAN_FILE}`;
  }

  private async stagesOf(record: RunRecord): Promise<readonly StageSpec[]> {
    const spec = await this.d.catalog.get(record.workflow.id);
    return spec.isOk() ? spec.value.spec.stages : [];
  }

  private async viewOf(record: RunRecord, plan: Plan | null): Promise<Result<RunPlanView, MetatorError>> {
    const stages = await this.stagesOf(record);
    const lint = plan ? await this.d.lint.check(plan) : ok<PlanLint, MetatorError>(noPlan());
    if (lint.isErr()) return err(lint.error);
    const refused = planReadOnlyBecause(record, stages);
    const where = planStages(stages);
    const approvalStage = where?.approval === undefined ? undefined : stages[where.approval]?.id;
    const questions = await this.d.journal.questions(record.runId);
    if (questions.isErr()) return err(questions.error);
    const question = approvalStage
      ? questions.value.find((q) => q.stage === approvalStage && q.source === "gate" && !q.answer)
      : undefined;
    return ok({
      plan,
      digest: plan ? documentDigest(plan) : null,
      lint: lintView(lint.value),
      editable: refused === undefined,
      ...(refused ? { readOnlyBecause: refused } : {}),
      stage: record.state.stage,
      artifactsOfWorkflow: [...new Set(stages.flatMap((s) => s.produces ?? []))],
      file: this.file(record.runId),
      ...(approvalStage ? { approvalStage } : {}),
      ...(question ? { question: question.id } : {}),
    });
  }
}

const noPlan = (): PlanLint => ({ steps: 0, problems: [], adrRequired: [] });

const describe = (p: PlanLintProblem): string => (p.field ? `${p.field}: ${p.message}` : p.message);

export type RunPlanApprovalsDependencies = Pick<RunPlansDependencies, "fs" | "repo" | "catalog" | "lint">;

/**
 * The gate that approves a run's plan (the first person's gate after the stage that writes
 * `plan.json`) refuses Approve while the plan has lint errors: approving it would freeze a plan
 * its own lint says is wrong. The rule every front reads (the card's Approve says why it cannot).
 */
export class RunPlanApprovals implements GateApprovals {
  constructor(private readonly d: RunPlanApprovalsDependencies) {}

  async refusal(runId: string, stage: string): Promise<Result<MetatorError | undefined, MetatorError>> {
    const record = await this.d.repo.load(runId);
    if (record.isErr()) return ok(undefined);
    const spec = await this.d.catalog.get(record.value.workflow.id);
    if (spec.isErr()) return ok(undefined);
    const stages = spec.value.spec.stages;
    const where = planStages(stages);
    if (where?.approval === undefined || stages[where.approval]?.id !== stage) return ok(undefined);
    const plan = await readDocument(
      this.d.fs,
      `${this.d.repo.runDir(runId)}/${RUN_PLAN_FILE}`,
      PlanDocument,
      "json",
    );
    if (plan.isErr() || !plan.value) return ok(undefined);
    const lint = await this.d.lint.check(plan.value);
    if (lint.isErr()) return err(lint.error);
    const errors = lint.value.problems.filter((p) => p.severity === "error");
    if (errors.length === 0) return ok(undefined);
    return ok(
      new MetatorError(
        "CHECK_FAILED",
        `the plan of run ${runId} has ${errors.length} lint error${errors.length === 1 ? "" : "s"}: ${errors
          .map((e) => (e.step ? `${e.step}: ${e.message}` : e.message))
          .join("; ")}`,
        {
          hint: `Fix the plan (its Plan tab, or \`metator plan lint ${this.d.repo.runDir(runId)}/${RUN_PLAN_FILE}\`), then approve.`,
          details: { problems: lintView(lint.value).problems },
        },
      ),
    );
  }

  /** Nothing to do beyond the gate's own approval: the plan is what the gate approves. */
  async approve(_runId: string, _stage: string, _by: string): Promise<Result<unknown, MetatorError>> {
    return ok(undefined);
  }
}
