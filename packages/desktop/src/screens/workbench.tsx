/**
 * The workbench (S6, design/13 §5b, mockups v9): terminals over MetatorAI's runs. Tabs are
 * tasks (a run in its worktree) or shells; under them the run's stages; the panes of the active
 * tab in their split tree; a sidebar of repositories and agents. Everything else is a command:
 * a key after the prefix, or an item of a right-click menu (model.ts `WORKBENCH_COMMANDS`).
 * The daemon owns the layout; this screen only draws and asks.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PaneView, SplitNode } from "../api.ts";
import { Notice, RepoSelect } from "../components/common.tsx";
import { ContextMenu, type MenuItem } from "../components/context-menu.tsx";
import { Glyph } from "../components/glyph.tsx";
import { GotoPicker } from "../components/goto.tsx";
import { PaneFrame } from "../components/pane-frame.tsx";
import { QuestionToast } from "../components/question-toast.tsx";
import { SplitGrid } from "../components/split-grid.tsx";
import { StageBar } from "../components/stage-bar.tsx";
import { Tabs } from "../components/tabs.tsx";
import type { TerminalHandle } from "../components/terminal.tsx";
import { WorkbenchSidebar } from "../components/workbench-sidebar.tsx";
import { useDaemon } from "../daemon.tsx";
import { runControls, useAction, useOption } from "../hooks.ts";
import {
  actionOf,
  type CommandContext,
  chordOf,
  closesWorkspace,
  evenTree,
  type GotoRow,
  type KeyMap,
  keyLabel,
  keyMapOf,
  keyText,
  menuCommands,
  needsPerson,
  neighborPane,
  nextWaitingTab,
  noHostText,
  notifies,
  paneLabel,
  paneStateOf,
  repoOfTab,
  retryHost,
  runCounts,
  tabOfPane,
  tabOfRun,
  toastOf,
  type WorkbenchCommand,
  type WorkbenchRepo,
  type WorkbenchTab,
  workbenchRepos,
  workspaceOfPane,
} from "../model.ts";

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

export function WorkbenchScreen({
  onNewTask,
  onOpenSettings,
  onOpenPlan,
  onOpenReview,
  onOpenInbox,
  onOpenBacklog,
  onHelp,
  showPane,
}: {
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
  const tabPanes = (tab?.panes ?? [])
    .map((id) => panes.find((p) => p.id === id))
    .filter((p): p is PaneView => !!p);
  const tree: SplitNode | undefined = tab ? (tab.tree ?? evenTree(tab.panes)) : undefined;
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
  const focused = tabPanes.find((p) => p.id === focus) ?? tabPanes[0];
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
  const runOf = (p: PaneView | undefined) => d.run(p?.runId, repoName);
  const controlsOf = (p: PaneView | undefined) => runControls(client, action, me, runOf(p));
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
    setFocus(p.id);
    handles.current.get(p.id)?.focus();
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
    let process: { argv: string[] } | { host: string; agent: string; prompt: string };
    if (p.process.kind === "command") process = { argv: [...p.process.argv] };
    else {
      // The host the pane had, when it is installed; else the first installed one of the order.
      const s = await client.supervisor(repoName);
      const host = retryHost(p.process.host, s.data?.policy.hostOrder ?? [], s.data?.hostStatus);
      if (!host) {
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
    if (id) await client.closePane(p.id, repoName);
  };
  /**
   * What every command does (model.ts `WORKBENCH_COMMANDS` names them): the keys, the two
   * right-click menus and the buttons of this screen all run these, on the focused pane or on the
   * one under the menu.
   */
  const commands: Record<string, (p: PaneView | undefined, t: WorkbenchTab | undefined) => void> = {
    attach: (p) => p && void attach(p),
    release: (p) => void controlsOf(p).release(),
    zoom: (p) => setZoom((z) => (z ? undefined : p?.id)),
    splitRight: (p) => p && void opening(() => client.splitPane(p.id, "right", repoName)),
    splitDown: (p) => p && void opening(() => client.splitPane(p.id, "down", repoName)),
    copyMode: (p) => p && setMode({ kind: "copy", pane: p.id }),
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
      if (p) void action.run(() => client.openPaneEditor(p.id, repoName), { done: "opened in the editor" });
      else if (runId)
        void action.run(() => client.openEditor(runId, {}, repoName), { done: "opened in the editor" });
    },
    taskFromHere: (p) => onOpenBacklog(p?.runId ? { refs: [{ run: p.runId }] } : {}),
    closePane: (p) => {
      if (!p) return;
      if (confirmClose && p.live?.alive && !window.confirm(`Close ${paneLabel(p)} (${p.id})?`)) return;
      void action.run(() => client.closePane(p.id, repoName));
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
    focusLeft: (p) => setFocus(neighborPane(tree, p?.id, -1)),
    focusUp: (p) => setFocus(neighborPane(tree, p?.id, -1)),
    focusRight: (p) => setFocus(neighborPane(tree, p?.id, 1)),
    focusDown: (p) => setFocus(neighborPane(tree, p?.id, 1)),
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
      zoomed: p !== undefined && zoom === p.id,
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
    if (p) setFocus(p.id);
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
    showTab(
      row.tab,
      row.paneId ?? panes.find((p) => p.runId === row.tab.runId && p.role === "conductor")?.id,
    );
  };
  // One toast: the newest question of the tabs shown here (notify.channel app) that the person
  // has not closed.
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const toast = toastOf(inbox, repos, dismissed, notifies(options));
  const openToast = () => {
    if (!toast) return;
    // The host's own prompt is answered in its pane; every other question on its card.
    if (toast.question.source !== "permission") {
      onOpenInbox(`${toast.runId}/${toast.question.id}`);
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
    else setMode({ kind: "ask", pane: p.id });
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
          const p = panes.find((x) => x.id === mode.pane);
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
  const framed = borders === "always" || (borders === "auto" && tabPanes.length > 1);
  const renderPane = (id: string): ReactNode => {
    const p = tabPanes.find((x) => x.id === id);
    if (!p) return <div className="empty">pane {id}</div>;
    return (
      <PaneFrame
        pane={p}
        state={paneStateOf(p)}
        repo={repoName}
        focused={focused?.id === p.id}
        framed={framed}
        labels={labels}
        symbols={symbols}
        mine={controlsOf(p).attached}
        canType={canType(p)}
        scrollback={scrollback}
        asking={mode.kind === "ask" && mode.pane === p.id}
        copying={mode.kind === "copy" && mode.pane === p.id}
        lastOfTab={tabPanes.length === 1}
        onFocus={() => setFocus(p.id)}
        onMenu={(e) => openMenu(e, ["pane"], p, tab, `pane ${p.id}`)}
        onZoom={() => setZoom(zoom === p.id ? undefined : p.id)}
        onBlockedKey={() => blockedKey(p)}
        onReady={(h) => handles.current.set(p.id, h)}
        onRetry={() => void retryPane(p)}
        onClose={() =>
          tab && tabPanes.length === 1
            ? void closeTab(tab, false)
            : void action.run(() => client.closePane(p.id, repoName))
        }
      />
    );
  };
  const waitingForYou = runCounts(runs).needYou;
  return (
    <div className="workbench" data-testid="workbench" data-zoom-key={keymap.zoom?.[0]}>
      <Tabs
        label="tabs"
        className="tabbar"
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
        {waitingForYou > 0 ? <span className="amber waits">● waits for you {waitingForYou}</span> : null}
        <RepoSelect />
        {mode.kind === "prefix" ? (
          <span className="chip teal" data-testid="prefix">
            {keymap.prefix?.[0] ?? "prefix"} …
          </span>
        ) : null}
        <button type="button" className="ghost" onClick={onHelp} title="the keys" aria-label="keyboard help">
          ?
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onOpenSettings}
          title="settings"
          aria-label="settings"
        >
          ⚙
        </button>
      </Tabs>
      <div className="procstrip" data-testid="procstrip">
        {run && run.stages.length > 0 ? (
          <StageBar stages={run.stages} variant="strip" onOpen={() => commands.plan?.(undefined, tab)} />
        ) : (
          <span className="faint">{tab?.kind === "shell" ? "a shell tab: no run" : "no tab"}</span>
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
        <WorkbenchSidebar
          repos={repos}
          repo={repo}
          tab={tab}
          panes={panes}
          focused={focused?.id}
          symbols={symbols}
          onRepo={(id) => {
            setRepoId(id);
            setTabKey(undefined);
          }}
          onNew={onNewTask}
          onPane={(key, paneId) => {
            setTabKey(key);
            setFocus(paneId);
          }}
        />
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
                {keyText(keymap, "newTab") ?? "+ New session"} opens a conversation with the agent that starts
                a task; right-click the tab bar for the menu; ? lists every key.
              </p>
            </div>
          )}
        </section>
      </div>
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
        <GotoPicker repos={repos} panes={panes} onPick={pick} onClose={() => setMode(IDLE)} />
      ) : null}
    </div>
  );
}
