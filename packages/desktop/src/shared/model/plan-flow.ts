/**
 * A decomposed task drawn as a flow (pure, tested): the system plan's steps as nodes, one column
 * per wave of the deploy order, one lane per repository, an arrow for each `dependsOn` (from the
 * step depended on to the one that waits), the parent task as a header node on the left with an
 * arrow into every step that waits for nothing. A step that has not started is a node too
 * (dashed), with what it waits for; the longest chain of steps is the critical path.
 */
import type { RunOverview, SystemPlanView } from "../api/api.ts";
import { type RunShown, runStateOf } from "./runs.ts";
import { planOrder } from "./system-plans.ts";

export const FLOW = {
  /** A step's node. */
  W: 236,
  H: 58,
  /** The task's node, on the left. */
  TASK_W: 180,
  COL_GAP: 52,
  ROW_GAP: 12,
  LANE_TOP: 22,
  LANE_BOTTOM: 12,
  LANE_GAP: 10,
  LEFT: 12,
  TOP: 26,
} as const;

/** What a step reads as: its child run's state, or `pending` while it has none. */
type FlowState = RunShown | "pending";

export interface FlowNode {
  readonly id: string;
  readonly kind: "task" | "step";
  readonly label: string;
  /** The application (a step), or the plan's status (the task). */
  readonly sub: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly state: FlowState;
  /** The child run's stage, when it has one. */
  readonly stage?: string | undefined;
  readonly repo?: string | undefined;
  readonly runId?: string | undefined;
  /** The steps it still waits for (not done yet), for a step that has not started. */
  readonly waitsFor: readonly string[];
  readonly critical: boolean;
}

interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly d: string;
  readonly critical: boolean;
  /** The step it leaves is done: the arrow is no longer a wait. */
  readonly met: boolean;
}

export interface PlanFlowLayout {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly lanes: readonly { readonly name: string; readonly y: number; readonly h: number }[];
  readonly columns: readonly { readonly label: string; readonly x: number }[];
  readonly width: number;
  readonly height: number;
  /** The widths it was drawn with: narrower than FLOW's in a narrow box. */
  readonly stepW: number;
  readonly taskW: number;
  readonly colGap: number;
}

/** The narrowest a step's node gets before the flow scrolls instead. */
export const MIN_STEP_W = 132;

/**
 * The widths a flow of `columns` waves is drawn with in a box `fit` wide: FLOW's own when they fit;
 * else the task's node, the gaps and the steps shrink together (never below MIN_STEP_W, past which
 * the box scrolls).
 */
export function flowWidths(columns: number, fit?: number): { stepW: number; taskW: number; colGap: number } {
  const full = { stepW: FLOW.W, taskW: FLOW.TASK_W, colGap: FLOW.COL_GAP };
  const need = (w: typeof full) => 2 * FLOW.LEFT + w.taskW + columns * (w.colGap + w.stepW);
  if (fit === undefined || need(full) <= fit) return full;
  const taskW = 140;
  const colGap = 34;
  const stepW = Math.floor((fit - 2 * FLOW.LEFT - taskW - columns * colGap) / columns);
  return { stepW: Math.max(MIN_STEP_W, Math.min(FLOW.W, stepW)), taskW, colGap };
}

/** A repository as a person names it: the last part of its path. */
export const repoLabel = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

/** A child run's status (from the plan's view) as a state word, when the run is not in the list. */
function stateOfStatus(status: string | undefined, stepStatus: string): FlowState {
  if (status === "done" || stepStatus === "done") return "done";
  if (status === "planned") return "plan ready";
  if (status === "aborted") return "aborted";
  if (status === "escalated" || stepStatus === "blocked") return "escalated";
  if (status === "active" || stepStatus === "running") return "working";
  return "pending";
}

/**
 * The critical path: the steps on a longest chain (by count) through the plan, every chain of
 * that length together (the owner's three steps of wave 1 all lead into the integration), by
 * level from the first step to the last. Steps that wait for nothing, alone, have none.
 */
export function criticalPath(plan: Pick<SystemPlanView, "steps" | "waves">): {
  readonly steps: readonly string[];
  readonly levels: readonly (readonly string[])[];
  /** The chains' length, in steps. */
  readonly length: number;
  /** Whether the edge `from → to` lies on the path. */
  on(from: string, to: string): boolean;
} {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const deps = (id: string) => (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
  const after = (id: string) => plan.steps.filter((s) => s.dependsOn.includes(id)).map((s) => s.id);
  const memo = (next: (id: string) => string[]) => {
    const m = new Map<string, number>();
    const f = (id: string, seen: Set<string>): number => {
      const known = m.get(id);
      if (known !== undefined) return known;
      if (seen.has(id)) return 1;
      seen.add(id);
      const n = 1 + Math.max(0, ...next(id).map((d) => f(d, seen)));
      seen.delete(id);
      m.set(id, n);
      return n;
    };
    return (id: string) => f(id, new Set());
  };
  // depth: the longest chain that ends at a step; height: the longest that starts there.
  const depth = memo(deps);
  const height = memo(after);
  const order = planOrder(plan);
  const length = Math.max(0, ...order.map((id) => depth(id)));
  const steps = length > 1 ? order.filter((id) => depth(id) + height(id) - 1 === length) : [];
  const on = new Set(steps);
  const levels = Array.from({ length: steps.length > 0 ? length : 0 }, (_, i) =>
    steps.filter((id) => depth(id) === i + 1),
  );
  return {
    steps,
    levels,
    length: steps.length > 0 ? length : 0,
    on: (from, to) => on.has(from) && on.has(to) && depth(to) === depth(from) + 1,
  };
}

/** The column of each step: its wave (1-based), or after the last wave for a step no wave names. */
function columnsOf(plan: Pick<SystemPlanView, "steps" | "waves">): Map<string, number> {
  const col = new Map<string, number>();
  plan.waves.forEach((w, i) => {
    for (const id of w.steps) col.set(id, i + 1);
  });
  const after = plan.waves.length + 1;
  for (const s of plan.steps) if (!col.has(s.id)) col.set(s.id, after);
  return col;
}

/**
 * The flow of a system plan, laid out. `runs` are the runs the app knows (the child runs are
 * found among them by the step's `run`; a run not listed reads its state from the plan's view).
 */
export function planFlow(
  view: Pick<SystemPlanView, "plan" | "steps" | "waves" | "status">,
  runs: readonly (Pick<RunOverview, "runId" | "status" | "attention" | "stage"> & {
    readonly repo?: string | undefined;
  })[],
  /** The width of the box it is drawn in: the nodes narrow to fit it. */
  fit?: number,
): PlanFlowLayout {
  const col = columnsOf(view);
  const columns = Math.max(1, ...[...col.values()]);
  const { stepW, taskW, colGap } = flowWidths(columns, fit);
  const order = planOrder(view);
  // Lanes in the order their first step deploys.
  const lanes: string[] = [];
  for (const id of order) {
    const step = view.steps.find((s) => s.id === id);
    const lane = step ? repoLabel(step.repo || step.app) : undefined;
    if (lane && !lanes.includes(lane)) lanes.push(lane);
  }
  // A lane is as tall as its busiest column: two steps of one repository in one wave stack.
  const rows = new Map<string, number>();
  const rowOf = new Map<string, number>();
  for (const id of order) {
    const step = view.steps.find((s) => s.id === id);
    if (!step) continue;
    const key = `${repoLabel(step.repo || step.app)}#${col.get(id)}`;
    const n = rows.get(key) ?? 0;
    rowOf.set(id, n);
    rows.set(key, n + 1);
  }
  const laneRows = lanes.map((lane) =>
    Math.max(1, ...[...rows.entries()].filter(([k]) => k.startsWith(`${lane}#`)).map(([, n]) => n)),
  );
  const laneBoxes: { name: string; y: number; h: number }[] = [];
  let y = FLOW.TOP;
  lanes.forEach((name, i) => {
    const n = laneRows[i] ?? 1;
    const h = FLOW.LANE_TOP + n * FLOW.H + (n - 1) * FLOW.ROW_GAP + FLOW.LANE_BOTTOM;
    laneBoxes.push({ name, y, h });
    y += h + FLOW.LANE_GAP;
  });
  const height = Math.max(y - FLOW.LANE_GAP + FLOW.TOP / 2, FLOW.TOP + FLOW.H + 20);
  const colX = (c: number) => FLOW.LEFT + taskW + colGap + (c - 1) * (stepW + colGap);
  const width = colX(columns) + stepW + FLOW.LEFT;
  const chain = criticalPath(view);
  const critical = new Set(chain.steps);
  const done = new Set(view.steps.filter((s) => s.status === "done").map((s) => s.id));
  const nodes: FlowNode[] = [];
  const taskY = Math.max(FLOW.TOP, (height - FLOW.H) / 2);
  nodes.push({
    id: "@task",
    kind: "task",
    label: view.plan.task,
    sub: `system plan · ${view.status}`,
    x: FLOW.LEFT,
    y: taskY,
    w: taskW,
    h: FLOW.H,
    state: view.status === "done" ? "done" : view.status === "draft" ? "pending" : "working",
    waitsFor: [],
    critical: false,
  });
  for (const id of order) {
    const step = view.steps.find((s) => s.id === id);
    if (!step) continue;
    const lane = laneBoxes[lanes.indexOf(repoLabel(step.repo || step.app))];
    const run = step.run ? runs.find((r) => r.runId === step.run) : undefined;
    const state: FlowState = run ? runStateOf(run) : stateOfStatus(step.runState, step.status);
    const stage = run?.stage ?? step.runStage;
    nodes.push({
      id,
      kind: "step",
      label: id,
      sub: step.app,
      x: colX(col.get(id) ?? 1),
      y: (lane?.y ?? FLOW.TOP) + FLOW.LANE_TOP + (rowOf.get(id) ?? 0) * (FLOW.H + FLOW.ROW_GAP),
      w: stepW,
      h: FLOW.H,
      state: state === "pending" && step.run ? "idle" : state,
      ...(stage && state !== "done" ? { stage } : {}),
      repo: lane?.name,
      ...(step.run ? { runId: step.run } : {}),
      waitsFor: step.run ? [] : step.dependsOn.filter((d) => !done.has(d)),
      critical: critical.has(id),
    });
  }
  const at = new Map(nodes.map((n) => [n.id, n]));
  const edges: FlowEdge[] = [];
  const path = (a: FlowNode, b: FlowNode) => {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    if (x2 <= x1) {
      // The same column (a step no wave names): around the right side.
      const x = Math.max(a.x + a.w, b.x + b.w) + 16;
      return `M ${x1} ${y1} C ${x} ${y1}, ${x} ${y2}, ${b.x + b.w} ${y2}`;
    }
    const bend = (x2 - x1) / 2;
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  };
  const task = at.get("@task") as FlowNode;
  for (const step of view.steps) {
    const b = at.get(step.id);
    if (!b) continue;
    const deps = step.dependsOn.filter((d) => at.has(d));
    if (deps.length === 0)
      edges.push({
        from: "@task",
        to: step.id,
        d: path(task, b),
        critical: critical.has(step.id) && chain.levels[0]?.includes(step.id) === true,
        met: false,
      });
    for (const dep of deps) {
      const a = at.get(dep) as FlowNode;
      edges.push({
        from: dep,
        to: step.id,
        d: path(a, b),
        critical: chain.on(dep, step.id),
        met: done.has(dep),
      });
    }
  }
  return {
    nodes,
    edges,
    lanes: laneBoxes,
    columns: Array.from({ length: columns }, (_, i) => ({
      label: i < view.waves.length ? `wave ${i + 1}` : "not in a wave",
      x: colX(i + 1),
    })),
    width,
    height,
    stepW,
    taskW,
    colGap,
  };
}

/** The words a pending step's node says: what it waits for, or that it can start. */
export const waitsText = (n: Pick<FlowNode, "waitsFor" | "state">): string | undefined =>
  n.state !== "pending"
    ? undefined
    : n.waitsFor.length > 0
      ? `waits for: ${n.waitsFor.join(", ")}`
      : "can start";
