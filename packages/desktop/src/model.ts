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
  ResolvedOption,
  RunOverview,
  SplitNode,
  StageProgress,
  TabView,
  WorkspaceView,
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
  | { readonly screen: "grid"; readonly group?: string; readonly pane?: string }
  | { readonly screen: "graph" }
  | { readonly screen: "supervisor" }
  | { readonly screen: "settings" }
  | { readonly screen: "plan"; readonly runId: string }
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
      return arg
        ? arg.startsWith("pane:")
          ? { screen: "grid", pane: decodeURIComponent(arg.slice("pane:".length)) }
          : { screen: "grid", group: decodeURIComponent(arg) }
        : { screen: "grid" };
    case "graph":
      return { screen: "graph" };
    case "supervisor":
      return { screen: "supervisor" };
    case "settings":
      return { screen: "settings" };
    case "briefing":
      return arg ? { screen: "briefing", runId: decodeURIComponent(arg) } : { screen: "inbox" };
    case "plan":
      return arg ? { screen: "plan", runId: decodeURIComponent(arg) } : { screen: "grid" };
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
    case "plan":
      return `#/plan/${encodeURIComponent(route.runId)}`;
    case "grid":
      return route.pane
        ? `#/grid/pane:${encodeURIComponent(route.pane)}`
        : route.group
          ? `#/grid/${encodeURIComponent(route.group)}`
          : "#/grid";
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

/** The settings sections: one per option group, in the registry's order of first appearance. */
export function optionSections(
  options: readonly ResolvedOption[],
): { readonly id: string; readonly count: number; readonly changed: number }[] {
  const out = new Map<string, { id: string; count: number; changed: number }>();
  for (const o of options) {
    const id = o.key.split(".")[0] as string;
    const s = out.get(id) ?? { id, count: 0, changed: 0 };
    s.count += 1;
    if (o.source !== "default") s.changed += 1;
    out.set(id, s);
  }
  return [...out.values()];
}

/** The settings search: the key, the title or the description holds the words. */
export const optionMatches = (o: ResolvedOption, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return (
    q === "" ||
    o.key.toLowerCase().includes(q) ||
    o.definition.title.toLowerCase().includes(q) ||
    o.definition.description.toLowerCase().includes(q)
  );
};

/* ---------- the workbench (S6): tabs are tasks, keys are chords ---------- */

/** A tab of the workbench: the repository's own tab (a shell), or a run (a task in its worktree). */
export interface WorkbenchTab {
  /** Stable across renders: the daemon's tab id. */
  readonly key: string;
  readonly label: string;
  readonly kind: "task" | "shell";
  readonly workspaceId: string;
  readonly tabId: string;
  readonly panes: readonly string[];
  readonly tree?: SplitNode | undefined;
  readonly runId?: string | undefined;
  readonly run?: RunOverview | undefined;
  readonly branch?: string | undefined;
  readonly worktree?: string | undefined;
  readonly attention?: Attention | undefined;
}

/** A repository as the sidebar shows it: its workspace (or a stand-in) and its tabs. */
export interface WorkbenchRepo {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly tabs: readonly WorkbenchTab[];
  /** The strongest attention among its tabs: amber beats violet beats grey. */
  readonly attention?: Attention | undefined;
}

const ATTENTION_WEIGHT: Record<Attention, number> = {
  you: 3,
  escalated: 3,
  driving: 2,
  stopped: 1,
  done: 0,
  aborted: 0,
};

/**
 * The daemon's workspaces regrouped the way the workbench shows them: a repository per
 * workspace without a run, and under it, as tabs, its own tabs and every run workspace that sits
 * in it (grouped under it, or made in its directory). Run workspaces nobody groups stand alone.
 */
export function workbenchRepos(
  workspaces: readonly WorkspaceView[],
  runs: readonly RunOverview[],
  fallbackLabel = "this repository",
): WorkbenchRepo[] {
  const runOf = (id: string | undefined) => (id ? runs.find((r) => r.runId === id) : undefined);
  const taskTab = (w: WorkspaceView): WorkbenchTab => {
    const run = runOf(w.runId);
    const first = w.tabs[0] as TabView;
    return {
      key: first.id,
      label: run?.task ?? w.label,
      kind: "task",
      workspaceId: w.id,
      tabId: first.id,
      panes: first.panes,
      tree: first.tree,
      runId: w.runId,
      run,
      branch: run?.worktree?.branch,
      worktree: run?.worktree?.path ?? (w.cwd !== undefined ? w.cwd : undefined),
      attention: run?.attention,
    };
  };
  const shellTab = (w: WorkspaceView, t: TabView): WorkbenchTab => ({
    key: t.id,
    label: t.label,
    kind: "shell",
    workspaceId: w.id,
    tabId: t.id,
    panes: t.panes,
    tree: t.tree,
  });
  const repos = workspaces.filter((w) => !w.runId);
  const runWorkspaces = workspaces.filter((w) => w.runId);
  const taken = new Set<string>();
  const out: WorkbenchRepo[] = repos.map((w) => {
    const own = w.tabs.filter((t) => t.panes.length > 0 || w.tabs.length === 1).map((t) => shellTab(w, t));
    const mine = runWorkspaces.filter((r) => r.group === w.id || (!r.group && r.cwd === w.cwd));
    for (const r of mine) taken.add(r.id);
    const tabs = [...mine.map(taskTab), ...own];
    return { id: w.id, label: w.label, cwd: w.cwd, tabs, attention: strongest(tabs) };
  });
  const loose = runWorkspaces.filter((r) => !taken.has(r.id));
  if (loose.length > 0) {
    const tabs = loose.map(taskTab);
    out.push({
      id: "repo",
      label: fallbackLabel,
      cwd: loose[0]?.cwd ?? "",
      tabs,
      attention: strongest(tabs),
    });
  }
  return out;
}

const strongest = (tabs: readonly WorkbenchTab[]): Attention | undefined =>
  tabs
    .map((t) => t.attention)
    .filter((a): a is Attention => a !== undefined)
    .sort((a, b) => ATTENTION_WEIGHT[b] - ATTENTION_WEIGHT[a])[0];

/** A keyboard event as a chord the options spell: `ctrl+b`, `shift+enter`, `[`, `f5`. */
export function chordOf(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): string {
  const named: Record<string, string> = {
    " ": "space",
    Enter: "enter",
    Escape: "escape",
    Tab: "tab",
    Backspace: "backspace",
    Delete: "delete",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
  };
  const key = named[e.key] ?? e.key.toLowerCase();
  if (["control", "alt", "shift", "meta"].includes(key)) return "";
  const mods = [
    e.ctrlKey ? "ctrl" : "",
    e.altKey ? "alt" : "",
    e.shiftKey && key.length > 1 ? "shift" : "",
    e.metaKey ? "meta" : "",
  ].filter((m) => m !== "");
  return [...mods, key].join("+");
}

/** The keymap: action → chords, from the `keys.*` options (`prefix+z` means after the prefix). */
export type KeyMap = Readonly<Record<string, readonly string[]>>;

/** The registry's defaults (`keys.*`), so the keys work before the options arrive from the daemon. */
export const DEFAULT_KEYS: KeyMap = {
  prefix: ["ctrl+b"],
  newShell: ["prefix+c"],
  newTab: ["prefix+t"],
  splitRight: ["prefix+v"],
  splitDown: ["prefix+-"],
  zoom: ["prefix+z"],
  focusLeft: ["prefix+h", "prefix+left"],
  focusDown: ["prefix+j", "prefix+down"],
  focusUp: ["prefix+k", "prefix+up"],
  focusRight: ["prefix+l", "prefix+right"],
  goto: ["prefix+g"],
  nextWaiting: ["prefix+n"],
  attach: ["prefix+a"],
  release: ["prefix+escape"],
  copyMode: ["prefix+["],
  closePane: ["prefix+x"],
  detach: ["prefix+q"],
  plan: ["prefix+p"],
  changes: ["prefix+r"],
  backlog: ["prefix+b"],
  help: ["prefix+?"],
};

/** The keymap from the options; the defaults where the options say nothing (or are not here yet). */
export const keyMapOf = (options: readonly Pick<ResolvedOption, "key" | "value">[]): KeyMap => ({
  ...DEFAULT_KEYS,
  ...Object.fromEntries(
    options
      .filter((o) => o.key.startsWith("keys.") && Array.isArray(o.value))
      .map((o) => [o.key.slice("keys.".length), (o.value as string[]).map((c) => c.toLowerCase())]),
  ),
});

/**
 * What a chord does: with the prefix pressed before, the actions bound to `prefix+<chord>`;
 * without, the ones bound to the bare chord (the prefix itself is `prefix`).
 */
export function actionOf(map: KeyMap, chord: string, prefixed: boolean): string | undefined {
  const wanted = prefixed ? `prefix+${chord}` : chord;
  for (const [action, chords] of Object.entries(map)) if (chords.includes(wanted)) return action;
  return undefined;
}

/** The pane after or before one in a tree's order (focus moves by the leaves' order). */
export function neighborPane(
  tree: SplitNode | undefined,
  current: string | undefined,
  step: 1 | -1,
): string | undefined {
  if (!tree) return undefined;
  const leaves = treeLeavesOf(tree);
  if (leaves.length === 0) return undefined;
  const i = current ? leaves.indexOf(current) : -1;
  if (i < 0) return leaves[0];
  return leaves[(i + step + leaves.length) % leaves.length];
}

export const treeLeavesOf = (node: SplitNode): string[] =>
  "pane" in node ? [node.pane] : [...treeLeavesOf(node.a), ...treeLeavesOf(node.b)];

/** Panes of a tab as an even tree when the daemon kept none. */
export function evenTree(panes: readonly string[], dir: "row" | "column" = "row"): SplitNode | undefined {
  if (panes.length === 0) return undefined;
  if (panes.length === 1) return { pane: panes[0] as string };
  const half = Math.ceil(panes.length / 2);
  const next = dir === "row" ? "column" : "row";
  return {
    dir,
    ratio: half / panes.length,
    a: evenTree(panes.slice(0, half), next) as SplitNode,
    b: evenTree(panes.slice(half), next) as SplitNode,
  };
}

/** The tree with the ratio at a path replaced (a drag of a divider). */
export function withRatio(node: SplitNode, path: readonly ("a" | "b")[], ratio: number): SplitNode {
  if ("pane" in node) return node;
  const clamped = Math.min(0.9, Math.max(0.1, ratio));
  if (path.length === 0) return { ...node, ratio: clamped };
  const [step, ...rest] = path;
  return step === "a"
    ? { ...node, a: withRatio(node.a, rest, ratio) }
    : { ...node, b: withRatio(node.b, rest, ratio) };
}

export type GotoFilter = "all" | "blocked" | "working" | "idle" | "done";

export interface GotoRow {
  readonly kind: "pane" | "question";
  readonly id: string;
  readonly tab: WorkbenchTab;
  readonly label: string;
  readonly detail: string;
  readonly state: PaneState | "question" | undefined;
  readonly paneId?: string | undefined;
  readonly questionId?: string | undefined;
}

/** The go-to picker's rows: every pane of every tab, then the open questions; filtered by state or text. */
export function gotoRows(
  repos: readonly WorkbenchRepo[],
  panes: readonly PaneView[],
  filter: GotoFilter,
  query: string,
): GotoRow[] {
  const q = query.trim().toLowerCase();
  const rows: GotoRow[] = [];
  for (const repo of repos)
    for (const tab of repo.tabs) {
      for (const id of tab.panes) {
        const p = panes.find((x) => x.id === id);
        if (!p) continue;
        const state = p.state?.state ?? (p.live?.alive ? "working" : "exited");
        rows.push({
          kind: "pane",
          id: p.id,
          tab,
          label: paneLabel(p),
          detail: p.state?.reason ?? `${tab.label}`,
          state,
          paneId: p.id,
        });
      }
      for (const question of tab.run?.questions ?? [])
        rows.push({
          kind: "question",
          id: `${tab.runId}/${question.id}`,
          tab,
          label: question.prompt,
          detail: `${tab.label} · ${question.agent ?? question.source}`,
          state: "question",
          questionId: question.id,
        });
    }
  return rows.filter((r) => {
    if (q !== "" && !`${r.label} ${r.detail} ${r.tab.label}`.toLowerCase().includes(q)) return false;
    switch (filter) {
      case "blocked":
        return r.state === "blocked" || r.state === "waiting" || r.state === "question";
      case "working":
        return r.state === "working";
      case "idle":
        return r.state === "idle";
      case "done":
        return r.state === "exited";
      default:
        return true;
    }
  });
}

/** The process strip's text for a run: `intake ✓ · plan ⟳ · gates ·`, each stage once. */
export const stripStages = (
  run: RunOverview | undefined,
): { id: string; glyph: string; state: StageProgress["state"] }[] =>
  (run?.stages ?? []).map((s) => ({ id: s.id, glyph: stageGlyph(s), state: s.state }));
