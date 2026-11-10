/**
 * The view logic the daemon does not do (D7, ADR-0078): how sessions are ordered and grouped in
 * the panel, how a question becomes an inbox row, how times read. Pure functions, no DOM.
 */
import type {
  Attention,
  InboxItem,
  PaneState,
  PaneView,
  Question,
  RunOverview,
  StageProgress,
} from "./api.ts";

/** A run as the app sees it: with the repository it belongs to when the daemon serves a folder. */
export type Run = RunOverview & { readonly repo?: string | undefined };

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

/** The step label of a run in its feature group (`F · 2/3`), when it is one. */
export function stepLabel(
  run: Pick<RunOverview, "runId" | "parent">,
  groups: readonly FeatureGroup<RunOverview>[],
): string | undefined {
  const g = run.parent ? groups.find((x) => x.parent === run.parent) : undefined;
  if (!g) return undefined;
  const i = g.steps.findIndex((s) => s.runId === run.runId);
  return i < 0 ? undefined : `F · ${i + 1}/${g.steps.length}`;
}

/** The next session that waits for a person after `current` (the `g` key), wrapping around. */
export function nextWaiting<R extends Pick<RunOverview, "runId" | "attention">>(
  runs: readonly R[],
  current: string | undefined,
): R | undefined {
  const waiting = runs.filter((r) => r.attention === "you");
  if (waiting.length === 0) return undefined;
  const i = waiting.findIndex((r) => r.runId === current);
  return waiting[(i + 1) % waiting.length];
}

export const questionKind = (q: Pick<Question, "source">): "GATE" | "PERMISSION" | "QUESTION" =>
  q.source === "gate" ? "GATE" : q.source === "permission" ? "PERMISSION" : "QUESTION";

/** The chips of an inbox row (spec §6.3): reversible, blast radius, policy candidate, blocks a wave. */
export function inboxChips(item: Pick<InboxItem, "question" | "driving">): string[] {
  const card = item.question.card;
  const chips: string[] = [];
  if (card) chips.push(card.reversible ? "reversible" : "not reversible");
  if (card?.blastRadius && card.blastRadius.files > 0) chips.push(`blast ${card.blastRadius.files} files`);
  if (item.question.source === "permission") chips.push("policy candidate");
  if (card?.costOfDelay?.some((c) => /blocks/.test(c))) chips.push("blocks wave");
  if (item.driving) chips.push("agent idle");
  return chips;
}

/** `3s`, `4 min`, `2 h 05`, `3 d`: how long something took or has waited. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} d`;
}

export const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
};

/** The stage bar's text: `intake ✓ ─ plan ⟳ ─ gates ·`. */
export function stageGlyph(s: Pick<StageProgress, "state">): string {
  switch (s.state) {
    case "done":
      return "✓";
    case "current":
      return "⟳";
    case "waiting":
      return "?";
    case "stopped":
      return "✕";
    default:
      return "·";
  }
}

/** The command the card's footer shows: what answering writes. */
export function answerCommand(
  q: Pick<Question, "id" | "runId" | "source" | "stage">,
  choice: string,
  by: string,
): string {
  const who = by ? quote(by) : "<you>";
  return q.source === "gate"
    ? `metator run approve ${q.stage} --run ${q.runId} --choice ${quote(choice)} --by ${who}`
    : `metator run answer ${q.id} --run ${q.runId} --choice ${quote(choice)} --by ${who}`;
}

const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** The hash route: `#/inbox`, `#/session/<run>`, `#/grid`, `#/graph`, `#/supervisor`, `#/briefing/<run>`. */
export type Route =
  | { readonly screen: "inbox" }
  | { readonly screen: "session"; readonly runId: string; readonly pane?: string }
  | { readonly screen: "grid"; readonly group?: string }
  | { readonly screen: "graph" }
  | { readonly screen: "supervisor" }
  | { readonly screen: "briefing"; readonly runId: string };

export function parseRoute(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter((p) => p !== "");
  const [screen, arg] = parts;
  switch (screen) {
    case "session": {
      const pane = parts[2];
      return arg
        ? {
            screen: "session",
            runId: decodeURIComponent(arg),
            ...(pane ? { pane: decodeURIComponent(pane) } : {}),
          }
        : { screen: "inbox" };
    }
    case "grid":
      return arg ? { screen: "grid", group: decodeURIComponent(arg) } : { screen: "grid" };
    case "graph":
      return { screen: "graph" };
    case "supervisor":
      return { screen: "supervisor" };
    case "briefing":
      return arg ? { screen: "briefing", runId: decodeURIComponent(arg) } : { screen: "inbox" };
    default:
      return { screen: "inbox" };
  }
}

export function routeHash(route: Route): string {
  switch (route.screen) {
    case "session":
      return `#/session/${encodeURIComponent(route.runId)}${route.pane ? `/${encodeURIComponent(route.pane)}` : ""}`;
    case "briefing":
      return `#/briefing/${encodeURIComponent(route.runId)}`;
    case "grid":
      return route.group ? `#/grid/${encodeURIComponent(route.group)}` : "#/grid";
    default:
      return `#/${route.screen}`;
  }
}

/** A person is "back" when they were away this long (spec §6.8): the briefing opens first. */
export const AWAY_MS = 10 * 60 * 1000;
export const wasAway = (lastSeenAt: number | undefined, now: number): boolean =>
  lastSeenAt !== undefined && now - lastSeenAt >= AWAY_MS;

/** Questions of the state that were not there before: what a notification announces. */
export function newQuestions(
  before: readonly Pick<Question, "id" | "runId">[],
  after: readonly Pick<Question, "id" | "runId" | "prompt">[],
): Pick<Question, "id" | "runId" | "prompt">[] {
  const seen = new Set(before.map((q) => `${q.runId}/${q.id}`));
  return after.filter((q) => !seen.has(`${q.runId}/${q.id}`));
}

/** The panes of a run (R4): the conductor first, then workers in order, then the rest. */
export function panesOfRun<P extends Pick<PaneView, "runId" | "role" | "id">>(
  panes: readonly P[],
  runId: string,
): P[] {
  const rank: Record<PaneView["role"], number> = { conductor: 0, worker: 1, gate: 2, apps: 3, shell: 4 };
  return panes
    .filter((p) => p.runId === runId)
    .sort((a, b) => rank[a.role] - rank[b.role] || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** What a pane tab says: its worker's name, its agent, or its role. */
export function paneLabel(pane: Pick<PaneView, "role" | "label" | "worker" | "process">): string {
  if (pane.worker) return pane.worker.name;
  if (pane.role === "conductor")
    return `conductor · ${pane.process.kind === "host" ? pane.process.agent : pane.label}`;
  return pane.label || pane.role;
}

/** The chip tone of a pane state: blocked and waiting want a person, working is the agent's, the rest is grey. */
export const stateTone = (state: PaneState | undefined): "amber" | "violet" | "red" | undefined =>
  state === "blocked" || state === "waiting"
    ? "amber"
    : state === "working"
      ? "violet"
      : state === "exited"
        ? "red"
        : undefined;
