/**
 * The phase of a piece of work on the board (Kanban): computed once, here, from a run's workflow
 * and the stage it is at, so no front guesses it from stage names. A task that has no run yet is
 * `todo` (a backlog task, an agent's proposal, a system plan step not started); a run is in one
 * of the other four.
 */

export const WORK_PHASES = ["todo", "planning", "in-progress", "review", "done"] as const;
export type WorkPhase = (typeof WORK_PHASES)[number];

/** A stage as the phase reads it: its id, whether it is a human gate, whether it has a gate check. */
export interface PhaseStage {
  readonly id: string;
  readonly hitl?: boolean | undefined;
}

/** Stages that understand the task and decide how to do it, the plan's own gates included. */
const PLANNING =
  /(^|-)(plan|planning|analy[sz]e|analysis|intake|context|setup|triage|grill|research|metadata|shard|rules|baseline|spec|design)(-|$)/;
/** Stages that look at what was made: reviews, checks, gates, delivery and publishing. */
const REVIEW =
  /(^|-)(review|reviews|gates?|checks?|verify|judge|find|delivery|deliver|publish|release|learn|retro)(-|$)/;

/** What one stage of a workflow is, read from its id; `undefined` for a stage the words do not name. */
function stagePhase(stage: PhaseStage): Exclude<WorkPhase, "todo" | "done"> | undefined {
  if (PLANNING.test(stage.id)) return "planning";
  if (REVIEW.test(stage.id)) return "review";
  return undefined;
}

/**
 * The phase of a run at `stage` of its workflow. A finished run (done or aborted) is `done`;
 * an escalated run keeps the phase of the stage it stopped at (the board marks it escalated).
 * A stage the words name is in their phase (`plan`, `plan-gate`, `plan-approval` → planning;
 * `review`, `gates`, `checks`, `delivery`, `publish` → review). Any other stage is in progress,
 * except a human gate (`approval`) with no name of its own: it closes the phase of the stage
 * before it, so an approval right after planning is still planning and one after the work is
 * review. A stage the workflow does not declare (an old run) is in progress.
 */
export function workPhase(
  stages: readonly PhaseStage[],
  stage: string,
  status: string,
): Exclude<WorkPhase, "todo"> {
  // A run that stopped at its approved plan is finished too (ADR-0096).
  if (status === "done" || status === "aborted" || status === "planned") return "done";
  const at = stages.findIndex((s) => s.id === stage);
  const current = at >= 0 ? stages[at] : undefined;
  if (!current) {
    const named = stagePhase({ id: stage });
    return named ?? "in-progress";
  }
  const named = stagePhase(current);
  if (named) return named;
  if (current.hitl) {
    // A bare approval: the phase of the work it approves (the stage before it), planning or review.
    const before = at > 0 ? stages[at - 1] : undefined;
    const prior = before ? (stagePhase(before) ?? (before.hitl ? undefined : "in-progress")) : undefined;
    return prior === "planning" ? "planning" : "review";
  }
  return "in-progress";
}
