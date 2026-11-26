/**
 * The System pages: the dependency graph's layout, the map's problems, the daemon's counts.
 */
import type { Attention, RunOverview } from "../../shared/api/api.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { isFinished } from "../../shared/model/runs.ts";
import { needsPerson } from "../terminals/model.ts";

export interface RunCounts {
  /** Runs that wait for a person, escalated ones included. */
  readonly needYou: number;
  readonly working: number;
  /** Among `needYou`: the runs that stopped and need work. */
  readonly escalated: number;
  readonly stopped: number;
  readonly finished: number;
  /** Every run that is not finished: what the panel, the graph and the daemon screen list. */
  readonly open: number;
}
/**
 * A setting's duration as it is set, not rounded: 90000 ms is `1.5 min` (in half minutes or half
 * hours), else in seconds, else in milliseconds.
 */
export function exactDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 1_800_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 30_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}
/** The one count of runs: the top bar, the Inbox, the graph and the daemon screen all read it. */
export function runCounts(runs: readonly Pick<RunOverview, "attention" | "status">[]): RunCounts {
  const of = (a: Attention) => runs.filter((r) => r.attention === a).length;
  const finished = runs.filter(isFinished).length;
  return {
    needYou: runs.filter(needsPerson).length,
    working: of("driving"),
    escalated: of("escalated"),
    stopped: of("stopped"),
    finished,
    open: runs.length - finished,
  };
}
/**
 * Who works on a run, in one word for a table and the run's bar: the person who holds its
 * keyboard, the agent while a drive or a live session runs it, else nobody.
 */
export const whoWorks = (
  r: Pick<RunOverview, "driver" | "attachedBy" | "driving" | "status">,
  sessionAlive: boolean,
): string =>
  isFinished(r)
    ? "nobody"
    : r.driver === "human"
      ? (r.attachedBy ?? "a person")
      : r.driving || sessionAlive
        ? "agent"
        : "nobody";
/** The lanes of the runs graph that have a card in them, in their order. */
export const drawnLanes = (
  lanes: readonly string[],
  nodes: readonly { readonly run: { readonly repo?: string | undefined } }[],
): string[] => lanes.filter((l) => nodes.some((n) => sameRepo(n.run.repo, l)));
/** A run as a card of the dependencies graph. */
export interface GraphNode<R> {
  readonly run: R;
  readonly x: number;
  readonly y: number;
  /** Finished: drawn dimmed, kept so the picture of what was done stays. */
  readonly finished: boolean;
}
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** An SVG path from the parent's card to the child's, ending at the child's edge. */
  readonly d: string;
}
export const GRAPH = { W: 220, H: 54, GAP: 40, LANE: 120, TOP: 40, LEFT: 24 } as const;
/**
 * The dependencies graph laid out: one lane per repository, a run's column its depth in the
 * parent → child chain (a child is always right of its parent, so no arrow runs backwards), the
 * next free column when two runs of a lane share one. Finished runs stay, dimmed, when they were
 * updated in the last `keepMs` or are linked to a run shown. An arrow between lanes leaves the
 * parent's right edge and enters the child's left edge with a curve that never crosses a card.
 */
export function graphLayout<R extends RunOverview & { readonly repo?: string | undefined }>(
  runs: readonly R[],
  lanes: readonly string[],
  now: number = Date.now(),
  keepMs = 24 * 60 * 60 * 1000,
): {
  readonly nodes: readonly GraphNode<R>[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
} {
  const recent = (r: R) => !isFinished(r) || now - Date.parse(r.updatedAt) <= keepMs;
  const linked = new Set<string>();
  for (const r of runs.filter((x) => !isFinished(x))) {
    if (r.parent) linked.add(r.parent);
    for (const c of r.children ?? []) linked.add(c);
  }
  const shown = runs.filter((r) => recent(r) || linked.has(r.runId));
  const byId = new Map(shown.map((r) => [r.runId, r]));
  const parentOf = (r: R): R | undefined =>
    (r.parent ? byId.get(r.parent) : undefined) ?? shown.find((p) => p.children?.includes(r.runId));
  const depth = (r: R, seen = new Set<string>()): number => {
    const p = parentOf(r);
    if (!p || seen.has(r.runId)) return 0;
    seen.add(r.runId);
    return depth(p, seen) + 1;
  };
  const taken = new Set<string>();
  const nodes: GraphNode<R>[] = [];
  const ordered = [...shown].sort((a, b) => depth(a) - depth(b) || a.createdAt.localeCompare(b.createdAt));
  for (const r of ordered) {
    const lane = Math.max(
      0,
      lanes.findIndex((l) => sameRepo(l, r.repo)),
    );
    let col = depth(r);
    const p = parentOf(r);
    const pNode = p ? nodes.find((n) => n.run.runId === p.runId) : undefined;
    if (pNode) col = Math.max(col, Math.round((pNode.x - GRAPH.LEFT) / (GRAPH.W + GRAPH.GAP)) + 1);
    while (taken.has(`${lane}:${col}`)) col++;
    taken.add(`${lane}:${col}`);
    nodes.push({
      run: r,
      x: GRAPH.LEFT + col * (GRAPH.W + GRAPH.GAP),
      y: GRAPH.TOP + lane * GRAPH.LANE,
      finished: isFinished(r),
    });
  }
  const at = new Map(nodes.map((n) => [n.run.runId, n]));
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    const p = parentOf(n.run);
    const pn = p ? at.get(p.runId) : undefined;
    if (!pn || pn === n) continue;
    const x1 = pn.x + GRAPH.W;
    const y1 = pn.y + GRAPH.H / 2;
    const x2 = n.x;
    const y2 = n.y + GRAPH.H / 2;
    const bend = Math.max(16, (x2 - x1) / 2);
    edges.push({
      from: pn.run.runId,
      to: n.run.runId,
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    });
  }
  const cols = Math.max(1, ...nodes.map((n) => Math.round((n.x - GRAPH.LEFT) / (GRAPH.W + GRAPH.GAP)) + 1));
  return {
    nodes,
    edges,
    width: GRAPH.LEFT * 2 + cols * (GRAPH.W + GRAPH.GAP),
    height: GRAPH.TOP + Math.max(1, lanes.length) * GRAPH.LANE,
  };
}
/** A path between two cards that are linked by data (a message, a shared file), or none for a card and itself. */
export function linkPath(
  a: { readonly x: number; readonly y: number } | undefined,
  b: { readonly x: number; readonly y: number } | undefined,
): string | undefined {
  if (!a || !b || a === b) return undefined;
  const [l, r] = a.x <= b.x ? [a, b] : [b, a];
  const x1 = l.x + GRAPH.W;
  const y1 = l.y + GRAPH.H / 2 + 8;
  const x2 = r.x;
  const y2 = r.y + GRAPH.H / 2 + 8;
  if (x2 <= x1) {
    // Stacked cards: down the right side.
    const x = Math.max(l.x, r.x) + GRAPH.W + 18;
    return `M ${l.x + GRAPH.W} ${y1} C ${x} ${y1}, ${x} ${y2}, ${r.x + GRAPH.W} ${y2}`;
  }
  const bend = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
/**
 * What is wrong with a list of `system.roots` before it is saved, one line per problem: an empty
 * entry, a path that is not absolute (`/…`, `~/…` or `C:\\…`), the same path twice.
 */
export function rootsProblems(paths: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  paths.forEach((raw, i) => {
    const p = raw.trim();
    const at = `path ${i + 1}`;
    if (p === "") problems.push(`${at} is empty`);
    else if (!/^(\/|~\/|~$|[A-Za-z]:[\\/])/.test(p))
      problems.push(`${at} (${p}) is not absolute: start it with / or ~/`);
    else if (seen.has(p.replace(/\/+$/, ""))) problems.push(`${at} (${p}) is listed twice`);
    seen.add(p.replace(/\/+$/, ""));
  });
  return problems;
}
