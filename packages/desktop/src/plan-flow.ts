/**
 * A decomposed task drawn as a flow (pure, tested): the system plan's steps as nodes, one column
 * per wave of the deploy order, one lane per repository, an arrow for each `dependsOn` (from the
 * step depended on to the one that waits), the parent task as a header node on the left with an
 * arrow into every step that waits for nothing. A step that has not started is a node too
 * (dashed), with what it waits for; the longest chain of steps is the critical path.
 */
import type { RunOverview, SystemPlanView } from "./api.ts";
import { planOrder, type RunShown, runStateOf } from "./model.ts";

export const FLOW = {
  /** A step's node. */
  W: 210,
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
export type FlowState = RunShown | "pending";

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

export interface FlowEdge {
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
}

/** A repository as a person names it: the last part of its path. */
export const repoLabel = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

/** A child run's status (from the plan's view) as a state word, when the run is not in the list. */
function stateOfStatus(status: string | undefined, stepStatus: string): FlowState {
  if (status === "done" || stepStatus === "done") return "done";
  if (status === "aborted") return "aborted";
  if (status === "escalated" || stepStatus === "blocked") return "escalated";
  if (status === "active" || stepStatus === "running") return "working";
  return "pending";
}

/**
 * The longest chain of steps (by count) through the plan: the steps the task's end waits on
 * longest. Ties go to the chain met first in the deploy order.
 */
export function criticalPath(plan: Pick<SystemPlanView, "steps" | "waves">): string[] {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const memo = new Map<string, string[]>();
  const longest = (id: string, seen: Set<string>): string[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (seen.has(id)) return [id];
    seen.add(id);
    const step = byId.get(id);
    let best: string[] = [];
    for (const dep of step?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const chain = longest(dep, seen);
      if (chain.length > best.length) best = chain;
    }
    seen.delete(id);
    const chain = [...best, id];
    memo.set(id, chain);
    return chain;
  };
  let best: string[] = [];
  for (const id of planOrder(plan)) {
    const chain = longest(id, new Set());
    if (chain.length > best.length) best = chain;
  }
  return best.length > 1 ? best : [];
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
): PlanFlowLayout {
  const col = columnsOf(view);
  const columns = Math.max(1, ...[...col.values()]);
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
  const colX = (c: number) => FLOW.LEFT + FLOW.TASK_W + FLOW.COL_GAP + (c - 1) * (FLOW.W + FLOW.COL_GAP);
  const width = colX(columns) + FLOW.W + FLOW.LEFT;
  const critical = new Set(criticalPath(view));
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
    w: FLOW.TASK_W,
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
      w: FLOW.W,
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
        critical: critical.has(step.id),
        met: false,
      });
    for (const dep of deps) {
      const a = at.get(dep) as FlowNode;
      edges.push({
        from: dep,
        to: step.id,
        d: path(a, b),
        critical: critical.has(dep) && critical.has(step.id),
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
  };
}

/** The words a pending step's node says: what it waits for, or that it can start. */
export const waitsText = (n: Pick<FlowNode, "waitsFor" | "state">): string | undefined =>
  n.state !== "pending"
    ? undefined
    : n.waitsFor.length > 0
      ? `waits for: ${n.waitsFor.join(", ")}`
      : "can start";
