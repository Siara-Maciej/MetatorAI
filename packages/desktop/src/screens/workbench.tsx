/**
 * The workbench (S6, design/13 §5b; task-first since round 8): terminals over MetatorAI's runs.
 * A task's view shows its main terminal (where the person gave the task, else its conductor)
 * and one tile per repository session working on it, side by side; a session's own view shows
 * its conductor and its sub-terminals (workers), with "Task › repository" back. Ended panes stay,
 * read-only, with what ended them, until a person closes them. With no task chosen it lists the
 * tasks; "Workspaces" is the daemon's workspaces and tabs as before (shells, a new run's chat).
 * Everything else is a command: a key after the prefix, or an item of a right-click menu
 * (model.ts `WORKBENCH_COMMANDS`). The daemon owns the layout; this screen only draws and asks.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PaneView, SplitNode } from "../api.ts";
import { Notice, RepoSelect } from "../components/common.tsx";
import { ContextMenu, type MenuItem } from "../components/context-menu.tsx";
import { DebugChanges } from "../components/debug-changes.tsx";
import { Glyph } from "../components/glyph.tsx";
import { GotoPicker } from "../components/goto.tsx";
import { PaneFrame } from "../components/pane-frame.tsx";
import { QuestionToast } from "../components/question-toast.tsx";
import { SplitGrid } from "../components/split-grid.tsx";
import { StageBar } from "../components/stage-bar.tsx";
import { Tabs } from "../components/tabs.tsx";
import type { TerminalHandle } from "../components/terminal.tsx";
import { RepoMark, TerminalFilters } from "../components/terminal-filters.tsx";
import { TerminalTree } from "../components/terminal-tree.tsx";
import { useDaemon } from "../daemon.tsx";
import { runControls, useAction, useKeptFlag, useOption } from "../hooks.ts";
import {
  actionOf,
  type CommandContext,
  chordOf,
  closesWorkspace,
  decisionKey,
  evenTree,
  type GotoRow,
  type KeyMap,
  keyLabel,
  keyMapOf,
  keyText,
  lookOf,
  menuCommands,
  needsPerson,
  neighborPane,
  nextWaitingTab,
  noHostText,
  notifies,
  paneLabel,
  paneNeedsYou,
  paneStateOf,
  repoOfTab,
  retryHost,
  routeHash,
  tabOfPane,
  tabOfRun,
  toastOf,
  type WorkbenchCommand,
  type WorkbenchRepo,
  type WorkbenchTab,
  withoutPanes,
  workbenchRepos,
  workspaceOfPane,
} from "../model.ts";
import { repoLabel } from "../plan-flow.ts";
import { useHostEditor } from "../repos-context.tsx";
import {
  continueText,
  finishedOf,
  groupRows,
  paneKey,
  passes,
  repoMark,
  rowsBelow,
  type Session,
  sessionIn,
  sessionView,
  showing,
  subBadge,
  type TerminalFilter,
  type TerminalGrouping,
  type TerminalRow,
  type TerminalTask,
  taskGotoRows,
  taskView,
  terminalRows,
  terminalTasks,
  terminalViewFromStorage,
  toContinue,
  toggleHidden,
  toggleTaskHidden,
  whereIs,
} from "../terminals.ts";

/** What the keys mean right now: one thing at a time. */
type Mode =
  | { readonly kind: "none" }
  /** The prefix was pressed: the next chord is a command. */
  | { readonly kind: "prefix" }
  /** "Take the keyboard?" on a pane: Enter says yes, Escape no. */
  | { readonly kind: "ask"; readonly pane: string }
  | { readonly kind: "copy"; readonly pane: string }
  | { readonly kind: "goto" }
  | {
      readonly kind: "menu";
      readonly x: number;
      readonly y: number;
      readonly items: readonly MenuItem[];
      readonly label: string;
    };

const IDLE: Mode = { kind: "none" };

const TERMINALS_STORE = "metator.terminals";
type TerminalView = ReturnType<typeof terminalViewFromStorage>;
function readTerminalView(): TerminalView {
  try {
    return terminalViewFromStorage(window.localStorage.getItem(TERMINALS_STORE));
  } catch {
    return terminalViewFromStorage(null);
  }
}
function saveTerminalView(v: TerminalView): TerminalView {
  try {
    window.localStorage.setItem(TERMINALS_STORE, JSON.stringify(v));
  } catch {
    // A window without storage keeps the filter until it closes.
  }
  return v;
}

export function WorkbenchScreen({
  onNewTask,
  onOpenSettings,
  onOpenPlan,
  onOpenReview,
  onOpenInbox,
  onOpenBacklog,
  onHelp,
  showPane,
  task: taskKey,
  session: sessionKey,
  group,
}: {
  /** A task's terminals, and one of its sessions (the route's `task`, `session`). */
  readonly task?: string | undefined;
  readonly session?: string | undefined;
  /** The workspaces' tabs were asked for (`#/grid/workspaces`, a workspace group). */
  readonly group?: string | undefined;
  /** Opens a tab with the agent that starts a task: the person says what to do, the agent starts the run. */
  onNewTask(): void;
  onOpenSettings(): void;
  onOpenPlan(runId: string): void;
  /** The run's change with the notes on it (S5). */
  onOpenReview(runId: string): void;
  /** The decision card of a question (`<run>/<question>`) in the Inbox. */
  onOpenInbox(pick: string): void;
  /** The backlog; with a draft, its form opens for a task that points at a pane's run. */
  onOpenBacklog(draft?: {
    readonly title?: string;
    readonly refs?: readonly { run?: string; step?: string }[];
  }): void;
  /** The keys of the app, as an overlay. */
  onHelp(): void;
  /** A pane to show first (from the plan screen): its tab is selected and it gets the focus. */
  readonly showPane?: string | undefined;
}) {
  const d = useDaemon();
  const { client, runs, inbox, me, options } = d;
  // The repository this screen shows (D10): the one chosen in a folder, the daemon's own otherwise.
  const repoName = d.repo;
  // In a folder two repositories may use the same pane ids, so only this repository's count.
  const panes = d.panesOf(repoName);
  const workspaces = useMemo(
    () => d.workspaces.filter((w) => (w.repo ?? "") === (repoName ?? "")),
    [d.workspaces, repoName],
  );
  const keymap: KeyMap = useMemo(() => keyMapOf(options), [options]);
  const repos: WorkbenchRepo[] = useMemo(
    () => workbenchRepos(workspaces, runs, repoName ?? "this repository"),
    [workspaces, runs, repoName],
  );
  const [repoId, setRepoId] = useState<string>();
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  const [tabKey, setTabKey] = useState<string>();
  const tab: WorkbenchTab | undefined = repo?.tabs.find((t) => t.key === tabKey) ?? repo?.tabs[0];
  // Terminals by task (terminals.ts): every repository's panes, since a task spans repositories.
  const plans = d.systemPlans;
  const tasks: TerminalTask[] = useMemo(
    () =>
      terminalTasks(
        runs,
        d.panes,
        (runId) => plans.flatMap((pl) => pl.steps).find((st) => st.run === runId)?.id,
      ),
    [runs, d.panes, plans],
  );
  const located = showPane ? whereIs(tasks, showPane) : undefined;
  const chosen =
    tasks.find((t) => t.runId === taskKey) ??
    located?.task ??
    (!taskKey && !group && !showPane && tasks.length === 1 ? tasks[0] : undefined);
  const session: Session | undefined =
    chosen && (sessionKey ?? located?.session)
      ? sessionIn(chosen, (sessionKey ?? located?.session) as string)
      : undefined;
  // With no task chosen, every terminal at once (round 22): `#/grid/all` (and the old `#/grid/tasks`).
  const view: "task" | "session" | "all" | "tabs" = session
    ? "session"
    : chosen
      ? "task"
      : group === "tasks" || group === "all"
        ? "all"
        : group || showPane || tasks.length === 0
          ? "tabs"
          : "all";
  // Every terminal of every task as rows (round 22): repository, role, state and parent each.
  const rows: TerminalRow[] = useMemo(() => terminalRows(tasks), [tasks]);
  const rowOf = (key: string | undefined) => rows.find((r) => r.key === key);
  // The folder's repositories, so each takes a hue of its own.
  const folderRepos = useMemo(() => d.repos.map((p) => repoLabel(p.name)), [d.repos]);
  // The filter and the grouping are the window's (kept in its storage, read under try/catch).
  const [kept, keep] = useState(readTerminalView);
  // The tree of terminals folded to its narrow version, kept by the window.
  const [treeNarrow, setTreeNarrow] = useKeptFlag("metator.terminals.tree.narrow", false);
  const filter = kept.filter;
  const grouping = kept.grouping;
  const setFilter = (f: TerminalFilter) => keep((k) => saveTerminalView({ ...k, filter: f }));
  const setGrouping = (g: TerminalGrouping) => keep((k) => saveTerminalView({ ...k, grouping: g }));
  /**
   * A pane's key on this screen: its id in a tab (one repository), its repository and id in a
   * task's views, where two repositories' panes may have the same id.
   */
  const keyOf = (p: PaneView & { readonly repo?: string | undefined }) =>
    view === "tabs" ? p.id : paneKey(p);
  // Dead panes a Retry is replacing (by key): not drawn from the click on, so the old pane and its
  // replacement are never on the screen together (the daemon opens one, then closes the other).
  const [retiring, setRetiring] = useState<ReadonlySet<string>>(new Set());
  /** The panes a by-task view holds before the filter: a session's, a task's, or every terminal. */
  const viewPanes: (PaneView & { readonly repo?: string | undefined })[] =
    view === "session" && session
      ? sessionView(session)
      : view === "task" && chosen
        ? taskView(chosen)
        : view === "all"
          ? rows.map((r) => r.pane)
          : (tab?.panes ?? []).map((id) => panes.find((p) => p.id === id)).filter((p): p is PaneView => !!p);
  const tabPanes = viewPanes.filter((p) => {
    if (retiring.has(keyOf(p))) return false;
    if (view === "tabs") return true;
    const r = rowOf(keyOf(p));
    return r === undefined || passes(r, filter);
  });
  const byKey = (key: string | undefined) => tabPanes.find((p) => keyOf(p) === key);
  const tree: SplitNode | undefined =
    view === "tabs"
      ? tab
        ? withoutPanes(tab.tree ?? evenTree(tab.panes), retiring)
        : undefined
      : evenTree(tabPanes.map(keyOf));
  /** The repository a pane is in (a task's panes are in several). */
  const repoOf = (p: PaneView | undefined) => (p as { repo?: string } | undefined)?.repo ?? repoName;
  const [focus, setFocus] = useState<string>();
  /** Shows a tab, in the sidebar entry it sits under, with one of its panes focused. */
  const showTab = (t: WorkbenchTab, paneId?: string) => {
    setRepoId(repoOfTab(repos, t.key)?.id);
    setTabKey(t.key);
    if (paneId) setFocus(paneId);
  };
  // A pane asked for by the route: once the layout knows it, its tab and focus.
  const shown = useRef<string | undefined>(undefined);
  if (showPane && shown.current !== showPane) {
    const t = tabOfPane(repos, showPane);
    if (t) {
      shown.current = showPane;
      showTab(t, showPane);
    }
  }
  const focused = byKey(focus) ?? tabPanes[0];
  const focusKey = focused ? keyOf(focused) : undefined;
  // A terminal gone to from a link (↑ parent, ? asks, the tree, a new terminal's Show): it flashes
  // for a moment, is scrolled to and gets the keyboard (round 22).
  const [flash, setFlash] = useState<string>();
  const [scrollTo, setScrollTo] = useState<string>();
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const goTo = (key: string, flashIt = false) => {
    const r = rowOf(key);
    if (!r) return;
    if (!passes(r, filter)) setFilter(showing(filter, r));
    // Not a tile of this view (a sub-terminal on a task's view): the All view has every terminal.
    if (view !== "all" && !viewPanes.some((p) => keyOf(p) === key))
      window.location.hash = routeHash({ screen: "grid", group: "all" });
    if (zoom && zoom !== key) setZoom(undefined);
    setFocus(key);
    setScrollTo(key);
    if (flashIt) {
      setFlash(key);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(undefined), 3000);
    }
  };
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.querySelector(`[data-tile="${CSS.escape(scrollTo)}"]`);
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    handles.current.get(scrollTo)?.focus();
    setScrollTo(undefined);
  });
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  // Terminals that appear while the screen is open (an agent started a worker): marked new for a
  // while, the newest said in a toast with Show (round 22). Those there at the start are not new.
  const known = useRef<Set<string> | undefined>(undefined);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [freshToast, setFreshToast] = useState<TerminalRow>();
  useEffect(() => {
    // Known from the first answer that has terminals: before it, nothing is drawn to be new to.
    if (!known.current) {
      if (rows.length > 0) known.current = new Set(rows.map((r) => r.key));
      return;
    }
    const seen = known.current;
    const added = rows.filter((r) => !seen.has(r.key));
    if (added.length === 0) return;
    for (const r of added) seen.add(r.key);
    const keys = added.map((r) => r.key);
    setFresh((now) => new Set([...now, ...keys]));
    setFreshToast(added[added.length - 1]);
    setTimeout(() => setFresh((now) => new Set([...now].filter((k) => !keys.includes(k)))), 8000);
  }, [rows]);
  const [zoom, setZoom] = useState<string>();
  // The zoom is the tab's: a tab change drops it.
  const zoomTab = useRef<string | undefined>(undefined);
  if (zoomTab.current !== tab?.key) {
    zoomTab.current = tab?.key;
    if (zoom) setZoom(undefined);
  }
  const [mode, setMode] = useState<Mode>(IDLE);
  const action = useAction();
  const handles = useRef(new Map<string, TerminalHandle>());
  const run = tab?.run;
  const runOf = (p: PaneView | undefined) => d.run(p?.runId, repoOf(p));
  // A repository in a dev container opens VS Code on this computer, attached to it (round 21).
  const hostEditor = useHostEditor();
  const controlsOf = (p: PaneView | undefined) => runControls(client, action, me, runOf(p), hostEditor);
  /** A shell takes anyone's keys; an agent's pane of a run only its attached person's. */
  const canType = (p: PaneView) => !p.runId || p.role === "shell" || controlsOf(p).attached;
  const confirmClose = useOption("ui.confirmClosePane", true);
  const attachOnType = useOption<"ask" | "always" | "never">("ui.attachOnType", "ask");
  const borders = useOption<"auto" | "always" | "off">("ui.paneBorders", "auto");
  const labels = useOption("ui.paneLabels", true);
  const symbols = useOption<"dots" | "symbols">("ui.statusIndicators", "symbols") === "symbols";
  const scrollback = useOption("terminal.scrollbackLines", 5000);
  const attach = async (p: PaneView) => {
    await controlsOf(p).attach();
    setFocus(keyOf(p));
    handles.current.get(keyOf(p))?.focus();
  };
  /** A request whose answer is a pane: the pane gets the focus. */
  const opening = async (fn: () => ReturnType<typeof client.openPane>, refused?: string) => {
    let id: string | undefined;
    await action.run(
      async () => {
        const r = await fn();
        id = r.data?.id;
        return r;
      },
      refused ? { refused } : {},
    );
    if (id) setFocus(id);
    return id;
  };
  const closeTab = async (t: WorkbenchTab, ask = true) => {
    if (ask && !window.confirm(`Close ${t.label} and its ${t.panes.length} pane(s)?`)) return;
    if (closesWorkspace(repos, t)) {
      await action.run(() => client.closeWorkspace(t.workspaceId, repoName));
      return;
    }
    for (const id of t.panes) await action.run(() => client.closePane(id, repoName));
  };
  /**
   * A pane whose process ended, started again (D1): a run's conductor is resumed in place; any
   * other pane gets a new one beside it with the same program, and the dead one goes.
   */
  const retryPane = async (p: PaneView) => {
    if (p.role === "conductor" && p.runId) {
      const runId = p.runId;
      await action.run(() => client.ptyOpen(runId, repoName), { refused: "The session did not start" });
      return;
    }
    const key = keyOf(p);
    const retire = (on: boolean) =>
      setRetiring((now) => {
        const next = new Set(now);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      });
    retire(true);
    let process: { argv: string[] } | { host: string; agent: string; prompt: string };
    if (p.process.kind === "command") process = { argv: [...p.process.argv] };
    else {
      // The host the pane had, when it is installed; else the first installed one of the order.
      const s = await client.supervisor(repoName);
      const host = retryHost(p.process.host, s.data?.policy.hostOrder ?? [], s.data?.hostStatus);
      if (!host) {
        retire(false);
        action.say(noHostText(s.data?.hostStatus ?? []));
        return;
      }
      process = { host, agent: p.process.agent, prompt: p.process.prompt };
    }
    const id = await opening(
      () =>
        client.openPane(
          { workspace: workspaceOfPane(p), tab: p.tab, role: p.role, label: p.label, ...process },
          repoName,
        ),
      "The pane did not start",
    );
    if (!id) {
      retire(false);
      return;
    }
    const closed = await client.closePane(p.id, repoName);
    // Still there: it is drawn again, with what the daemon said.
    if (!closed.ok) {
      retire(false);
      action.say(closed.error?.message ?? "the pane was not closed");
    }
  };
  /**
   * What every command does (model.ts `WORKBENCH_COMMANDS` names them): the keys, the two
   * right-click menus and the buttons of this screen all run these, on the focused pane or on the
   * one under the menu.
   */
  const commands: Record<string, (p: PaneView | undefined, t: WorkbenchTab | undefined) => void> = {
    attach: (p) => p && void attach(p),
    release: (p) => void controlsOf(p).release(),
    zoom: (p) => setZoom((z) => (z || !p ? undefined : keyOf(p))),
    splitRight: (p) => p && void opening(() => client.splitPane(p.id, "right", repoName)),
    splitDown: (p) => p && void opening(() => client.splitPane(p.id, "down", repoName)),
    copyMode: (p) => p && setMode({ kind: "copy", pane: keyOf(p) }),
    plan: (p, t) => {
      const runId = p?.runId ?? t?.runId;
      if (runId) onOpenPlan(runId);
    },
    changes: (p, t) => {
      const runId = p?.runId ?? t?.runId;
      if (runId) onOpenReview(runId);
    },
    /** The editor on a pane's directory, or on the tab's run (its worktree). */
    editor: (p, t) => {
      const runId = t?.runId;
      if (p)
        void action.run(hostEditor?.({ cwd: p.cwd }) ?? (() => client.openPaneEditor(p.id, repoName)), {
          done: "opened in the editor",
        });
      else if (runId)
        void action.run(
          hostEditor?.({ worktree: d.run(runId, repoName)?.worktree?.path }) ??
            (() => client.openEditor(runId, {}, repoName)),
          { done: "opened in the editor" },
        );
    },
    taskFromHere: (p) => onOpenBacklog(p?.runId ? { refs: [{ run: p.runId }] } : {}),
    closePane: (p) => {
      if (!p) return;
      if (confirmClose && p.live?.alive && !p.ended && !window.confirm(`Close ${paneLabel(p)} (${p.id})?`))
        return;
      void action.run(() => client.closePane(p.id, repoOf(p)));
    },
    newShellTab: () => {
      if (!repo) return;
      void action.run(() =>
        client.openPane(
          {
            ...(repo.id === "repo" ? {} : { workspace: repo.id }),
            label: "shell",
            role: "shell",
            newTab: true,
          },
          repoName,
        ),
      );
    },
    newTab: () => onNewTask(),
    backlog: () => onOpenBacklog(),
    newShell: (_p, t) =>
      t &&
      void opening(() =>
        client.openPane({ workspace: t.workspaceId, tab: t.tabId, role: "shell", label: "shell" }, repoName),
      ),
    closeTab: (_p, t) => t && void closeTab(t),
    focusLeft: (p) => setFocus(neighborPane(tree, p && keyOf(p), -1)),
    focusUp: (p) => setFocus(neighborPane(tree, p && keyOf(p), -1)),
    focusRight: (p) => setFocus(neighborPane(tree, p && keyOf(p), 1)),
    focusDown: (p) => setFocus(neighborPane(tree, p && keyOf(p), 1)),
    goto: () => setMode({ kind: "goto" }),
    nextWaiting: () => {
      const next = nextWaitingTab(repos, tab?.key);
      if (next) showTab(next);
    },
    help: () => onHelp(),
  };
  const contextOf = (p: PaneView | undefined, t: WorkbenchTab | undefined): CommandContext => {
    const c = controlsOf(p);
    return {
      pane: p ? { runId: p.runId, role: p.role, asks: paneStateOf(p) === "asks" } : undefined,
      attached: c.attached,
      taken: c.taken,
      zoomed: p !== undefined && zoom === keyOf(p),
      tab: t ? { kind: t.kind, runId: t.runId, panes: t.panes.length } : undefined,
    };
  };
  const openMenu = (
    e: React.MouseEvent,
    menus: readonly NonNullable<WorkbenchCommand["menu"]>[],
    p: PaneView | undefined,
    t: WorkbenchTab | undefined,
    label: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (p) setFocus(keyOf(p));
    const items: MenuItem[] = menuCommands(menus, contextOf(p, t)).map((c) => ({
      label: c.label,
      key: keyLabel(keymap, c.id),
      separator: c.separator,
      disabled: c.disabled,
      onSelect: () => commands[c.id]?.(p, t),
    }));
    setMode({ kind: "menu", x: e.clientX, y: e.clientY, items, label });
  };
  const tabMenu = (e: React.MouseEvent, t: WorkbenchTab | undefined) =>
    openMenu(e, t ? ["tab", "tab-own"] : ["tab"], undefined, t, t ? `tab ${t.label}` : "tabs");
  const pick = (row: GotoRow) => {
    setMode(IDLE);
    if (row.task) {
      window.location.hash = routeHash({ screen: "grid", task: row.task.runId, session: row.task.session });
      if (row.focusKey ?? row.paneId) setFocus(row.focusKey ?? row.paneId);
      return;
    }
    const t = row.tab;
    if (!t) return;
    showTab(t, row.paneId ?? panes.find((p) => p.runId === t.runId && p.role === "conductor")?.id);
  };
  const gotoTaskRows = useMemo(() => taskGotoRows(tasks), [tasks]);
  /** The ended panes "Close finished (N)" closes: a task's all, a session's, a tab's. */
  const endedHere =
    chosen && view !== "tabs" ? finishedOf(chosen, session) : tabPanes.filter((p) => p.ended !== undefined);
  // Continue (round 11): the whole task, or one paused pane, started again where it stopped.
  const continueThe = async (
    what: { readonly runId: string } | { readonly paneId: string },
    repo: string | undefined,
  ) => {
    let said: string | undefined;
    await action.run(
      async (by) => {
        const r =
          "runId" in what
            ? await client.continueRun(what.runId, by, repo)
            : await client.continuePane(what.paneId, by, repo);
        if (r.ok && r.data) said = continueText(r.data);
        return r;
      },
      { who: true, refused: "Nothing was continued" },
    );
    if (said) action.say(said, "info");
  };
  /** A paused pane's own Continue: only that pane (`POST /panes/:pane/continue`). */
  const continuePane = (p: PaneView) => void continueThe({ paneId: p.id }, repoOf(p));
  const pending = chosen ? toContinue(chosen, runs) : { paused: 0, undriven: 0 };
  const continueTask = (where: "bar" | "tile") =>
    chosen && view !== "tabs" && pending.paused + pending.undriven > 0 ? (
      <button
        type="button"
        className="primary"
        data-testid={where === "bar" ? "continue-task" : "continue-task-tile"}
        title={`${pending.paused} paused terminal(s), ${pending.undriven} run(s) nothing drives`}
        onClick={() => void continueThe({ runId: chosen.runId }, chosen.repo)}
      >
        Continue task
      </button>
    ) : null;
  const closeFinished = async () => {
    for (const p of endedHere) await action.run(() => client.closePane(p.id, repoOf(p)));
  };
  // One toast: the newest question of the tabs shown here (notify.channel app) that the person
  // has not closed.
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const toast = toastOf(inbox, repos, dismissed, notifies(options));
  const openToast = () => {
    if (!toast) return;
    // The host's own prompt is answered in its pane; every other question on its card.
    if (toast.question.source !== "permission") {
      onOpenInbox(decisionKey(toast));
      return;
    }
    const conductor = panes.find((p) => p.runId === toast.runId && p.role === "conductor");
    const t = tabOfRun(repos, toast.runId);
    if (t) showTab(t);
    if (conductor) void attach(conductor);
  };
  const blockedKey = (p: PaneView) => {
    if (attachOnType === "never") return;
    if (attachOnType === "always") void attach(p);
    else setMode({ kind: "ask", pane: keyOf(p) });
  };
  // Keys: the prefix, then one chord; the terminals' own keys are left alone otherwise.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const chord = chordOf(e);
      if (chord === "") return;
      // A dialog (the go-to picker, the help, the name) has the keys while it is open.
      if (mode.kind === "goto" || mode.kind === "menu" || document.querySelector("dialog[open]")) return;
      if (mode.kind === "ask") {
        if (chord === "enter") {
          const p = byKey(mode.pane) ?? panes.find((x) => x.id === mode.pane);
          setMode(IDLE);
          if (p) void attach(p);
        } else if (chord === "escape") setMode(IDLE);
        e.preventDefault();
        return;
      }
      if (mode.kind === "copy") {
        const h = handles.current.get(mode.pane);
        if (chord === "escape") {
          h?.clearSearch();
          setMode(IDLE);
          e.preventDefault();
        } else if (chord === "y" && !(e.target instanceof HTMLInputElement)) {
          const text = h?.copySelection();
          action.say(text ? `copied ${text.length} characters` : "nothing selected", "info");
          e.preventDefault();
        }
        return;
      }
      if (mode.kind === "none") {
        if (actionOf(keymap, chord, false) === "prefix") {
          e.preventDefault();
          e.stopPropagation();
          setMode({ kind: "prefix" });
          timer = setTimeout(() => setMode((m) => (m.kind === "prefix" ? IDLE : m)), 2000);
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setMode(IDLE);
      if (timer) clearTimeout(timer);
      const name = actionOf(keymap, chord, true);
      const command = name ? commands[name] : undefined;
      if (command) command(focused, tab);
      else action.say(name ? `${name}: not on this screen yet` : `no command for ${chord}`, "info");
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer) clearTimeout(timer);
    };
  });
  // A task's tiles have their own border and head: their frames draw none.
  const framed = view === "tabs" && (borders === "always" || (borders === "auto" && tabPanes.length > 1));
  const renderPane = (id: string): ReactNode => {
    const p = byKey(id);
    if (!p) return <div className="empty">pane {id}</div>;
    return (
      <PaneFrame
        pane={p}
        state={paneStateOf(p)}
        repo={repoOf(p)}
        focused={focused === p}
        framed={framed}
        labels={labels}
        symbols={symbols}
        mine={controlsOf(p).attached}
        canType={canType(p)}
        scrollback={scrollback}
        asking={mode.kind === "ask" && mode.pane === keyOf(p)}
        copying={mode.kind === "copy" && mode.pane === keyOf(p)}
        lastOfTab={view === "tabs" && tabPanes.length === 1}
        needsYou={paneNeedsYou({ id: p.id, repo: repoOf(p) }, d.paneAsks) || paneStateOf(p) === "asks"}
        onFocus={() => setFocus(keyOf(p))}
        onMenu={(e) => openMenu(e, ["pane"], p, tab, `pane ${p.id}`)}
        onZoom={() => setZoom(zoom === keyOf(p) ? undefined : keyOf(p))}
        onBlockedKey={() => blockedKey(p)}
        onReady={(h) => handles.current.set(keyOf(p), h)}
        onRetry={() => void retryPane(p)}
        onContinue={() => continuePane(p)}
        onClose={() =>
          view === "tabs" && tab && tabPanes.length === 1
            ? void closeTab(tab, false)
            : void action.run(() => client.closePane(p.id, repoOf(p)))
        }
      />
    );
  };
  const overlays = (
    <>
      {toast ? (
        <QuestionToast
          item={toast}
          onOpen={openToast}
          onDismiss={() => setDismissed([...dismissed, `${toast.runId}/${toast.question.id}`])}
        />
      ) : null}
      {mode.kind === "menu" ? (
        <ContextMenu at={mode} items={mode.items} label={mode.label} onClose={() => setMode(IDLE)} />
      ) : null}
      {mode.kind === "goto" ? (
        <GotoPicker
          repos={repos}
          panes={panes}
          taskRows={gotoTaskRows}
          onPick={pick}
          onClose={() => setMode(IDLE)}
        />
      ) : null}
    </>
  );
  const settingsButton = (
    <button type="button" className="ghost" onClick={onOpenSettings} title="settings" aria-label="settings">
      ⚙
    </button>
  );
  const prefixChip =
    mode.kind === "prefix" ? (
      <span className="chip teal" data-testid="prefix">
        {keymap.prefix?.[0] ?? "prefix"} …
      </span>
    ) : null;
  if (view !== "tabs") {
    const sessionOfPane = (p: PaneView) =>
      chosen ? [chosen.own, ...chosen.sessions].find((x) => x.pane === p) : undefined;
    const tile = (p: PaneView & { readonly repo?: string | undefined }) => {
      const key = keyOf(p);
      const row = rowOf(key);
      const main = view === "task" && chosen?.main === p;
      // On the task's view a tile is a repository session: its badge opens its own view. The main
      // terminal, when it is the task run's own conductor, opens the task run's session.
      const own = sessionOfPane(p) ?? (main && chosen?.main === chosen?.own.pane ? chosen?.own : undefined);
      const label =
        view === "all"
          ? (row?.name ?? paneLabel(p))
          : view === "session"
            ? p === session?.pane
              ? `${session?.label}: its main terminal`
              : "sub-terminal"
            : main
              ? chosen?.main?.startedRun
                ? "main terminal: where the task was given"
                : "main terminal: the task's conductor"
              : (own?.label ?? paneLabel(p));
      const badge = view === "task" && own ? subBadge(own) : undefined;
      const parent = rowOf(row?.parent);
      const below = row ? rowsBelow(rows, row.key) : [];
      const asking = below.filter((r) => r.state === "asks");
      const repoName = row?.repo ?? "this repository";
      return (
        <div
          key={key}
          className={`tile${main ? " main" : ""}${flash === key ? " flash" : ""}${fresh.has(key) ? " fresh" : ""}`}
          data-testid={`tile-${p.id}`}
          data-tile={key}
          data-repo={p.repo}
          style={{ "--repo": repoMark(repoName, folderRepos).hue } as React.CSSProperties}
        >
          <div className="tile-band">
            <RepoMark repo={repoName} known={folderRepos} />
            <span className="repo-name">{repoName}</span>
            <span className="role">{p.role}</span>
            <span className="spacer" />
            {main ? continueTask("tile") : null}
            {row ? (
              <span className={`tstate ${lookOf("pane", row.state).tone}`} data-testid={`state-${p.id}`}>
                <Glyph kind="pane" state={row.state} /> {row.state}
              </span>
            ) : null}
          </div>
          <div className="tile-head">
            {/* Where the terminal is, when its group does not say it already (grouped by task it does). */}
            {view === "all" && row && grouping !== "task" ? (
              <>
                <span className="lineage" title={row.task.title}>
                  {row.task.title}
                </span>
                <span className="faint">›</span>
              </>
            ) : null}
            <span className="tile-label">{label}</span>
            {parent ? (
              <button
                type="button"
                className="parent-link"
                data-testid={`parent-${p.id}`}
                title="show the terminal that started this one"
                onClick={() => goTo(parent.key, true)}
              >
                ↑ parent: {parent.name}
              </button>
            ) : null}
            {asking.length > 0 ? (
              <button
                type="button"
                className="asks-link"
                data-testid={`asks-${p.id}`}
                title={`show the terminal that asks${asking.length > 1 ? " (again: the next one)" : ""}`}
                onClick={() => {
                  const at = asking.findIndex((r) => r.key === focusKey);
                  const next = asking[(at + 1) % asking.length];
                  if (next) goTo(next.key, true);
                }}
              >
                ? {asking.length} asks ›
              </button>
            ) : null}
            {view === "task" && own && !main ? (
              <a
                className="ghost open-session"
                href={routeHash({ screen: "grid", task: chosen?.runId, session: own.runId })}
                data-testid={`open-session-${own.runId}`}
              >
                {badge ?? "its terminals"} ›
              </a>
            ) : view === "task" && own && badge ? (
              <a
                className="ghost open-session"
                href={routeHash({ screen: "grid", task: chosen?.runId, session: own.runId })}
                data-testid={`open-session-${own.runId}`}
              >
                {badge} ›
              </a>
            ) : view === "all" && below.length > 0 ? (
              <span className="faint below">{below.length} below</span>
            ) : null}
          </div>
          {renderPane(key)}
        </div>
      );
    };
    const shownTiles = zoom ? tabPanes.filter((p) => keyOf(p) === zoom) : tabPanes;
    const viewRows = viewPanes.map((p) => rowOf(keyOf(p))).filter((r): r is TerminalRow => r !== undefined);
    const groups =
      view === "all"
        ? groupRows(
            zoom ? rows.filter((r) => r.key === zoom) : rows.filter((r) => passes(r, filter)),
            grouping,
          )
        : [];
    const tiles = (list: readonly TerminalRow[]) =>
      list.length > 0 ? <div className="task-tiles flow">{list.map((r) => tile(r.pane))}</div> : null;
    return (
      <section
        className="workbench by-task"
        aria-label="Terminals"
        data-testid="workbench"
        data-zoom-key={keymap.zoom?.[0]}
      >
        <nav className="terminals-bar" aria-label="where in Terminals" data-testid="terminals-bar">
          <a href={routeHash({ screen: "grid", group: "all" })} data-testid="terminals-all">
            All terminals
          </a>
          {chosen ? (
            <>
              <span className="faint">›</span>
              {session ? (
                <a
                  href={routeHash({ screen: "grid", task: chosen.runId })}
                  data-testid="terminals-task"
                  title={chosen.title}
                >
                  {chosen.title}
                </a>
              ) : (
                <strong data-testid="terminals-task" title={chosen.title}>
                  {chosen.title}
                </strong>
              )}
            </>
          ) : null}
          {session ? (
            <>
              <span className="faint">›</span>
              <strong data-testid="terminals-session">{session.label}</strong>
            </>
          ) : null}
          <span className="spacer" />
          {continueTask("bar")}
          {chosen ? (
            <DebugChanges
              repos={[chosen.repo, ...chosen.sessions.map((x) => x.repo)].filter(
                (r, i, all) => all.indexOf(r) === i,
              )}
            />
          ) : null}
          {endedHere.length > 0 ? (
            <button type="button" data-testid="close-finished" onClick={() => void closeFinished()}>
              Close finished ({endedHere.length})
            </button>
          ) : null}
          <a
            href={routeHash({ screen: "grid", group: "workspaces" })}
            title="every workspace and its tabs: shells, a new run's chat"
          >
            Workspaces
          </a>
          {prefixChip}
          {settingsButton}
        </nav>
        <Notice {...action.notice} tone={action.notice.text ? action.notice.tone : "info"} />
        <TerminalFilters
          rows={view === "all" ? rows : viewRows}
          filter={filter}
          onFilter={setFilter}
          known={folderRepos}
          grouping={view === "all" ? grouping : undefined}
          onGrouping={view === "all" ? setGrouping : undefined}
        />
        <div className={`terminals-body${treeNarrow ? " tree-narrow" : ""}`}>
          <TerminalTree
            onEye={(k) => setFilter(toggleHidden(filter, rows, k))}
            onTaskEye={(id) => setFilter(toggleTaskHidden(filter, rows, id))}
            narrow={treeNarrow}
            onNarrow={setTreeNarrow}
            known={folderRepos}
            rows={rows}
            filter={filter}
            focused={focusKey}
            fresh={fresh}
            onPick={(k) => goTo(k, true)}
          />
          {view === "all" ? (
            <div className="all-terminals" data-testid="all-view">
              {groups.map((g) => (
                <section key={g.key} className="tgroup" data-testid={`group-${g.key}`}>
                  <header className="ghead">
                    {g.repo ? <RepoMark repo={g.repo} known={folderRepos} /> : null}
                    {grouping === "state" ? <Glyph kind="pane" state={g.title} /> : null}
                    <span className="gt">{g.title}</span>
                    <span className="faint">
                      {g.rows.length + (g.sessions ?? []).reduce((n, x) => n + x.rows.length, 0)}
                    </span>
                  </header>
                  {tiles(g.rows)}
                  {(g.sessions ?? []).map((x) => (
                    <section
                      key={x.key}
                      className="tgroup lane"
                      style={{ "--lane": repoMark(x.repo ?? "", folderRepos).hue } as React.CSSProperties}
                    >
                      <header className="ghead">
                        <RepoMark repo={x.repo ?? ""} known={folderRepos} />
                        <span className="gt">{x.title}</span>
                        <span className="faint">{x.rows.length}</span>
                      </header>
                      {tiles(x.rows)}
                    </section>
                  ))}
                </section>
              ))}
              {groups.length === 0 ? (
                <div className="empty">
                  {rows.length === 0
                    ? "No task has a terminal open. Shells and a new run's chat are under Workspaces."
                    : `No terminal matches the filter: ${rows.length} hidden.`}
                </div>
              ) : null}
            </div>
          ) : (
            <div
              className={`task-tiles n${Math.min(Math.max(shownTiles.length, 1), 3)}`}
              data-testid={view === "task" ? "task-view" : "session-view"}
            >
              {shownTiles.map(tile)}
              {shownTiles.length === 0 ? (
                <div className="empty">
                  {viewPanes.length > 0
                    ? `No terminal of this ${view} matches the filter.`
                    : `No terminal of this ${view === "task" ? "task" : "session"} is open.`}
                </div>
              ) : null}
            </div>
          )}
        </div>
        {freshToast ? (
          <output className="fresh-toast" data-testid="fresh-toast">
            <span>
              <b>New terminal</b> · {freshToast.name} in {freshToast.repo}
              {rowOf(freshToast.parent) ? ` · started by ${rowOf(freshToast.parent)?.name}` : ""}
              {passes(freshToast, filter) ? "" : " · hidden by the filter"}
            </span>
            <button
              type="button"
              onClick={() => {
                goTo(freshToast.key, true);
                setFreshToast(undefined);
              }}
            >
              Show
            </button>
            <button
              type="button"
              className="ghost"
              aria-label="dismiss"
              onClick={() => setFreshToast(undefined)}
            >
              ✕
            </button>
          </output>
        ) : null}
        {overlays}
      </section>
    );
  }
  return (
    <section
      className="workbench"
      aria-label="Terminals"
      data-testid="workbench"
      data-zoom-key={keymap.zoom?.[0]}
    >
      <Tabs
        label="tabs"
        className="tabbar"
        before={
          repos.length > 1 ? (
            <select
              className="workspace"
              aria-label="workspace"
              title="The workspace whose tabs are shown: the checkout, or the agents that start runs"
              value={repo?.id ?? ""}
              onChange={(e) => {
                setRepoId(e.target.value);
                setTabKey(undefined);
              }}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.attention && needsPerson({ attention: r.attention }) ? " · needs you" : ""}
                </option>
              ))}
            </select>
          ) : undefined
        }
        current={tab?.key}
        onSelect={setTabKey}
        items={(repo?.tabs ?? []).map((t) => ({
          id: t.key,
          title: t.label,
          onContextMenu: (e: React.MouseEvent) => tabMenu(e, t),
          label: (
            <>
              <Glyph kind="attention" state={t.attention} />
              <span className="name">{t.label}</span>
              {t.branch ? <span className="faint branch"> {t.branch}</span> : null}
            </>
          ),
        }))}
      >
        <button type="button" className="plus" onClick={(e) => tabMenu(e, undefined)} aria-label="new tab">
          +
        </button>
        <span className="spacer" />
        {tasks.length > 0 ? (
          <a href={routeHash({ screen: "grid", group: "all" })} data-testid="by-task">
            All terminals ›
          </a>
        ) : null}
        <RepoSelect />
        {prefixChip}
        {settingsButton}
      </Tabs>
      <div className="procstrip" data-testid="procstrip">
        {run && run.stages.length > 0 ? (
          <StageBar stages={run.stages} variant="strip" onOpen={() => commands.plan?.(undefined, tab)} />
        ) : (
          <span className="faint">
            {tab?.kind === "shell" ? "No run in this tab: a shell, or the agent that starts one" : "No tab"}
          </span>
        )}
        <span className="spacer" />
        {run && run.questions.length > 0 ? (
          <span className="amber">? asks {run.questions.length}</span>
        ) : null}
        {run && needsPerson(run) && run.questions.length === 0 ? (
          <span className="amber">
            {run.attention === "escalated" ? "escalated" : "asks in its terminal"}
          </span>
        ) : null}
        {tab?.worktree ? <span className="faint mono">{tab.worktree}</span> : null}
        {tab ? (
          <button
            type="button"
            className="ghost"
            onClick={() => commands.editor?.(tab.runId ? undefined : focused, tab)}
            title="open in your editor (editor.command)"
            data-testid="open-editor"
          >
            editor
          </button>
        ) : null}
      </div>
      <div className="body">
        <section className="grid-area" aria-label="panes">
          <Notice {...action.notice} tone={action.notice.text ? action.notice.tone : "info"} />
          {tree ? (
            <SplitGrid
              tree={tree}
              zoom={zoom}
              renderPane={renderPane}
              onResize={(t) => tab && void action.run(() => client.setTree(tab.tabId, t, repoName))}
            />
          ) : (
            <div className="empty">
              <h2>{tab ? "No pane in this tab" : "No tab"}</h2>
              <p>
                {keyText(keymap, "newShell") ?? "The tab bar's menu"} opens a shell here;{" "}
                {keyText(keymap, "newTab") ?? "+ New chat"} opens a chat with the agent that starts a task;
                right-click the tab bar for the menu; ? lists every key.
              </p>
            </div>
          )}
        </section>
      </div>
      {overlays}
    </section>
  );
}
