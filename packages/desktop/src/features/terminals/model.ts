/**
 * The Terminals (workbench): its tabs by repository and task, the split tree of panes, go-to, toasts and its commands.
 */
import type {
  Attention,
  InboxItem,
  PaneView,
  RunOverview,
  SplitNode,
  TabView,
  WorkspaceView,
} from "../../shared/api/api.ts";
import {
  type CommandContext,
  type KeyMap,
  WORKBENCH_COMMANDS,
  type WorkbenchCommand,
} from "../../shared/model/keys.ts";
import { type PaneShown, paneLabel, paneStateOf } from "../../shared/model/panes.ts";
import { type HostStatus, hostChoice } from "../../shared/model/runs.ts";

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
/**
 * The tree without some panes (a dead pane being replaced by Retry): a split that loses one side
 * is its other side; undefined when nothing is left.
 */
export function withoutPanes(
  node: SplitNode | undefined,
  hidden: ReadonlySet<string>,
): SplitNode | undefined {
  if (!node || hidden.size === 0) return node;
  if ("pane" in node) return hidden.has(node.pane) ? undefined : node;
  const a = withoutPanes(node.a, hidden);
  const b = withoutPanes(node.b, hidden);
  return a && b ? { ...node, a, b } : (a ?? b);
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
  /** A workspace's tab; a pane of a task has its place in the task instead (`task`, `path`). */
  readonly tab?: WorkbenchTab | undefined;
  /** Where the pane is in its task: `task › shop-api › mt-implementer-1`. */
  readonly path?: string | undefined;
  readonly task?: { readonly runId: string; readonly session?: string | undefined } | undefined;
  readonly label: string;
  readonly detail: string;
  readonly state: PaneShown | "question";
  readonly paneId?: string | undefined;
  /** A task's pane: its key in the task's views (its repository and id; terminals.ts `paneKey`). */
  readonly focusKey?: string | undefined;
  readonly questionId?: string | undefined;
}
/** The go-to picker's rows: every pane of every tab, then the open questions; filtered by state or text. */
export function gotoRows(
  repos: readonly WorkbenchRepo[],
  panes: readonly PaneView[],
  filter: GotoFilter,
  query: string,
  /** The panes of the tasks first, by their place in the task (terminals.ts `taskGotoRows`). */
  taskRows: readonly GotoRow[] = [],
): GotoRow[] {
  const q = query.trim().toLowerCase();
  const rows: GotoRow[] = [...taskRows];
  const inTasks = new Set(taskRows.map((r) => r.paneId));
  for (const repo of repos)
    for (const tab of repo.tabs) {
      for (const id of tab.panes) {
        const p = panes.find((x) => x.id === id);
        if (!p || inTasks.has(p.id)) continue;
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
    if (q !== "" && !`${r.label} ${r.detail} ${r.tab?.label ?? ""} ${r.path ?? ""}`.toLowerCase().includes(q))
      return false;
    switch (filter) {
      case "asks":
        return r.state === "asks" || r.state === "question";
      case "working":
        return r.state === "working";
      case "idle":
        return r.state === "idle";
      case "done":
        return r.state === "exited" || r.state === "finished";
      default:
        return true;
    }
  });
}
/** A run that waits for a person: it asks (on a card or in its terminal), or it escalated (F1). */
export const needsPerson = (r: Pick<RunOverview, "attention">): boolean =>
  r.attention === "you" || r.attention === "escalated";
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
/** The items of a menu: the commands listed for it that apply, with their label and whether they can run. */
export function menuCommands(
  menus: readonly NonNullable<WorkbenchCommand["menu"]>[],
  ctx: CommandContext,
): {
  readonly id: string;
  readonly label: string;
  readonly separator: boolean;
  readonly disabled: boolean;
}[] {
  return WORKBENCH_COMMANDS.filter(
    (c) => c.menu !== undefined && menus.includes(c.menu) && (c.shown?.(ctx) ?? true),
  ).map((c) => ({
    id: c.id,
    label: c.label(ctx),
    separator: c.separator === true,
    disabled: !(c.enabled?.(ctx) ?? true),
  }));
}
/** The workspace a pane sits in: the first part of its tab's id (`w2:t1` is in `w2`). */
export const workspaceOfPane = (pane: { readonly tab: string }): string => pane.tab.split(":")[0] ?? "";
/** A question in one line: "<who> asks: <prompt>", unless the prompt already starts with who asks. */
export const askText = (who: string, prompt: string): string =>
  prompt.startsWith(`${who} `) ? prompt : `${who} asks: ${prompt}`;
