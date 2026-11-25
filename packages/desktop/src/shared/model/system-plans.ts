/**
 * System plans as the app reads them: which are shown, a run's plan, a step's place in wave order.
 */
import type { Attention, RunOverview, SystemPlanView } from "../api/api.ts";
import { sameRepo } from "./places.ts";
import { isFinished, type RunShown, runStateOf } from "./runs.ts";

/** The panel's order (spec §5.2): waits for you → working → stopped → escalated → finished. */
const ATTENTION_RANK: Record<Attention, number> = {
  you: 0,
  driving: 1,
  stopped: 2,
  escalated: 3,
  done: 4,
  aborted: 5,
};
export const byPanelOrder = <R extends Pick<RunOverview, "attention" | "updatedAt">>(
  runs: readonly R[],
): R[] =>
  [...runs].sort(
    (a, b) =>
      ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention] || b.updatedAt.localeCompare(a.updatedAt),
  );
export interface FeatureGroup<R extends RunOverview = RunOverview> {
  readonly parent: string;
  readonly steps: readonly R[];
  readonly done: number;
}
/** Runs grouped by their parent (a feature split into steps); the rest stand alone. */
export function groupByFeature<R extends RunOverview>(
  runs: readonly R[],
): {
  readonly groups: readonly FeatureGroup<R>[];
  readonly standalone: readonly R[];
} {
  const ids = new Set(runs.map((r) => r.runId));
  const byParent = new Map<string, R[]>();
  for (const r of runs)
    if (r.parent && ids.has(r.parent)) byParent.set(r.parent, [...(byParent.get(r.parent) ?? []), r]);
  // Alone: neither a step of a group here nor the parent of one.
  const standalone = runs.filter((r) => !(r.parent && ids.has(r.parent)) && !byParent.has(r.runId));
  const groups = [...byParent.entries()].map(([parent, steps]) => {
    const ordered = [...steps].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { parent, steps: ordered, done: ordered.filter((s) => s.status === "done").length };
  });
  return { groups, standalone };
}
/** The step label of a run in its feature group (`step 2/3`), when it is one. */
export function stepLabel(
  run: Pick<RunOverview, "runId" | "parent">,
  groups: readonly FeatureGroup<RunOverview>[],
): string | undefined {
  const g = run.parent ? groups.find((x) => x.parent === run.parent) : undefined;
  if (!g) return undefined;
  const i = g.steps.findIndex((s) => s.runId === run.runId);
  return i < 0 ? undefined : `step ${i + 1}/${g.steps.length}`;
}
/** A run as a row of the sidebar: under its parent when it is a step of a split run. */
export interface SidebarRun<R> {
  readonly run: R;
  /** A step of the run above it. */
  readonly nested: boolean;
  /** `step 2/3` (or `step 2` while the number of steps is not known), when it is one. */
  readonly step?: string | undefined;
  /** The repository of a step that lives in another repository than its parent. */
  readonly elsewhere?: string | undefined;
  /** A step listed in its own repository, away from its parent: the task it is a step of. */
  readonly partOf?:
    | { readonly runId: string; readonly repo?: string | undefined; readonly task: string }
    | undefined;
}
/**
 * Where a step stands in its parent's plan: its place among the parent's steps in the order they
 * started, out of the plan's number of steps. The number is the system plan's when it is known
 * (`planSteps`), else the parent's own list of children once every step exists; a count that
 * would only be the steps started so far is left out (`step 1`, never a wrong `step 1/1`).
 */
export function stepOf(
  step: Pick<RunOverview, "runId" | "createdAt">,
  siblings: readonly Pick<RunOverview, "runId" | "createdAt">[],
  parent: Pick<RunOverview, "children" | "status"> | undefined,
  planSteps?: number | undefined,
  place?: StepPlace | undefined,
): string {
  // The step's own place in its system plan wins: the second step is step 2 whatever started first.
  if (place) return `step ${place.at}/${place.of}`;
  const ordered = [...siblings].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const i = ordered.findIndex((s) => s.runId === step.runId);
  const at = i < 0 ? ordered.length + 1 : i + 1;
  const known = parent?.children?.length ?? 0;
  const of =
    planSteps !== undefined && planSteps >= at
      ? planSteps
      : parent && isFinished(parent) && known >= at
        ? known
        : undefined;
  return of === undefined ? `step ${at}` : `step ${at}/${of}`;
}
/**
 * The step chip of a decision card. The daemon counts the parent's children started so far, so a
 * system run's first child reads `1 of 1`; the system plan's step count wins when it is known, and
 * with neither a plan nor a finished parent the total is left out.
 */
export function groupStepText(
  group: { readonly step: number; readonly of: number },
  planSteps: number | undefined,
  parentFinished: boolean,
  place?: StepPlace | undefined,
): string {
  if (place) return `step ${place.at} of ${place.of}`;
  if (planSteps !== undefined && planSteps >= group.step) return `step ${group.step} of ${planSteps}`;
  return parentFinished ? `step ${group.step} of ${group.of}` : `step ${group.step}`;
}
/**
 * The runs of one repository as the sidebar lists them: in the panel's order (who needs a person
 * first), each run that was split followed by its steps in the order they started, whatever
 * repository a step lives in (a system plan's steps are runs of other repositories). A step whose
 * parent is listed is not listed again in its own repository. `all` is every run the sidebar can
 * nest from; `planSteps` the number of steps of a parent's system plan, when it is known.
 */
export function sidebarRuns<R extends RunOverview & { readonly repo?: string | undefined }>(
  runs: readonly R[],
  all: readonly R[] = runs,
  planSteps: (parent: R) => number | undefined = () => undefined,
  placeOf: (step: R) => StepPlace | undefined = () => undefined,
): SidebarRun<R>[] {
  // Every run is listed in its own repository: a step of the same repository sits under its
  // parent; a step of a task of another repository is a row of its own here, saying whose step it is.
  const here = new Set(runs.map((r) => r.runId));
  const parentOf = (r: R) => (r.parent ? all.find((p) => p.runId === r.parent) : undefined);
  const nestedHere = (r: R) => {
    const p = parentOf(r);
    return p !== undefined && here.has(p.runId) && sameRepo(p.repo, r.repo);
  };
  const out: SidebarRun<R>[] = [];
  for (const run of byPanelOrder(runs.filter((r) => !nestedHere(r)))) {
    const p = parentOf(run);
    if (p) {
      const siblings = all
        .filter((r) => r.parent === p.runId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      out.push({
        run,
        nested: false,
        step: stepOf(run, siblings, p, planSteps(p), placeOf(run)),
        partOf: { runId: p.runId, repo: p.repo, task: p.task },
      });
    } else out.push({ run, nested: false });
    const steps = runs
      .filter((r) => r.parent === run.runId && sameRepo(r.repo, run.repo))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const siblings = all
      .filter((r) => r.parent === run.runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const step of steps)
      out.push({ run: step, nested: true, step: stepOf(step, siblings, run, planSteps(run), placeOf(step)) });
  }
  return out;
}
/** A system plan's view with the repository it was read from (in a folder), and when it last changed. */
export type RepoSystemPlan = SystemPlanView & {
  readonly repo?: string | undefined;
  readonly updatedAt?: string | null | undefined;
};
/** The system plans the app reads in full: the open ones, and the ones done in the last `keepMs`. */
export const plansShown = <P extends { readonly status: string; readonly updatedAt: string | null }>(
  plans: readonly P[],
  now: number,
  keepMs = 24 * 60 * 60 * 1000,
): P[] =>
  plans.filter(
    (p) => p.status !== "done" || (p.updatedAt !== null && now - Date.parse(p.updatedAt) <= keepMs),
  );
/**
 * The system plan a run carries out, as its parent: the plan the daemon names for it (its id, from
 * the run's task), else the plan one of whose steps is a child of the run, else the plan with the
 * run's task.
 */
export function systemPlanOf<P extends Pick<SystemPlanView, "steps" | "plan">>(
  plans: readonly P[],
  run: Pick<RunOverview, "runId" | "task" | "children" | "systemPlan">,
  runs: readonly Pick<RunOverview, "runId" | "parent">[],
): P | undefined {
  const children = new Set([
    ...(run.children ?? []),
    ...runs.filter((r) => r.parent === run.runId).map((r) => r.runId),
  ]);
  return (
    // The plan the run carries out, by its id (the planner words the plan's task its own way).
    (run.systemPlan !== undefined ? plans.find((p) => p.plan.id === run.systemPlan) : undefined) ??
    plans.find((p) => p.steps.some((s) => s.run !== undefined && children.has(s.run))) ??
    plans.find((p) => p.plan.task === run.task)
  );
}
/** Where a step stands in its system plan: its place in the deploy order, out of every step. */
export interface StepPlace {
  readonly at: number;
  readonly of: number;
}
/**
 * The steps of a system plan in the order they deploy: wave by wave, then any step no wave names
 * (a plan whose steps depend on each other in a circle has no waves at all).
 */
export function planOrder(plan: Pick<SystemPlanView, "waves" | "steps">): string[] {
  const order = plan.waves.flatMap((w) => w.steps);
  const seen = new Set(order);
  return [...order, ...plan.steps.map((s) => s.id).filter((id) => !seen.has(id))];
}
/** The place of the step a run carries out, in the system plan that started it; none for another run. */
export function stepPlace(
  plans: readonly Pick<SystemPlanView, "waves" | "steps">[],
  runId: string,
): StepPlace | undefined {
  for (const plan of plans) {
    const step = plan.steps.find((s) => s.run === runId);
    if (!step) continue;
    const order = planOrder(plan);
    return { at: order.indexOf(step.id) + 1, of: order.length };
  }
  return undefined;
}
/** A system run in one line: how far its plan is, and what it waits for. */
export interface SystemRunSummary {
  readonly planId: string;
  readonly done: number;
  readonly total: number;
  /** The child run a person must act on before the system run goes on (it asks, or it stopped). */
  readonly blocker?: {
    readonly runId: string;
    readonly repo?: string | undefined;
    readonly task: string;
    readonly state: RunShown;
  };
  /** What the run waits for, in words: the gate's own line when the daemon wrote one. */
  readonly waiting?: string | undefined;
}
/**
 * The summary on a system run's page: steps done of all, and the first child in deploy order that
 * waits for a person (`blocked by <child>: needs you`); else what the gate said last
 * (`waiting on children: …`).
 */
export function systemRunSummary<R extends RunOverview & { readonly repo?: string | undefined }>(
  plan: Pick<SystemPlanView, "steps" | "waves" | "plan">,
  run: Pick<RunOverview, "last">,
  runs: readonly R[],
): SystemRunSummary {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  let blocker: SystemRunSummary["blocker"];
  for (const id of planOrder(plan)) {
    const step = byId.get(id);
    const child = step?.run ? runs.find((r) => r.runId === step.run) : undefined;
    if (!child) continue;
    const state = runStateOf(child);
    if (state === "needs you" || state === "escalated" || state === "aborted") {
      blocker = { runId: child.runId, repo: child.repo, task: child.task, state };
      break;
    }
  }
  const said = run.last?.text?.replace(/^gate:\s*/, "");
  return {
    planId: plan.plan.id,
    done: plan.steps.filter((s) => s.status === "done").length,
    total: plan.steps.length,
    ...(blocker ? { blocker } : {}),
    ...(!blocker && said && /waiting|blocked|wave|step/.test(said) ? { waiting: said } : {}),
  };
}
