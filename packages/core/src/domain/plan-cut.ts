import type { PlanFromStage, RunState } from "./run-record.ts";
import { type PhaseStage, workPhase } from "./work-phase.ts";

/**
 * Where a workflow's plan ends (ADR-0096): the stage that writes `plan.json`, the stage right
 * after it (the plan's review: lint, critic, the person's approval) and the first stage past
 * planning (`build`). A run `--until plan` stops at that last one as `planned`; a run with
 * `--plan-from` starts there (or at the review, when the plan is stale).
 */
export interface PlanCut {
  readonly plan: string;
  readonly review: string;
  readonly build: string;
}

export interface CutStage extends PhaseStage {
  readonly produces?: readonly string[] | undefined;
}

/** The plan's stages, or undefined for a workflow that has no plan or nothing after it. */
export function planCut(spec: { readonly stages: readonly CutStage[] }): PlanCut | undefined {
  const { stages } = spec;
  const byFile = stages.findIndex((s) => s.produces?.includes("plan.json"));
  const at = byFile >= 0 ? byFile : stages.findIndex((s) => s.id === "plan");
  const review = stages[at + 1];
  if (at < 0 || !review) return undefined;
  const build = stages.slice(at + 1).find((s) => workPhase(stages, s.id, "active") !== "planning");
  if (!build) return undefined;
  return { plan: (stages[at] as CutStage).id, review: review.id, build: build.id };
}

/** A run `--until plan` that reached the first stage past its plan: it stops there, planned. */
export function stopAtPlan(state: RunState, cut: PlanCut): RunState {
  if (state.status !== "active" || state.stage !== cut.build) return state;
  return { ...state, stage: "planned", status: "planned" };
}

/**
 * The first state of a run that takes an earlier run's plan: at `build`, or at the plan's review;
 * every stage before it is in the history as passed, "plan from <run>".
 */
export function planFromState(
  workflow: string,
  stages: readonly CutStage[],
  cut: PlanCut,
  from: PlanFromStage,
  run: string,
): RunState {
  const start = from === "build" ? cut.build : cut.review;
  const before = stages.slice(
    0,
    stages.findIndex((s) => s.id === start),
  );
  return {
    workflow,
    stage: start,
    status: "active",
    context: {
      loops: {},
      history: before.map((s) => ({ stage: s.id, event: "PASS" as const, detail: `plan from ${run}` })),
    },
  };
}

/**
 * Whether a run's plan was approved: it is `planned`, or it got past the last planning stage
 * (the person's approval, or that gate skipped at the run's autonomy).
 */
export function planApproved(state: RunState, stages: readonly CutStage[], cut: PlanCut): boolean {
  if (state.status === "planned") return true;
  const last = stages[stages.findIndex((s) => s.id === cut.build) - 1];
  return state.context.history.some(
    (h) => h.stage === last?.id && (h.event === "APPROVE" || h.event === "PASS"),
  );
}

/** The files a run that starts at `start` takes from the plan's run: what the stages before it write, and the task. */
export function planFiles(stages: readonly CutStage[], start: string): string[] {
  const before = stages.slice(
    0,
    stages.findIndex((s) => s.id === start),
  );
  return [...new Set(["task.md", ...before.flatMap((s) => s.produces ?? [])])];
}
