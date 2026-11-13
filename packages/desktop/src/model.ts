/**
 * The view logic the daemon does not do (D7, ADR-0078): how sessions are ordered and grouped in
 * the panel, how a question becomes an inbox row, how times read. Pure functions, no DOM.
 */
import type {
  Activity,
  Attention,
  InboxItem,
  IssueRef,
  PaneView,
  Question,
  ResolvedOption,
  RunOverview,
  SplitNode,
  StageProgress,
  TabView,
  WorkspaceView,
} from "./api.ts";

/**
 * A run as the app sees it: with the repository it belongs to when the daemon serves a folder,
 * and the pane in which its agent asks when the question is on the terminal and not on a card.
 */
export type Run = RunOverview & {
  readonly repo?: string | undefined;
  readonly terminalAsk?: string | undefined;
};

/**
 * Runs with what their terminals say (D2): an active run with no question on a card whose pane is
 * blocked (the agent asks on its screen) waits for you like any other, and names the pane to open.
 * Every count and order of the app reads `attention`, so they all see it.
 */
export function withTerminalAsks(
  runs: readonly Run[],
  panes: readonly (Pick<PaneView, "id" | "runId" | "state"> & { readonly repo?: string | undefined })[],
): Run[] {
  return runs.map((r) => {
    if (r.status !== "active" || r.questions.length > 0) return r;
    const asking = panes.find(
      (p) => p.runId === r.runId && (p.repo ?? "") === (r.repo ?? "") && p.state?.state === "blocked",
    );
    return asking ? { ...r, attention: "you" as const, terminalAsk: asking.id } : r;
  });
}

/** Done or aborted: nothing is left to do. An escalated run is not finished, it waits for a person (F1). */
export const isFinished = (r: Pick<RunOverview, "status">): boolean =>
  r.status === "done" || r.status === "aborted";

/** The button of a start refused for uncommitted changes. */
export const START_FROM_COMMIT = "Start from the last commit";

/** A start refused because tracked files have uncommitted changes: the app offers to start without them. */
export const refusedForDirtyTree = (
  error: { readonly details?: Readonly<Record<string, unknown>> } | undefined,
): boolean => error?.details?.check === "tree";

/** The key of an escalated run in the inbox's selection, apart from a question's `<run>/<question>`. */
export const escalatedKey = (r: { readonly runId: string; readonly repo?: string | undefined }): string =>
  `escalated:${r.repo ?? ""}:${r.runId}`;

/** What the app says after Resume: the run is driven again, or why no drive started. */
export function resumeNotice(
  runId: string,
  drive: { readonly started?: boolean; readonly error?: string; readonly hint?: string } | undefined,
): string | undefined {
  if (!drive?.error) return undefined;
  return `Run ${runId} is resumed, but no agent works on it: ${drive.error}${drive.hint ? ` ${drive.hint}` : ""}`;
}

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

export const questionKind = (q: Pick<Question, "source">): "APPROVAL" | "PERMISSION" | "QUESTION" =>
  q.source === "gate" ? "APPROVAL" : q.source === "permission" ? "PERMISSION" : "QUESTION";

/** The chips of an inbox row (spec §6.3): reversible, how many files it touches, whether the answer can be remembered, blocks a wave. */
export function inboxChips(item: Pick<InboxItem, "question" | "driving">): string[] {
  const card = item.question.card;
  const chips: string[] = [];
  if (card) chips.push(card.reversible ? "reversible" : "not reversible");
  if (card?.blastRadius && card.blastRadius.files > 0) chips.push(`touches ${card.blastRadius.files} files`);
  if (item.question.source === "permission") chips.push("can be allowed always");
  if (card?.costOfDelay?.some((c) => /blocks/.test(c))) chips.push("blocks wave");
  if (item.driving) chips.push("agent idle");
  return chips;
}

/** `src/invoice.ts:10`, `run 2026…/S2`, a note: what a backlog task points at. */
export const issueRefText = (r: IssueRef): string =>
  r.file
    ? `${r.file}${r.line ? `:${r.line}` : ""}`
    : r.run
      ? `run ${r.run}${r.step ? `/${r.step}` : ""}`
      : (r.note ?? "");

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

/** The glyph of a stage in the stage bar: `intake ✓ ─ plan ⟳ ─ gates ·` (the `stage` row of `LOOKS`). */
export const stageGlyph = (s: Pick<StageProgress, "state">): string => lookOf("stage", s.state).glyph;

/**
 * The command the card's footer shows: what the button does. The card answers the question
 * (`POST /runs/:id/answer`), a gate's question too, so the command is `run answer` for every source.
 */
export function answerCommand(
  q: Pick<Question, "id" | "runId">,
  choice: string | readonly string[],
  by: string,
  text = "",
): string {
  const who = by ? quote(by) : "<you>";
  const choices = (typeof choice === "string" ? [choice] : choice).map(quote).join(" ");
  const words = text.trim() ? ` --text ${quote(text.trim())}` : "";
  return `metator run answer ${q.id} --run ${q.runId} --choice ${choices || "…"}${words} --by ${who}`;
}

const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/**
 * The hash route, one per screen: `#/inbox[/<run>%2F<question>]`, `#/session/<run>[/<pane>]`, `#/grid[/<group>|/pane:<pane>]`,
 * `#/graph`, `#/supervisor`, `#/mrs[/<id>]`, `#/settings`, `#/plan/<run>`, `#/backlog`,
 * `#/review/<run>[/<file>]`, `#/briefing/<run>`.
 */
export type Route =
  | { readonly screen: "inbox"; readonly pick?: string }
  | { readonly screen: "session"; readonly runId: string; readonly pane?: string }
  | { readonly screen: "grid"; readonly group?: string; readonly pane?: string }
  | { readonly screen: "graph" }
  | { readonly screen: "supervisor" }
  | { readonly screen: "mrs"; readonly id?: string }
  | { readonly screen: "settings" }
  | { readonly screen: "plan"; readonly runId: string }
  | { readonly screen: "backlog" }
  | { readonly screen: "review"; readonly runId: string; readonly file?: string }
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
    case "backlog":
      return { screen: "backlog" };
    case "mrs":
      return arg ? { screen: "mrs", id: decodeURIComponent(arg) } : { screen: "mrs" };
    case "review": {
      const file = parts.slice(2).map(decodeURIComponent).join("/");
      return arg
        ? { screen: "review", runId: decodeURIComponent(arg), ...(file ? { file } : {}) }
        : { screen: "inbox" };
    }
    case "briefing":
      return arg ? { screen: "briefing", runId: decodeURIComponent(arg) } : { screen: "inbox" };
    case "plan":
      return arg ? { screen: "plan", runId: decodeURIComponent(arg) } : { screen: "grid" };
    case "inbox":
      return arg ? { screen: "inbox", pick: decodeURIComponent(arg) } : { screen: "inbox" };
    default:
      return { screen: "inbox" };
  }
}

export function routeHash(route: Route): string {
  switch (route.screen) {
    case "session":
      return `#/session/${encodeURIComponent(route.runId)}${route.pane ? `/${encodeURIComponent(route.pane)}` : ""}`;
    case "inbox":
      return `#/inbox${route.pick ? `/${encodeURIComponent(route.pick)}` : ""}`;
    case "briefing":
      return `#/briefing/${encodeURIComponent(route.runId)}`;
    case "plan":
      return `#/plan/${encodeURIComponent(route.runId)}`;
    case "backlog":
      return "#/backlog";
    case "mrs":
      return `#/mrs${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
    case "review":
      return `#/review/${encodeURIComponent(route.runId)}${route.file ? `/${route.file.split("/").map(encodeURIComponent).join("/")}` : ""}`;
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

/** Whether the app may announce a question (its toast, the system notification): `notify.channel` is not `off`. */
export const notifies = (options: readonly Pick<ResolvedOption, "key" | "value">[]): boolean =>
  options.find((o) => o.key === "notify.channel")?.value !== "off";

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
    return `agent · ${pane.process.kind === "host" ? pane.process.agent : pane.label}`;
  return pane.label || pane.role;
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
/**
 * The keys of an action as a person presses them: `prefix+c` reads `ctrl+b then c` (the prefix key
 * first, then the letter). Undefined when the action has no key.
 */
export function keyText(map: KeyMap, action: string): string | undefined {
  const chord = map[action]?.[0];
  if (!chord?.startsWith("prefix+")) return chord;
  return `${map.prefix?.[0] ?? "the prefix key"} then ${chord.slice("prefix+".length)}`;
}

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

export type GotoFilter = "all" | "asks" | "working" | "idle" | "done";

export interface GotoRow {
  readonly kind: "pane" | "question";
  readonly id: string;
  readonly tab: WorkbenchTab;
  readonly label: string;
  readonly detail: string;
  readonly state: PaneShown | "question";
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
        const state = paneStateOf(p);
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
      case "asks":
        return r.state === "asks" || r.state === "question";
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

/* ---------- keys, answers, hosts, repositories: the small decisions every screen shares ---------- */

/**
 * The key of a single-letter shortcut (D7): the bare key, or nothing when Ctrl, Cmd or Alt is
 * held (the browser's and the system's own chords) or the person is typing in a field.
 */
export function plainKey(e: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly target: unknown;
}): string | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? "") || t.isContentEditable === true))
    return undefined;
  return e.key;
}

/** The choices after a click on one (D8): a multi-select question toggles it, any other takes it alone. */
export const toggleChoice = (selected: readonly string[], label: string, multi: boolean): string[] =>
  !multi ? [label] : selected.includes(label) ? selected.filter((c) => c !== label) : [...selected, label];

/** Reject and Other promise the person's own words: the answer waits for them. */
export const needsReason = (choices: readonly string[]): boolean =>
  choices.some((c) => c === "Reject" || c === "Other");

/** Whether an answer can be sent: something is chosen, and the reason is there when one is promised. */
export const canAnswer = (choices: readonly string[], text: string): boolean =>
  choices.length > 0 && (!needsReason(choices) || text.trim() !== "");

/** An interactive host as `/supervisor` reports it: the program it starts, and whether it is there. */
export interface HostStatus {
  readonly id: string;
  readonly command?: string | undefined;
  readonly installed: boolean;
}

/**
 * The host of a new session (D1): the first of `hostOrder` that is installed, else any installed
 * one, else none. A daemon that does not report what is installed leaves the order to decide.
 */
export function hostChoice(
  hostOrder: readonly string[],
  status: readonly HostStatus[] | undefined,
  hosts: readonly string[] = [],
): string | undefined {
  if (!status) return hostOrder.find((h) => hosts.includes(h)) ?? hosts[0];
  const installed = status.filter((h) => h.installed).map((h) => h.id);
  return hostOrder.find((h) => installed.includes(h)) ?? installed[0];
}

const listed = (words: readonly string[]): string =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** What the app says when no host can start: what was looked for and where the guide is. */
export const noHostText = (status: readonly HostStatus[]): string =>
  `No AI host is installed. The daemon looked for ${listed(status.map((h) => h.command ?? h.id))} and found none. ` +
  'Install one of them (the guide page "Copilot and Claude Code", site/guide/hosts.md, says how), ' +
  "then try again.";

/** The workflow of a run started from the backlog (D5): the wanted one when the repository has it, `mt-feature`, else its first. */
export const workflowChoice = (
  workflows: readonly string[],
  wanted: string | undefined,
): string | undefined =>
  wanted && workflows.includes(wanted)
    ? wanted
    : workflows.includes("mt-feature")
      ? "mt-feature"
      : workflows[0];

/** The repository the list screens show in a folder (D10): the remembered one while it is served, else the first. */
export const repoChoice = (
  repos: readonly { readonly name: string }[],
  saved: string | null | undefined,
): string | undefined => (repos.some((r) => r.name === saved) ? (saved as string) : repos[0]?.name);

/** An autonomy level with words beside it: `L0: every approval waits for you`. */
export const autonomyLabel = (level: string): string =>
  level === "L0"
    ? "L0: every approval waits for you"
    : level === "L1"
      ? "L1: skips the approvals the workflow lets it skip"
      : level === "L2"
        ? "L2: no person at hand; only the approvals that are never skipped wait"
        : level;

/** The autonomy levels the form offers for a workflow: the ones it lists; L0 and L1 when the daemon does not say. */
export const autonomyLevels = (
  workflow: { readonly autonomy?: readonly string[] | undefined } | undefined,
): readonly string[] => (workflow?.autonomy?.length ? workflow.autonomy : ["L0", "L1"]);

/* ---------- one vocabulary: what a state reads as, its glyph and its colour ---------- */

/** The colours a state can take; each is a class of the stylesheet (`faint` is the dim text colour). */
export type Tone = "amber" | "violet" | "red" | "green" | "blue" | "teal" | "faint";

/**
 * What a pane reads as, on every screen: an agent at work, an agent that asks (on its own screen
 * or on a card), a pane where nothing happens, a process that ended.
 */
export type PaneShown = "working" | "asks" | "idle" | "exited";

/**
 * The state of a pane as the app shows it. The daemon's `blocked` (the host's prompt is on the
 * screen) and `waiting` (a question of the run is open) both read `asks`, and only for an agent: a
 * shell of the same run does not ask, it is idle. A live shell the daemon says nothing about is
 * idle too, never "working"; a pane with no live process has exited.
 */
export function paneStateOf(pane: Pick<PaneView, "process" | "live" | "state">): PaneShown {
  const raw = pane.state?.state;
  if (raw === "exited" || !pane.live?.alive) return "exited";
  const agent = pane.process.kind === "host";
  if (raw === "blocked" || raw === "waiting") return agent ? "asks" : "idle";
  if (raw === "working") return "working";
  if (raw === "idle") return "idle";
  return agent ? "working" : "idle";
}

export interface Look {
  readonly glyph: string;
  readonly tone?: Tone | undefined;
}

/** Every state the app draws with a glyph and a colour, by what it is the state of. */
export const LOOKS = {
  pane: {
    working: { glyph: "⋮", tone: "violet" },
    asks: { glyph: "?", tone: "amber" },
    idle: { glyph: "✓", tone: "faint" },
    exited: { glyph: "✕", tone: "red" },
    question: { glyph: "?", tone: "amber" },
  },
  stage: {
    done: { glyph: "✓", tone: "green" },
    current: { glyph: "⟳", tone: "violet" },
    waiting: { glyph: "?", tone: "amber" },
    stopped: { glyph: "✕", tone: "red" },
    next: { glyph: "·", tone: "faint" },
  },
  step: {
    done: { glyph: "✓", tone: "green" },
    "in-progress": { glyph: "⋮", tone: "violet" },
    blocked: { glyph: "!", tone: "amber" },
    todo: { glyph: "○", tone: "faint" },
    waiting: { glyph: "?", tone: "amber" },
  },
  issue: {
    proposed: { glyph: "?", tone: "amber" },
    "in-progress": { glyph: "⋮", tone: "violet" },
    open: { glyph: "○" },
    done: { glyph: "✓", tone: "green" },
    dropped: { glyph: "✕", tone: "faint" },
  },
  note: {
    draft: { glyph: "✎", tone: "amber" },
    sent: { glyph: "→", tone: "violet" },
    addressed: { glyph: "✓", tone: "green" },
  },
  thread: {
    open: { glyph: "○", tone: "amber" },
    answered: { glyph: "↩" },
    planned: { glyph: "⋮", tone: "violet" },
    fixed: { glyph: "✓", tone: "green" },
    resolved: { glyph: "✓", tone: "green" },
  },
  file: {
    added: { glyph: "A", tone: "green" },
    deleted: { glyph: "D", tone: "red" },
    modified: { glyph: "M", tone: "amber" },
    renamed: { glyph: "R", tone: "amber" },
  },
  attention: {
    you: { glyph: "●", tone: "amber" },
    driving: { glyph: "●", tone: "violet" },
    escalated: { glyph: "●", tone: "red" },
    done: { glyph: "●", tone: "green" },
    stopped: { glyph: "●", tone: "faint" },
    aborted: { glyph: "●", tone: "faint" },
  },
} as const satisfies Record<string, Record<string, Look>>;

export type LookKind = keyof typeof LOOKS;

/** The glyph and colour of a state; a state the table does not know is a faint dot. */
export function lookOf(kind: LookKind, state: string | undefined): Look {
  const table: Record<string, Look> = LOOKS[kind];
  return (state !== undefined ? table[state] : undefined) ?? { glyph: "·", tone: "faint" };
}

/* ---------- counts, repositories, routes: what several screens must agree on ---------- */

/** Two things belong to the same repository; "no repository" (the daemon serves one) is one too. */
export const sameRepo = (a: string | undefined, b: string | undefined): boolean => (a ?? "") === (b ?? "");

/** A run that waits for a person: it asks (on a card or in its terminal), or it escalated (F1). */
export const needsPerson = (r: Pick<RunOverview, "attention">): boolean =>
  r.attention === "you" || r.attention === "escalated";

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

/** The runs that are not finished, escalated ones included. */
export const openRuns = <R extends Pick<RunOverview, "status">>(runs: readonly R[]): R[] =>
  runs.filter((r) => !isFinished(r));

/** The run a route is about (session, plan, changes, briefing), or none. */
export const runIdOf = (route: Route): string | undefined =>
  route.screen === "session" ||
  route.screen === "plan" ||
  route.screen === "review" ||
  route.screen === "briefing"
    ? route.runId
    : undefined;

/** The four screens of one run, in the order of the run header's tabs. */
export const RUN_TABS = [
  { screen: "session", label: "Session" },
  { screen: "plan", label: "Plan" },
  { screen: "review", label: "Changes" },
  { screen: "briefing", label: "Briefing" },
] as const;

/**
 * Where a run stands for the session screen's bar: `escalated` and `finished` runs have no
 * driver to show and nothing to attach to.
 */
export const runPhase = (r: Pick<RunOverview, "status">): "active" | "escalated" | "finished" =>
  r.status === "escalated" ? "escalated" : isFinished(r) ? "finished" : "active";

/** What the session screen says of a finished run in one line. */
export const finishedText = (r: Pick<RunOverview, "status" | "stage" | "reason" | "elapsedMs">): string =>
  r.status === "aborted"
    ? `Closed as aborted at ${r.stage}${r.reason ? `: ${r.reason}` : ""}.`
    : `Done: every stage passed, in ${duration(r.elapsedMs)}.`;

/** Events grouped by the stage they happened in, in the order the stages first appear. */
export function byStage<E extends Pick<Activity, "stage">>(entries: readonly E[]): [string, E[]][] {
  const groups = new Map<string, E[]>();
  for (const e of entries) groups.set(e.stage ?? "run", [...(groups.get(e.stage ?? "run") ?? []), e]);
  return [...groups.entries()];
}

/** `2 replies`, `1 reply`, `1 task`: a count with its noun. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The message of a refusal, with its hint; what the app says when the daemon says nothing. */
export const refusalText = (
  error: { readonly message?: string; readonly hint?: string } | undefined,
  fallback = "the daemon refused",
): string => `${error?.message ?? fallback}${error?.hint ? ` ${error.hint}` : ""}`;

/* ---------- the workbench's small decisions ---------- */

/** The tab that holds a pane, or the tab of a run. */
export const tabOfPane = (repos: readonly WorkbenchRepo[], paneId: string): WorkbenchTab | undefined =>
  repos.flatMap((r) => r.tabs).find((t) => t.panes.includes(paneId));
export const tabOfRun = (repos: readonly WorkbenchRepo[], runId: string): WorkbenchTab | undefined =>
  repos.flatMap((r) => r.tabs).find((t) => t.runId === runId);

/** The sidebar entry a tab sits under. */
export const repoOfTab = (repos: readonly WorkbenchRepo[], tabKey: string): WorkbenchRepo | undefined =>
  repos.find((r) => r.tabs.some((t) => t.key === tabKey));

/** The next tab that waits for a person after the current one, around the end; none when none waits. */
export function nextWaitingTab(
  repos: readonly WorkbenchRepo[],
  currentKey: string | undefined,
): WorkbenchTab | undefined {
  const all = repos.flatMap((r) => r.tabs);
  const i = all.findIndex((t) => t.key === currentKey);
  return [...all.slice(i + 1), ...all.slice(0, i + 1)].find(
    (t) => t.attention === "you" || t.attention === "escalated",
  );
}

/**
 * Closing a tab closes its whole workspace when the tab is a run's, or the last of its workspace;
 * a tab that shares its workspace loses only its own panes.
 */
export const closesWorkspace = (repos: readonly WorkbenchRepo[], tab: WorkbenchTab): boolean =>
  tab.kind === "task" ||
  repos.flatMap((r) => r.tabs).filter((t) => t.workspaceId === tab.workspaceId).length === 1;

/** The one toast of the workbench: the first open question of a tab shown here that was not dismissed. */
export function toastOf<I extends Pick<InboxItem, "runId" | "question">>(
  inbox: readonly I[],
  repos: readonly WorkbenchRepo[],
  dismissed: readonly string[],
  announce: boolean,
): I | undefined {
  if (!announce) return undefined;
  return inbox.find(
    (i) => !dismissed.includes(`${i.runId}/${i.question.id}`) && tabOfRun(repos, i.runId) !== undefined,
  );
}

/** The host a dead pane starts again on: the one it had while it is installed, else the order's first installed. */
export function retryHost(
  wanted: string,
  hostOrder: readonly string[],
  status: readonly HostStatus[] | undefined,
): string | undefined {
  if (!status || status.some((h) => h.id === wanted && h.installed)) return wanted;
  return hostChoice(hostOrder, status);
}

/** What a workbench command can see when it says its label and whether it applies. */
export interface CommandContext {
  /** The pane the command is about: the focused one, or the one under the menu. */
  readonly pane?:
    | { readonly runId?: string | undefined; readonly role: PaneView["role"]; readonly asks: boolean }
    | undefined;
  /** The person holds the keyboard of that pane's run. */
  readonly attached: boolean;
  /** Someone else holds it. */
  readonly taken: boolean;
  readonly zoomed: boolean;
  readonly tab?: { readonly kind: "task" | "shell"; readonly runId?: string | undefined; readonly panes: number } | undefined;
}

export interface WorkbenchCommand {
  /** The action's name: the `keys.<id>` option binds it. */
  readonly id: string;
  /** What the help and the menus call it. */
  label(ctx: CommandContext): string;
  /** The menus that list it, in this table's order. */
  readonly menu?: "pane" | "tab" | "tab-own" | undefined;
  /** A thin line above it in a menu. */
  readonly separator?: boolean | undefined;
  enabled?(ctx: CommandContext): boolean;
  /** Only listed when it applies (the two keyboard commands swap). */
  shown?(ctx: CommandContext): boolean;
}

const hasRun = (c: CommandContext) => c.pane?.runId !== undefined;

/**
 * Every command of the workbench, once: the keys run them (`keys.*`), the right-click menus list
 * the ones with a `menu`, and the help overlay lists them all with their keys.
 */
export const WORKBENCH_COMMANDS: readonly WorkbenchCommand[] = [
  {
    id: "attach",
    label: (c) => (c.pane?.asks ? "Answer here (take the keyboard)" : "Take the keyboard"),
    menu: "pane",
    shown: (c) => hasRun(c) && !c.attached,
    enabled: (c) => hasRun(c) && !c.taken,
  },
  {
    id: "release",
    label: () => "Give the keyboard back",
    menu: "pane",
    shown: (c) => !hasRun(c) || c.attached,
    enabled: hasRun,
  },
  { id: "zoom", label: (c) => (c.zoomed ? "Unzoom" : "Zoom"), menu: "pane" },
  { id: "splitRight", label: () => "Split right", menu: "pane" },
  { id: "splitDown", label: () => "Split down", menu: "pane" },
  { id: "copyMode", label: () => "Copy mode", menu: "pane" },
  { id: "plan", label: () => "Plan of the run", menu: "pane", separator: true, enabled: hasRun },
  { id: "changes", label: () => "Changes", menu: "pane", enabled: hasRun },
  { id: "editor", label: () => "Open in editor", menu: "pane" },
  { id: "taskFromHere", label: () => "New task from here…", menu: "pane" },
  {
    id: "closePane",
    label: () => "Close pane",
    menu: "pane",
    separator: true,
    enabled: (c) => c.pane?.role !== "conductor",
  },
  { id: "newShellTab", label: () => "New tab: shell", menu: "tab" },
  { id: "newTab", label: () => "New tab: tell the agent a task (it starts the run)…", menu: "tab" },
  { id: "backlog", label: () => "Backlog…", menu: "tab" },
  { id: "newShell", label: () => "New shell pane here", menu: "tab-own", separator: true },
  {
    id: "closeTab",
    label: (c) => (c.tab?.kind === "task" ? "Close tab (its panes; the worktree stays)" : "Close tab"),
    menu: "tab-own",
    enabled: (c) => !(c.tab?.kind === "shell" && c.tab.panes === 0),
  },
  { id: "focusLeft", label: () => "Focus the pane before" },
  { id: "focusRight", label: () => "Focus the pane after" },
  { id: "focusUp", label: () => "Focus the pane before" },
  { id: "focusDown", label: () => "Focus the pane after" },
  { id: "goto", label: () => "Go to a pane or a question" },
  { id: "nextWaiting", label: () => "Next tab that waits for you" },
  { id: "help", label: () => "This help" },
];

const NO_CONTEXT: CommandContext = { attached: false, taken: false, zoomed: false };

/** The items of a menu: the commands listed for it that apply, with their label and whether they can run. */
export function menuCommands(
  menus: readonly NonNullable<WorkbenchCommand["menu"]>[],
  ctx: CommandContext,
): { readonly id: string; readonly label: string; readonly separator: boolean; readonly disabled: boolean }[] {
  return WORKBENCH_COMMANDS.filter(
    (c) => c.menu !== undefined && menus.includes(c.menu) && (c.shown?.(ctx) ?? true),
  ).map((c) => ({
    id: c.id,
    label: c.label(ctx),
    separator: c.separator === true,
    disabled: !(c.enabled?.(ctx) ?? true),
  }));
}

/** A chord as a person presses it: `prefix+z` reads `ctrl+b z`; a bare chord reads as it is. */
export const chordText = (map: KeyMap, chord: string): string =>
  chord.startsWith("prefix+")
    ? `${map.prefix?.[0] ?? "prefix"} ${chord.slice("prefix+".length)}`
    : chord;

/** The first key of an action as a person presses it (`ctrl+b z`), for a menu item; none when unbound. */
export const keyLabel = (map: KeyMap, action: string): string | undefined => {
  const chord = map[action]?.[0];
  return chord === undefined ? undefined : chordText(map, chord);
};

/** A key that works on every screen, outside a field. */
export const SHELL_KEYS: readonly { readonly keys: string; readonly label: string }[] = [
  { keys: "?", label: "This help" },
  { keys: "g", label: "Next run that waits for you" },
  { keys: "n", label: "New session: talk to the agent that starts a task" },
  { keys: "esc", label: "Close a dialog, a menu or the runs drawer" },
  { keys: "o", label: "Inbox: open the session of the chosen question" },
  { keys: "↵", label: "Inbox: send the chosen answer" },
  { keys: "a / c", label: "Session: attach / release to the agent" },
  { keys: "t", label: "Session: terminal or events" },
  { keys: "e / d", label: "Session: open in the editor / the changes" },
];

/**
 * The help overlay's rows for the workbench: every bound command with all its keys as they are
 * pressed, in the table's order; a command with no key is left out.
 */
export function helpRows(map: KeyMap): { readonly id: string; readonly keys: string; readonly label: string }[] {
  const rows = [
    { id: "prefix", keys: (map.prefix ?? []).join(" / "), label: "The prefix: press it, then a key below" },
    ...WORKBENCH_COMMANDS.map((c) => ({
      id: c.id,
      keys: (map[c.id] ?? []).map((chord) => chordText(map, chord)).join(" / "),
      label: c.label(NO_CONTEXT),
    })),
  ];
  return rows.filter((r) => r.keys !== "");
}
