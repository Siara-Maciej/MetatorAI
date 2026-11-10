/**
 * The workbench (S6, design/13 §5b, mockups v9): herdr's shape over MetatorAI's runs. Tabs are
 * tasks (a run in its worktree) or shells; under them the run's stages; the panes of the active
 * tab in their split tree; a sidebar of repositories and agents. Everything else is a right
 * click or a key after the prefix. The daemon owns the layout; this screen only draws and asks.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InboxItem, OptionsView, PaneView, SplitNode } from "../api.ts";
import { ContextMenu, type MenuItem } from "../components/context-menu.tsx";
import { GotoPicker } from "../components/goto.tsx";
import { SplitGrid } from "../components/split-grid.tsx";
import { PaneTerminal, type TerminalHandle } from "../components/terminal.tsx";
import { useDaemon } from "../daemon.tsx";
import {
  actionOf,
  chordOf,
  evenTree,
  type GotoRow,
  type KeyMap,
  keyMapOf,
  neighborPane,
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
  onOpenBacklog,
  showPane,
}: {
  /** Opens the new-session dialog for a task in a new worktree (a new tab). */
  onNewTask(): void;
  onOpenSettings(): void;
  onOpenPlan(runId: string): void;
  /** The backlog; with a draft, its form opens for a task that points at a pane's run. */
  onOpenBacklog(draft?: {
    readonly title?: string;
    readonly refs?: readonly { run?: string; step?: string }[];
  }): void;
  /** A pane to show first (from the plan screen): its tab is selected and it gets the focus. */
  readonly showPane?: string | undefined;
}) {
  const { client, repos: daemonRepos, runs, panes, inbox, me, setMe } = useDaemon();
  const repoName = daemonRepos[0]?.name;
  // The layout: workspaces with their tabs and trees, read every second like the panes.
  const [workspaces, setWorkspaces] = useState<Parameters<typeof workbenchRepos>[0]>([]);
  useEffect(() => {
    let closed = false;
    const tick = async () => {
      const r = await client.layout(repoName);
      if (!closed && r.ok && r.data) setWorkspaces(r.data.workspaces);
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      closed = true;
      clearInterval(t);
    };
  }, [client, repoName]);
  // Options: the keys and the look, refreshed when they change.
  const [options, setOptions] = useState<OptionsView>();
  useEffect(() => {
    let closed = false;
    const tick = async () => {
      const r = await client.options(repoName);
      if (!closed && r.ok && r.data) setOptions(r.data);
    };
    void tick();
    const t = setInterval(() => void tick(), 5000);
    return () => {
      closed = true;
      clearInterval(t);
    };
  }, [client, repoName]);
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
    const who = me || window.prompt("your name") || "";
    if (!who) return;
    setMe(who);
    const r = await client.attach(p.runId, who, repoName);
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
  const closeTab = async (t: WorkbenchTab) => {
    if (!window.confirm(`Close ${t.label} and its ${t.panes.length} pane(s)?`)) return;
    const r = await client.closeWorkspace(t.workspaceId, repoName);
    if (!r.ok) setNote(r.error?.message);
  };
  const newShell = async () => {
    if (!tab) return;
    const r = await client.openPane(
      {
        workspace: tab.workspaceId,
        tab: tab.tabId,
        role: "shell",
        label: "shell",
        argv: [shellOf(opt("terminal.shell", ""))],
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
        argv: [shellOf(opt("terminal.shell", ""))],
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
  const pick = (row: GotoRow, take: boolean) => {
    setGoto(false);
    setRepoId(repos.find((r) => r.tabs.some((t) => t.key === row.tab.key))?.id);
    setTabKey(row.tab.key);
    if (row.paneId) {
      setFocus(row.paneId);
      const p = panes.find((x) => x.id === row.paneId);
      if (take && p) void attach(p);
    } else {
      const conductor = panes.find((p) => p.runId === row.tab.runId && p.role === "conductor");
      if (conductor) setFocus(conductor.id);
    }
  };
  // One toast: the newest question of the tabs shown here (notify.channel app).
  const toast: InboxItem | undefined =
    opt<string>("notify.channel", "app") === "off"
      ? undefined
      : inbox.find((i) => repos.some((r) => r.tabs.some((t) => t.runId === i.runId)));
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
      { label: "Changes", key: key(keymap, "changes"), disabled: true },
      { label: "Open in VS Code", disabled: true },
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
      { label: "New tab: task in a new worktree…", key: key(keymap, "newTab"), onSelect: onNewTask },
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
        {p.live?.alive ? (
          <PaneTerminal
            paneId={p.id}
            repo={repoName}
            canType={canType(p)}
            scrollback={opt("terminal.scrollbackLines", 5000)}
            onBlockedKey={() => blockedKey(p)}
            onReady={(h) => handles.current.set(p.id, h)}
          />
        ) : (
          <div className="empty">no live terminal in {p.id}</div>
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
            {t.label}
            {t.branch ? <span className="dim"> {t.branch}</span> : null}
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
        {inbox.length > 0 ? <span className="amber">● waits for you {inbox.length}</span> : null}
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
          {note ? (
            <div className="banner" role="status">
              {note}{" "}
              <button type="button" className="ghost" onClick={() => setNote(undefined)}>
                ✕
              </button>
            </div>
          ) : null}
          {tree ? (
            <SplitGrid tree={tree} zoom={zoom} renderPane={renderPane} onResize={(t) => void resize(t)} />
          ) : (
            <div className="empty">
              <h2>{tab ? "No pane in this tab" : "No tab"}</h2>
              <p>
                {key(keymap, "newShell") ?? "prefix+c"} opens a shell here;{" "}
                {key(keymap, "newTab") ?? "prefix+t"} starts a task in a new worktree; right-click the tab bar
                for the menu.
              </p>
            </div>
          )}
        </main>
      </div>
      {toast && (!tab || toast.runId !== tab.runId || true) ? (
        <button
          type="button"
          className="toast"
          data-testid="toast"
          onClick={() => {
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
          <span className="amber">?</span> {toast.question.agent ?? toast.question.source} asks:{" "}
          {toast.question.prompt}
          <kbd>↵</kbd> <span className="dim">answer in the pane</span>
        </button>
      ) : null}
      {menu ? (
        <ContextMenu at={menu} items={menu.items} label={menu.label} onClose={() => setMenu(undefined)} />
      ) : null}
      {goto ? <GotoPicker repos={repos} panes={panes} onPick={pick} onClose={() => setGoto(false)} /> : null}
    </div>
  );
}

const key = (map: KeyMap, action: string): string | undefined => map[action]?.[0];

const shellOf = (configured: string): string => {
  if (configured) return configured;
  try {
    return localStorage.getItem("metator.shell") || "sh";
  } catch {
    return "sh";
  }
};
