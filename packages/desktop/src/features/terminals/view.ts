/**
 * What the Terminals screen shows (ADR-0113), computed from the daemon's state and what the screen
 * chose: the view (a task, a session, every terminal, the workspaces' tabs), its panes before and
 * after the filter, and the tree they are laid out in. Pure: the screen's store keeps the result and
 * a part reads the one value it draws.
 */
import type { PaneView, SplitNode } from "../../shared/api/api.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import { repoLabel } from "../../shared/model/plan-flow.ts";
import {
  evenTree,
  type GotoRow,
  type WorkbenchRepo,
  type WorkbenchTab,
  withoutPanes,
  workbenchRepos,
} from "./model.ts";
import {
  finishedOf,
  paneKey,
  passes,
  type Session,
  sessionIn,
  sessionView,
  type TerminalFilter,
  type TerminalRow,
  type TerminalTask,
  taskGotoRows,
  taskView,
  terminalRows,
  terminalTasks,
  toContinue,
  whereIs,
} from "./terminals.ts";

/** A pane of the screen: a task's panes are in several repositories. */
export type TPane = PaneView & { readonly repo?: string | undefined };

export type TerminalsView = "task" | "session" | "all" | "tabs";

/** What the route asks the screen to show. */
export interface TerminalsRoute {
  /** A task's terminals, and one of its sessions (the route's `task`, `session`). */
  readonly task?: string | undefined;
  readonly session?: string | undefined;
  /** The workspaces' tabs were asked for (`#/grid/workspaces`, a workspace group). */
  readonly group?: string | undefined;
  /** A pane to show first (from the plan screen): its tab is selected and it gets the focus. */
  readonly showPane?: string | undefined;
}

/** The daemon's state the view is made from. */
export type ViewDaemon = Pick<
  Daemon,
  "runs" | "panes" | "panesOf" | "repo" | "repos" | "systemPlans" | "workspaces"
>;

export interface ViewInput {
  readonly daemon: ViewDaemon;
  readonly route: TerminalsRoute;
  readonly repoId: string | undefined;
  readonly tabKey: string | undefined;
  readonly filter: TerminalFilter;
  /** Dead panes a Retry is replacing (by key): not drawn. */
  readonly retiring: readonly string[];
}

export interface WorkbenchModel {
  readonly view: TerminalsView;
  /** The repository this screen shows (D10): the one chosen in a folder, the daemon's own otherwise. */
  readonly repoName: string | undefined;
  readonly repos: readonly WorkbenchRepo[];
  readonly repo: WorkbenchRepo | undefined;
  readonly tab: WorkbenchTab | undefined;
  /** This repository's panes: in a folder two repositories may use the same pane ids. */
  readonly panes: readonly TPane[];
  readonly tasks: readonly TerminalTask[];
  readonly chosen: TerminalTask | undefined;
  readonly session: Session | undefined;
  /** Every terminal of every task as rows (round 22). */
  readonly rows: readonly TerminalRow[];
  /** The rows of the view's panes (a task's or a session's tiles). */
  readonly viewRows: readonly TerminalRow[];
  /** The folder's repositories, so each takes a hue of its own. */
  readonly folderRepos: readonly string[];
  /** The panes the view holds before the filter, and their keys. */
  readonly viewPanes: readonly TPane[];
  readonly viewKeys: readonly string[];
  /** The panes drawn: the filter and a Retry applied; and their keys. */
  readonly tabPanes: readonly TPane[];
  readonly keys: readonly string[];
  readonly tree: SplitNode | undefined;
  readonly gotoTaskRows: readonly GotoRow[];
  /** The ended panes "Close finished (N)" closes: a task's all, a session's, a tab's. */
  readonly endedHere: readonly TPane[];
  /** When it was made: what a terminal does (working, idle) is as of then. */
  readonly now: number;
  /** What Continue task would start again. */
  readonly pending: { readonly paused: number; readonly undriven: number };
}

/**
 * A pane's key on the screen: its id in a tab (one repository), its repository and id in a task's
 * views, where two repositories' panes may have the same id.
 */
export const keyIn = (view: TerminalsView, p: TPane): string => (view === "tabs" ? p.id : paneKey(p));

export function workbenchModel(
  { daemon: d, route, repoId, tabKey, filter, retiring }: ViewInput,
  now: number = Date.now(),
): WorkbenchModel {
  const repoName = d.repo;
  const panes = d.panesOf(repoName);
  const workspaces = d.workspaces.filter((w) => (w.repo ?? "") === (repoName ?? ""));
  const repos = workbenchRepos(workspaces, d.runs, repoName ?? "this repository");
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  const tab = repo?.tabs.find((t) => t.key === tabKey) ?? repo?.tabs[0];
  // Terminals by task (terminals.ts): every repository's panes, since a task spans repositories.
  const plans = d.systemPlans;
  const tasks = terminalTasks(
    d.runs,
    d.panes,
    (runId) => plans.flatMap((pl) => pl.steps).find((st) => st.run === runId)?.id,
  );
  const { task: taskKey, session: sessionKey, group, showPane } = route;
  const located = showPane ? whereIs(tasks, showPane) : undefined;
  const chosen =
    tasks.find((t) => t.runId === taskKey) ??
    located?.task ??
    (!taskKey && !group && !showPane && tasks.length === 1 ? tasks[0] : undefined);
  const sessionId = sessionKey ?? located?.session;
  const session = chosen && sessionId ? sessionIn(chosen, sessionId) : undefined;
  // With no task chosen, every terminal at once (round 22): `#/grid/all` (and the old `#/grid/tasks`).
  const view: TerminalsView = session
    ? "session"
    : chosen
      ? "task"
      : group === "tasks" || group === "all"
        ? "all"
        : group || showPane || tasks.length === 0
          ? "tabs"
          : "all";
  const rows = terminalRows(tasks, now);
  const rowOf = (key: string) => rows.find((r) => r.key === key);
  const keyOf = (p: TPane) => keyIn(view, p);
  const hidden = new Set(retiring);
  const viewPanes: readonly TPane[] =
    view === "session" && session
      ? sessionView(session)
      : view === "task" && chosen
        ? taskView(chosen)
        : view === "all"
          ? rows.map((r) => r.pane)
          : (tab?.panes ?? []).map((id) => panes.find((p) => p.id === id)).filter((p): p is TPane => !!p);
  const tabPanes = viewPanes.filter((p) => {
    if (hidden.has(keyOf(p))) return false;
    if (view === "tabs") return true;
    const r = rowOf(keyOf(p));
    return r === undefined || passes(r, filter);
  });
  const keys = tabPanes.map(keyOf);
  const tree =
    view === "tabs"
      ? tab
        ? withoutPanes(tab.tree ?? evenTree(tab.panes), hidden)
        : undefined
      : evenTree(keys);
  return {
    view,
    repoName,
    repos,
    repo,
    tab,
    panes,
    tasks,
    chosen,
    session,
    rows,
    viewRows: viewPanes.map((p) => rowOf(keyOf(p))).filter((r): r is TerminalRow => r !== undefined),
    folderRepos: d.repos.map((p) => repoLabel(p.name)),
    viewPanes,
    viewKeys: viewPanes.map(keyOf),
    tabPanes,
    keys,
    tree,
    gotoTaskRows: taskGotoRows(tasks),
    endedHere:
      chosen && view !== "tabs" ? finishedOf(chosen, session) : tabPanes.filter((p) => p.ended !== undefined),
    now,
    pending: chosen ? toContinue(chosen, d.runs) : { paused: 0, undriven: 0 },
  };
}

/** A drawn pane by its key. */
export const paneAt = (m: WorkbenchModel, key: string | undefined): TPane | undefined =>
  key === undefined ? undefined : m.tabPanes[m.keys.indexOf(key)];

/** A terminal's row by its key. */
export const rowAt = (m: WorkbenchModel, key: string | undefined): TerminalRow | undefined =>
  key === undefined ? undefined : m.rows.find((r) => r.key === key);

/** The key of the focused pane: the one chosen while it is drawn, else the first. */
export const focusIn = (m: WorkbenchModel, focus: string | undefined): string | undefined =>
  focus !== undefined && m.keys.includes(focus) ? focus : m.keys[0];
