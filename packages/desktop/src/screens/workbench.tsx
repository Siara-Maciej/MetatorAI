/**
 * The workbench (S6, design/13 §5b, mockups v9): terminals over MetatorAI's runs. Tabs are
 * tasks (a run in its worktree) or shells; under them the run's stages; the panes of the active
 * tab in their split tree; a sidebar of repositories and agents. Everything else is a right
 * click or a key after the prefix. The daemon owns the layout; this screen only draws and asks.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InboxItem, PaneView, SplitNode } from "../api.ts";
import { Notice, RepoSelect } from "../components/common.tsx";
import { ContextMenu, type MenuItem } from "../components/context-menu.tsx";
import { GotoPicker } from "../components/goto.tsx";
import { SplitGrid } from "../components/split-grid.tsx";
import { PaneTerminal, type TerminalHandle } from "../components/terminal.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import {
  actionOf,
  chordOf,
  evenTree,
  type GotoRow,
  hostChoice,
  type KeyMap,
  keyMapOf,
  neighborPane,
  noHostText,
  notifies,
  paneLabel,
  stripStages,
  type WorkbenchRepo,
  type WorkbenchTab,
  workbenchRepos,
} from "../model.ts";

const SYMBOL: Record<string, string> = { working: "⋮", blocked: "!", waiting: "?", idle: "✓", exited: "✕" };

export function WorkbenchScreen({
  onNewTask,
  onOpenSettings,
  onOpenPlan,
  onOpenReview,
  onOpenInbox,
  onOpenBacklog,
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
  /** A pane to show first (from the plan screen): its tab is selected and it gets the focus. */
  readonly showPane?: string | undefined;
}) {
  const d = useDaemon();
  const { client, runs, inbox, me, who } = d;
  // The repository this screen shows (D10): the one chosen in a folder, the daemon's own otherwise.
  const repoName = d.repo;
  // The layout comes with the daemon's state (read every second, once for the whole app); in a
  // folder two repositories may use the same pane ids, so only this repository's count.
  const panes = useMemo(
    () => d.panes.filter((p) => (p.repo ?? "") === (repoName ?? "")),
    [d.panes, repoName],
  );
  const workspaces = useMemo(
    () => d.workspaces.filter((w) => (w.repo ?? "") === (repoName ?? "")),
    [d.workspaces, repoName],
  );
  // Options: the keys and the look, refreshed when they change.
  const { data: options } = usePolled(`options:${repoName ?? ""}`, () => client.options(repoName), 5000);
  const opt = useCallback(
    <T,>(key: string, fallback: T): T => {
      const o = options?.options.find((x) => x.key === key);
      return (o?.value as T | undefined) ?? fallback;
    },
    [options],
  );
  const keymap: KeyMap = useMemo(() => keyMapOf(options?.options ?? []), [options]);
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
  // A pane asked for by the route: once the layout knows it, its tab and focus.
  const shown = useRef<string | undefined>(undefined);
  if (showPane && shown.current !== showPane) {
    const t = repos.flatMap((r) => r.tabs).find((x) => x.panes.includes(showPane));
    if (t) {
      shown.current = showPane;
      setRepoId(repos.find((r) => r.tabs.includes(t))?.id);
      setTabKey(t.key);
      setFocus(showPane);
    }
  }
  const focused = tabPanes.find((p) => p.id === focus) ?? tabPanes[0];
  const [zoom, setZoom] = useState<string>();
  /** The editor on a pane's directory, or on the tab's run (its worktree), else the focused pane. */
  const openEditor = async (p?: PaneView) => {
    const r = p
      ? await client.openPaneEditor(p.id, repoName)
      : tab?.runId
        ? await client.openEditor(tab.runId, {}, repoName)
        : focused
          ? await client.openPaneEditor(focused.id, repoName)
          : undefined;
    if (r) setNote(r.ok ? `opened in the editor: ${r.data?.dir ?? ""}` : r.error?.message);
  };
  // The zoom is the tab's: a tab change drops it.
  const zoomTab = useRef<string | undefined>(undefined);
  if (zoomTab.current !== tab?.key) {
    zoomTab.current = tab?.key;
    if (zoom) setZoom(undefined);
  }
  const [note, setNote] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; label: string }>();
  const [goto, setGoto] = useState(false);
  const [copyMode, setCopyMode] = useState<string>();
  const [query, setQuery] = useState("");
  const [attachAsk, setAttachAsk] = useState<string>();
  const [prefixed, setPrefixed] = useState(false);
  const handles = useRef(new Map<string, TerminalHandle>());
  const run = tab?.run;
  const attached = (p: PaneView | undefined) => {
    const r = p?.runId ? runs.find((x) => x.runId === p.runId) : undefined;
    return !!r && r.driver === "human" && r.attachedBy === me && me !== "";
  };
  /** A shell takes anyone's keys; an agent's pane of a run only its attached person's. */
  const canType = (p: PaneView) => !p.runId || p.role === "shell" || attached(p);
  const attach = async (p: PaneView) => {
    if (!p.runId) return;
    const by = await who();
    if (!by) return;
    const r = await client.attach(p.runId, by, repoName);
    setNote(r.ok ? undefined : r.error?.message);
    setFocus(p.id);
    handles.current.get(p.id)?.focus();
  };
  const release = async (p: PaneView) => {
    if (!p.runId) return;
    const r = await client.release(p.runId, repoName);
    setNote(r.ok ? undefined : r.error?.message);
  };
  const split = async (p: PaneView | undefined, dir: "right" | "down") => {
    if (!p) return;
    const r = await client.splitPane(p.id, dir, repoName);
    if (r.ok && r.data) setFocus(r.data.id);
    else setNote(r.error?.message);
  };
  const closePane = async (p: PaneView | undefined) => {
    if (!p) return;
    if (
      opt("ui.confirmClosePane", true) &&
      p.live?.alive &&
      !window.confirm(`Close ${paneLabel(p)} (${p.id})?`)
    )
      return;
    const r = await client.closePane(p.id, repoName);
    if (!r.ok) setNote(r.error?.message);
  };
  const closeTab = async (t: WorkbenchTab, ask = true) => {
    if (ask && !window.confirm(`Close ${t.label} and its ${t.panes.length} pane(s)?`)) return;
    // A run's tab is its whole workspace, and so is the last tab of any workspace; a tab that
    // shares its workspace with others loses only its own panes.
    const alone = repos.flatMap((r) => r.tabs).filter((x) => x.workspaceId === t.workspaceId).length === 1;
    if (t.kind === "task" || alone) {
      const r = await client.closeWorkspace(t.workspaceId, repoName);
      if (!r.ok) setNote(r.error?.message);
      return;
    }
    for (const id of t.panes) {
      const r = await client.closePane(id, repoName);
      if (!r.ok) setNote(r.error?.message);
    }
  };
  /**
   * A pane whose process ended, started again (D1): a run's conductor is resumed in place; any
   * other pane gets a new one beside it with the same program, and the dead one goes.
   */
  const retryPane = async (p: PaneView) => {
    if (p.role === "conductor" && p.runId) {
      const r = await client.post(`/runs/${p.runId}/pty-open`, {}, repoName);
      setNote(r.ok ? undefined : `The session did not start: ${r.error?.message ?? "the daemon refused"}`);
      return;
    }
    let process: { argv: string[] } | { host: string; agent: string; prompt: string };
    if (p.process.kind === "command") process = { argv: [...p.process.argv] };
    else {
      // The host the pane had, when it is installed; else the first installed one of the order.
      const s = await client.supervisor(repoName);
      const status = s.data?.hostStatus;
      const wanted = p.process.host;
      const host =
        !status || status.some((h) => h.id === wanted && h.installed)
          ? wanted
          : hostChoice(s.data?.policy.hostOrder ?? [], status);
      if (!host) {
        setNote(noHostText(status ?? []));
        return;
      }
      process = { host, agent: p.process.agent, prompt: p.process.prompt };
    }
    const r = await client.openPane(
      { workspace: p.workspace, tab: p.tab, role: p.role, label: p.label, ...process },
      repoName,
    );
    if (!r.ok || !r.data) {
      setNote(`The pane did not start: ${r.error?.message ?? "the daemon refused"}`);
      return;
    }
    setNote(undefined);
    setFocus(r.data.id);
    await client.closePane(p.id, repoName);
  };
  const newShell = async () => {
    if (!tab) return;
    const r = await client.openPane(
      {
        workspace: tab.workspaceId,
        tab: tab.tabId,
        role: "shell",
        label: "shell",
      },
      repoName,
    );
    if (r.ok && r.data) setFocus(r.data.id);
    else setNote(r.error?.message);
  };
  const newShellTab = async () => {
    if (!repo) return;
    const r = await client.openPane(
      {
        ...(repo.id === "repo" ? {} : { workspace: repo.id }),
        label: "shell",
        role: "shell",
        newTab: true,
      },
      repoName,
    );
    if (!r.ok) setNote(r.error?.message);
  };
  const resize = async (t: SplitNode) => {
    if (!tab) return;
    const r = await client.setTree(tab.tabId, t, repoName);
    if (!r.ok) setNote(r.error?.message);
  };
  const pick = (row: GotoRow) => {
    setGoto(false);
    setRepoId(repos.find((r) => r.tabs.some((t) => t.key === row.tab.key))?.id);
    setTabKey(row.tab.key);
    if (row.paneId) {
      setFocus(row.paneId);
    } else {
      const conductor = panes.find((p) => p.runId === row.tab.runId && p.role === "conductor");
      if (conductor) setFocus(conductor.id);
    }
  };
  // One toast: the newest question of the tabs shown here (notify.channel app) that the person
  // has not closed.
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const toast: InboxItem | undefined = !notifies(options?.options ?? [])
    ? undefined
    : inbox.find(
        (i) =>
          !dismissed.includes(`${i.runId}/${i.question.id}`) &&
          repos.some((r) => r.tabs.some((t) => t.runId === i.runId)),
      );
  /** The host's own prompt is answered in its pane; every other question on its card. */
  const inPane = toast?.question.source === "permission";
  const waitingForYou = runs.filter((r) => r.attention === "you").length;
  const blockedKey = (p: PaneView) => {
    const mode = opt<"ask" | "always" | "never">("ui.attachOnType", "ask");
    if (mode === "never") return;
    if (mode === "always") void attach(p);
    else setAttachAsk(p.id);
  };
  const nextWaitingTab = () => {
    const all = repos.flatMap((r) => r.tabs);
    const i = all.findIndex((t) => t.key === tab?.key);
    const order = [...all.slice(i + 1), ...all.slice(0, i + 1)];
    const next = order.find((t) => t.attention === "you");
    if (next) {
      setRepoId(repos.find((r) => r.tabs.includes(next))?.id);
      setTabKey(next.key);
    }
  };
  // Keys: the prefix, then one chord; the terminals' own keys are left alone otherwise.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const chord = chordOf(e);
      if (chord === "") return;
      if (attachAsk) {
        if (chord === "enter") {
          const p = panes.find((x) => x.id === attachAsk);
          setAttachAsk(undefined);
          if (p) void attach(p);
        } else if (chord === "escape") setAttachAsk(undefined);
        e.preventDefault();
        return;
      }
      if (copyMode) {
        const h = handles.current.get(copyMode);
        if (chord === "escape") {
          h?.clearSearch();
          setCopyMode(undefined);
          setQuery("");
          e.preventDefault();
        } else if (chord === "y" && !(e.target instanceof HTMLInputElement)) {
          const text = h?.copySelection();
          setNote(text ? `copied ${text.length} characters` : "nothing selected");
          e.preventDefault();
        }
        return;
      }
      if (goto || menu) return;
      if (!prefixed) {
        if (actionOf(keymap, chord, false) === "prefix") {
          e.preventDefault();
          e.stopPropagation();
          setPrefixed(true);
          timer = setTimeout(() => setPrefixed(false), 2000);
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setPrefixed(false);
      if (timer) clearTimeout(timer);
      const action = actionOf(keymap, chord, true);
      switch (action) {
        case "newShell":
          void newShell();
          break;
        case "newTab":
          onNewTask();
          break;
        case "splitRight":
          void split(focused, "right");
          break;
        case "splitDown":
          void split(focused, "down");
          break;
        case "zoom":
          setZoom((z) => (z ? undefined : focused?.id));
          break;
        case "focusLeft":
        case "focusUp":
          setFocus(neighborPane(tree, focused?.id, -1));
          break;
        case "focusRight":
        case "focusDown":
          setFocus(neighborPane(tree, focused?.id, 1));
          break;
        case "goto":
          setGoto(true);
          break;
        case "nextWaiting":
          nextWaitingTab();
          break;
        case "attach":
          if (focused) void attach(focused);
          break;
        case "release":
          if (focused) void release(focused);
          break;
        case "copyMode":
          if (focused) setCopyMode(focused.id);
          break;
        case "closePane":
          void closePane(focused);
          break;
        case "plan":
          if (tab?.runId) onOpenPlan(tab.runId);
          break;
        case "backlog":
          onOpenBacklog();
          break;
        case "changes":
          if (tab?.runId) onOpenReview(tab.runId);
          break;
        case "help":
          setNote(
            Object.entries(keymap)
              .map(([a, c]) => `${c.join("/")} ${a}`)
              .join(" · "),
          );
          break;
        default:
          setNote(action ? `${action}: not on this screen yet` : `no action for ${chord}`);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer) clearTimeout(timer);
    };
  });
  const paneMenu = (p: PaneView, e: React.MouseEvent) => {
    e.preventDefault();
    setFocus(p.id);
    const r = p.runId ? runs.find((x) => x.runId === p.runId) : undefined;
    const mine = attached(p);
    const items: MenuItem[] = [
      p.runId && !mine
        ? {
            label: p.state?.state === "blocked" ? "Answer here (take the keyboard)" : "Take the keyboard",
            key: key(keymap, "attach"),
            onSelect: () => void attach(p),
            disabled: r?.driver === "human",
          }
        : {
            label: "Give the keyboard back",
            key: key(keymap, "release"),
            onSelect: () => void release(p),
            disabled: !p.runId,
          },
      {
        label: zoom === p.id ? "Unzoom" : "Zoom",
        key: key(keymap, "zoom"),
        onSelect: () => setZoom(zoom === p.id ? undefined : p.id),
      },
      { label: "Split right", key: key(keymap, "splitRight"), onSelect: () => void split(p, "right") },
      { label: "Split down", key: key(keymap, "splitDown"), onSelect: () => void split(p, "down") },
      { label: "Copy mode", key: key(keymap, "copyMode"), onSelect: () => setCopyMode(p.id) },
      {
        label: "Plan of the run",
        key: key(keymap, "plan"),
        separator: true,
        disabled: !p.runId,
        onSelect: () => p.runId && onOpenPlan(p.runId),
      },
      {
        label: "Changes",
        key: key(keymap, "changes"),
        disabled: !p.runId,
        onSelect: () => p.runId && onOpenReview(p.runId),
      },
      { label: "Open in editor", onSelect: () => void openEditor(p) },
      {
        label: "New task from here…",
        onSelect: () => onOpenBacklog(p.runId ? { refs: [{ run: p.runId }] } : {}),
      },
      {
        label: "Close pane",
        key: key(keymap, "closePane"),
        separator: true,
        onSelect: () => void closePane(p),
        disabled: p.role === "conductor",
      },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items, label: `pane ${p.id}` });
  };
  const tabMenu = (t: WorkbenchTab | undefined, e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "New tab: shell", key: key(keymap, "newShell"), onSelect: () => void newShellTab() },
      {
        label: "New tab: tell the agent a task (it starts the run)…",
        key: key(keymap, "newTab"),
        onSelect: onNewTask,
      },
      { label: "Backlog…", key: key(keymap, "backlog"), onSelect: () => onOpenBacklog() },
      ...(t
        ? [
            { label: "New shell pane here", separator: true, onSelect: () => void newShell() },
            {
              label: t.kind === "task" ? "Close tab (its panes; the worktree stays)" : "Close tab",
              onSelect: () => void closeTab(t),
              disabled: t.kind === "shell" && t.panes.length === 0,
            },
          ]
        : []),
    ];
    setMenu({ x: e.clientX, y: e.clientY, items, label: t ? `tab ${t.label}` : "tabs" });
  };
  const borders = opt<"auto" | "always" | "off">("ui.paneBorders", "auto");
  const framed = borders === "always" || (borders === "auto" && tabPanes.length > 1);
  const labels = opt("ui.paneLabels", true);
  const symbols = opt<"dots" | "symbols">("ui.statusIndicators", "symbols") === "symbols";
  const renderPane = (id: string): ReactNode => {
    const p = tabPanes.find((x) => x.id === id);
    if (!p) return <div className="empty">pane {id}</div>;
    const state = p.state?.state ?? (p.live?.alive ? "working" : "exited");
    const isFocus = focused?.id === p.id;
    return (
      <section
        className={`pane-frame${framed ? " framed" : ""}${isFocus ? " focus" : ""} s-${state}`}
        aria-label={`${paneLabel(p)} ${p.id}`}
        data-testid={`frame-${p.id}`}
        data-state={state}
        onMouseDown={() => setFocus(p.id)}
        onContextMenu={(e) => paneMenu(p, e)}
      >
        {labels ? (
          <button
            type="button"
            className="title"
            onDoubleClick={() => setZoom(zoom === p.id ? undefined : p.id)}
            title={p.state?.reason ?? p.id}
          >
            {paneLabel(p)}
            {p.process.kind === "host" ? <span className="dim"> · {p.process.host}</span> : null}
            <span className={`st ${state}`}>
              {" · "}
              {symbols ? `${SYMBOL[state] ?? ""} ` : ""}
              {state}
            </span>
            {attached(p) ? <span className="teal"> · yours</span> : null}
          </button>
        ) : null}
        {p.live ? (
          <PaneTerminal
            // A new session in the same pane (Retry on a conductor) is a new terminal.
            key={p.live.sessionId}
            paneId={p.id}
            repo={repoName}
            canType={p.live.alive && canType(p)}
            scrollback={opt("terminal.scrollbackLines", 5000)}
            onBlockedKey={() => (p.live?.alive ? blockedKey(p) : undefined)}
            onReady={(h) => handles.current.set(p.id, h)}
          />
        ) : (
          <div className="empty" />
        )}
        {p.live?.alive ? null : (
          <div
            className="pane-ended"
            role="status"
            data-testid={`ended-${p.id}`}
            title={p.live ? "The pane keeps the last output of the process." : undefined}
          >
            <span className="msg">
              {p.live
                ? `The process ended${p.live.exitCode !== undefined ? ` with code ${p.live.exitCode}` : ""}.`
                : "Nothing runs in this pane: its process did not start, or the daemon was restarted."}
            </span>
            <button type="button" className="primary" onClick={() => void retryPane(p)}>
              Retry
            </button>
            {tab && tabPanes.length === 1 ? (
              <button type="button" onClick={() => void closeTab(tab, false)}>
                Close tab
              </button>
            ) : (
              <button type="button" onClick={() => void client.closePane(p.id, repoName)}>
                Close pane
              </button>
            )}
          </div>
        )}
        {attachAsk === p.id ? (
          <div className="ask" role="alert">
            Take the keyboard of {paneLabel(p)}? <kbd>↵</kbd> yes · <kbd>esc</kbd> no
          </div>
        ) : null}
        {copyMode === p.id ? (
          <search className="copy-mode">
            <span className="dim">copy mode</span>
            <input
              // biome-ignore lint/a11y/noAutofocus: opened by a key, the search field is where the keys go
              autoFocus
              aria-label="search the scrollback"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                handles.current.get(p.id)?.findNext(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  handles.current.get(p.id)?.[e.shiftKey ? "findPrevious" : "findNext"](query);
              }}
            />
            <span className="dim">
              <kbd>↵</kbd> next · <kbd>⇧↵</kbd> previous · select with the mouse, <kbd>y</kbd> copies ·{" "}
              <kbd>esc</kbd>
            </span>
          </search>
        ) : null}
      </section>
    );
  };
  const strip = stripStages(run);
  return (
    <div className="workbench" data-testid="workbench" data-zoom-key={key(keymap, "zoom")}>
      <div className="tabbar" role="tablist" onContextMenu={(e) => tabMenu(undefined, e)}>
        <span className="ico" aria-hidden="true" />
        {(repo?.tabs ?? []).map((t) => (
          <button
            type="button"
            key={t.key}
            className={`tab${t.key === tab?.key ? " on" : ""}`}
            aria-selected={t.key === tab?.key}
            role="tab"
            onClick={() => setTabKey(t.key)}
            onContextMenu={(e) => {
              e.stopPropagation();
              tabMenu(t, e);
            }}
          >
            <span className={`mark ${t.attention ?? "none"}`}>▪</span>
            <span className="name" title={t.label}>
              {t.label}
            </span>
            {t.branch ? <span className="dim branch"> {t.branch}</span> : null}
          </button>
        ))}
        <button
          type="button"
          className="tab plus"
          onClick={(e) => tabMenu(undefined, e)}
          aria-label="new tab"
        >
          +
        </button>
        <span className="spacer" />
        {waitingForYou > 0 ? <span className="amber waits">● waits for you {waitingForYou}</span> : null}
        <RepoSelect />
        {prefixed ? <span className="chip teal">prefix</span> : null}
        <button type="button" className="ghost" onClick={onOpenSettings} title="settings">
          ⚙
        </button>
      </div>
      <div className="procstrip" data-testid="procstrip">
        {strip.length > 0 ? (
          <button
            type="button"
            className="stages"
            title="the plan of this run"
            onClick={() => tab?.runId && onOpenPlan(tab.runId)}
          >
            {strip.map((s, i) => (
              <span key={s.id} className={`stage ${s.state}`}>
                {i > 0 ? <span className="dim"> · </span> : null}
                {s.id} {s.glyph}
              </span>
            ))}
          </button>
        ) : (
          <span className="dim">{tab?.kind === "shell" ? "a shell tab: no run" : "no tab"}</span>
        )}
        <span className="spacer" />
        {run && run.questions.length > 0 ? (
          <span className="amber">? asks {run.questions.length}</span>
        ) : null}
        {tab?.worktree ? <span className="dim mono">{tab.worktree}</span> : null}
        {tab ? (
          <button
            type="button"
            className="ghost"
            onClick={() => void openEditor()}
            title="open in your editor (editor.command)"
            data-testid="open-editor"
          >
            editor
          </button>
        ) : null}
      </div>
      <div className="body">
        <aside className="sidebar">
          {repos.map((r, i) => (
            <button
              type="button"
              key={r.id}
              className={`ws${r.id === repo?.id ? " sel" : ""}`}
              onClick={() => {
                setRepoId(r.id);
                setTabKey(undefined);
              }}
            >
              <span className="l1">
                <span className="dim">{i + 1}</span>
                <b>{r.label}</b>
                <span className="spacer" />
                <span className={`dot ${r.attention ?? "none"}`} />
              </span>
              <span className="l2 dim">
                {r.tabs.length} tab{r.tabs.length === 1 ? "" : "s"}
                {r.tabs.filter((t) => t.attention === "you").length > 0
                  ? ` · ${r.tabs.filter((t) => t.attention === "you").length} wait for you`
                  : ""}
              </span>
            </button>
          ))}
          <button type="button" className="ws new dim" onClick={onNewTask}>
            <span className="l1">
              <span style={{ paddingLeft: 18 }}>new</span>
            </span>
          </button>
          <span className="spacer" />
          {(repo?.tabs ?? []).map((t) => {
            const own = t.panes.map((id) => panes.find((p) => p.id === id)).filter((p): p is PaneView => !!p);
            if (own.length === 0) return null;
            return (
              <div key={t.key} className="agents">
                <div className="sec">
                  {t.label}
                  {t.run ? <span className="dim"> · {t.run.stage}</span> : null}
                  {t.run && t.run.questions.length > 0 ? (
                    <span className="amber"> · ? {t.run.questions.length}</span>
                  ) : null}
                </div>
                {own.map((p) => {
                  const state = p.state?.state ?? (p.live?.alive ? "working" : "exited");
                  return (
                    <button
                      type="button"
                      key={p.id}
                      className={`ag${focused?.id === p.id && t.key === tab?.key ? " sel" : ""}`}
                      onClick={() => {
                        setTabKey(t.key);
                        setFocus(p.id);
                      }}
                    >
                      <span className={`st ${state}`}>{symbols ? SYMBOL[state] : "●"}</span>
                      <span className="n">{paneLabel(p)}</span>
                      <span className={`st ${state}`}>{state}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </aside>
        <main className="grid-area">
          <Notice text={note} tone="info" onClose={() => setNote(undefined)} />
          {tree ? (
            <SplitGrid tree={tree} zoom={zoom} renderPane={renderPane} onResize={(t) => void resize(t)} />
          ) : (
            <div className="empty">
              <h2>{tab ? "No pane in this tab" : "No tab"}</h2>
              <p>
                {key(keymap, "newShell") ?? "prefix+c"} opens a shell here;{" "}
                {key(keymap, "newTab") ?? "prefix+t"} opens a conversation with the agent that starts a task;
                right-click the tab bar for the menu.
              </p>
            </div>
          )}
        </main>
      </div>
      {toast ? (
        <div className="toast" role="status">
          <button
            type="button"
            className="open"
            data-testid="toast"
            title={toast.question.prompt}
            onClick={() => {
              if (!inPane) {
                onOpenInbox(`${toast.runId}/${toast.question.id}`);
                return;
              }
              const conductor = panes.find((p) => p.runId === toast.runId && p.role === "conductor");
              const t = repos.flatMap((r) => r.tabs).find((x) => x.runId === toast.runId);
              if (t) {
                setRepoId(repos.find((r) => r.tabs.includes(t))?.id);
                setTabKey(t.key);
              }
              if (conductor) {
                setFocus(conductor.id);
                void attach(conductor);
              }
            }}
          >
            <span className="q">
              <span className="amber">?</span> {toast.question.agent ?? toast.question.source} asks:{" "}
              {toast.question.prompt}
            </span>
            <span className="dim how">{inPane ? "answer in the pane ›" : "open the card ›"}</span>
          </button>
          <button
            type="button"
            className="ghost"
            aria-label="dismiss"
            title="hide this; the question stays in the Inbox"
            onClick={() => setDismissed([...dismissed, `${toast.runId}/${toast.question.id}`])}
          >
            ✕
          </button>
        </div>
      ) : null}
      {menu ? (
        <ContextMenu at={menu} items={menu.items} label={menu.label} onClose={() => setMenu(undefined)} />
      ) : null}
      {goto ? <GotoPicker repos={repos} panes={panes} onPick={pick} onClose={() => setGoto(false)} /> : null}
    </div>
  );
}

const key = (map: KeyMap, action: string): string | undefined => map[action]?.[0];
