/**
 * What the Terminals screen keeps while it is open (ADR-0113): the tab and the pane chosen, the
 * filter and the grouping (kept by the window), the zoom, what the keys mean right now, the
 * terminals that just appeared, and what the last action answered. What the screen shows is made
 * from the daemon's state and these choices (`view.ts`) and kept here, shared with the last one,
 * so a part reads only the value it draws. The commands of the keys, the menus and the buttons
 * live here too.
 */

import { useStore } from "zustand";
import type { DaemonClient, InboxItem, PaneView, SplitNode } from "../../shared/api/api.ts";
import { shared } from "../../shared/api/query.ts";
import { confirmed } from "../../shared/confirm.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { closePaneQuestion } from "../../shared/model/confirm.ts";
import { keyLabel, keyMapOf, type WorkbenchCommand } from "../../shared/model/keys.ts";
import { decisionKey } from "../../shared/model/needs.ts";
import { paneStateOf } from "../../shared/model/panes.ts";
import { noHostText } from "../../shared/model/runs.ts";
import { navigate } from "../../shared/navigation.ts";
import { openHelp } from "../../shared/overlays.ts";
import {
  type ActionOptions,
  type ActionState,
  type Answer,
  asAction,
  IDLE as NO_ACTION,
  runAction,
  sayIn,
} from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import type { MenuItem } from "../../ui/context-menu.tsx";
import { draftInBacklog } from "../backlog/draft.ts";
import type { HostEditor } from "../repos/devcontainers.ts";
import { runControls } from "../runs/run-controls.ts";
import {
  closesWorkspace,
  type GotoRow,
  menuCommands,
  neighborPane,
  nextWaitingTab,
  repoOfTab,
  retryHost,
  tabOfPane,
  tabOfRun,
  type WorkbenchTab,
  workspaceOfPane,
} from "./model.ts";
import type { TerminalHandle } from "./terminal.tsx";
import {
  continueText,
  passes,
  showing,
  type TerminalFilter,
  type TerminalGrouping,
  type TerminalRow,
  terminalViewFromStorage,
  toggleHidden,
  toggleTaskHidden,
} from "./terminals.ts";
import {
  focusIn,
  keyIn,
  paneAt,
  rowAt,
  type TerminalsRoute,
  type TPane,
  type ViewDaemon,
  type WorkbenchModel,
  workbenchModel,
} from "./view.ts";

/** What the keys mean right now: one thing at a time. */
export type Mode =
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

export const IDLE: Mode = { kind: "none" };

const TERMINALS_STORE = "metator.terminals";
const TREE_NARROW = "metator.terminals.tree.narrow";

/** The filter and the grouping the window kept (read under try/catch: a window may have no storage). */
function readView(): { readonly filter: TerminalFilter; readonly grouping: TerminalGrouping } {
  try {
    return terminalViewFromStorage(window.localStorage.getItem(TERMINALS_STORE));
  } catch {
    return terminalViewFromStorage(null);
  }
}
function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A window without storage keeps it until it closes.
  }
}
function readNarrow(): boolean {
  try {
    return window.localStorage.getItem(TREE_NARROW) === "1";
  } catch {
    return false;
  }
}

/** One option's value (S1), or the fallback while the options are not here yet. */
const optionIn = <T>(d: Pick<Daemon, "options">, key: string, fallback: T): T =>
  (d.options.find((o) => o.key === key)?.value as T | undefined) ?? fallback;

/** What the screen gets from React when it opens, read at the moment of an act. */
export interface TerminalsEnv {
  /** "+ New chat": a chat with the agent that starts a task. */
  newChat(): void;
  /** A repository in a dev container opens VS Code on this computer, attached to it (round 21). */
  readonly hostEditor: HostEditor | undefined;
}

export interface TerminalsInit {
  readonly daemon: Store<Daemon>;
  readonly route: TerminalsRoute;
  readonly env: { readonly current: TerminalsEnv };
}

/** What the person chose that the view is made from. */
interface Choices {
  readonly route: TerminalsRoute;
  readonly repoId: string | undefined;
  readonly tabKey: string | undefined;
  readonly filter: TerminalFilter;
  readonly retiring: readonly string[];
  readonly focus: string | undefined;
  /** The route's pane that was shown already: shown once, when the layout knows it. */
  readonly shown: string | undefined;
  readonly zoom: string | undefined;
  /** The tab the zoom belongs to: a tab change drops it. */
  readonly zoomTab: string | undefined;
}

/** The view of the choices, with what follows from it: the route's pane shown, a zoom of another tab dropped. */
function settled(d: ViewDaemon, c: Choices): Choices & { readonly model: WorkbenchModel } {
  let at = c;
  let model = workbenchModel({ ...at, daemon: d });
  const want = at.route.showPane;
  // A pane asked for by the route: once the layout knows it, its tab and focus.
  if (want && at.shown !== want) {
    const t = tabOfPane(model.repos, want);
    if (t) {
      at = { ...at, shown: want, repoId: repoOfTab(model.repos, t.key)?.id, tabKey: t.key, focus: want };
      model = workbenchModel({ ...at, daemon: d });
    }
  }
  if (at.zoomTab !== model.tab?.key) at = { ...at, zoomTab: model.tab?.key, zoom: undefined };
  return { ...at, model };
}

/**
 * The new view, with its lists of keys and names the same arrays as before while they are equal: a
 * part that reads one draws again only when it changed. Panes stay the daemon's own objects (the same
 * while unchanged); tasks and rows are made again, and are compared by key, never by identity.
 */
const keptFrom = (before: WorkbenchModel, next: WorkbenchModel): WorkbenchModel => ({
  ...next,
  keys: shared(before.keys, next.keys),
  viewKeys: shared(before.viewKeys, next.viewKeys),
  folderRepos: shared(before.folderRepos, next.folderRepos),
  pending: shared(before.pending, next.pending),
});

/** The daemon's fields the view is made from: another value of one of them makes it again. */
const VIEW_FIELDS = ["runs", "panes", "repo", "repos", "systemPlans", "workspaces"] as const;

export interface TerminalsState extends ActionState, Choices {
  /** The daemon's store the screen was opened with: its parts read the daemon through it. */
  readonly daemon: Store<Daemon>;
  readonly grouping: TerminalGrouping;
  /** The tree of terminals folded to its narrow version, kept by the window. */
  readonly treeNarrow: boolean;
  /** A terminal gone to from a link: it flashes for a moment and is scrolled to. */
  readonly flash: string | undefined;
  readonly scrollTo: string | undefined;
  /** Terminals that appeared while the screen is open, marked new for a while; the newest in a toast. */
  readonly fresh: readonly string[];
  readonly freshToast: TerminalRow | undefined;
  /** What the keys mean right now. */
  readonly mode: Mode;
  /** The question toasts the person closed (`<run>/<question>`). */
  readonly dismissed: readonly string[];
  readonly model: WorkbenchModel;

  /** Follows the daemon while the screen is open; the returned function stops it and its timers. */
  connect(): () => void;
  routeTo(route: TerminalsRoute): void;
  chooseRepo(id: string): void;
  chooseTab(key: string): void;
  setFilter(f: TerminalFilter): void;
  setGrouping(g: TerminalGrouping): void;
  setTreeNarrow(narrow: boolean): void;
  /** The eye on a tree row: it and the terminals below it hidden, or shown again. */
  eye(key: string): void;
  taskEye(runId: string): void;
  focusOn(key: string | undefined): void;
  /** A terminal gone to from a link (↑ parent, ? asks, the tree, Show): focused, scrolled to, maybe flashed. */
  goTo(key: string, flash?: boolean): void;
  scrolled(): void;
  toggleZoom(key: string): void;
  setMode(m: Mode | ((m: Mode) => Mode)): void;
  /** The right-click menu of a pane or of the tab bar. */
  openMenu(
    at: { readonly x: number; readonly y: number },
    menus: readonly NonNullable<WorkbenchCommand["menu"]>[],
    p: TPane | undefined,
    t: WorkbenchTab | undefined,
    label: string,
  ): void;
  dismissToast(key: string): void;
  closeFreshToast(): void;
  /** The Show of the new-terminal toast. */
  showFresh(): void;
  setHandle(key: string, h: TerminalHandle): void;
  handle(key: string): TerminalHandle | undefined;
  /** Runs a command of `WORKBENCH_COMMANDS` on a pane and a tab; false when this screen has none of that name. */
  command(id: string, p: TPane | undefined, t: WorkbenchTab | undefined): boolean;
  attach(p: TPane): Promise<void>;
  /** A pane whose process ended, started again (D1). */
  retryPane(p: TPane): Promise<void>;
  /** A paused pane's own Continue: only that pane (`POST /panes/:pane/continue`). */
  continuePane(p: TPane): Promise<void>;
  /** Continue task (round 11): the whole task, started again where it stopped. */
  continueTask(): Promise<void>;
  closeFinished(): Promise<void>;
  /** A pane's Close: the tab with it when it is the tab's last. */
  closeFrame(p: TPane): void;
  /** A key typed into a pane the person does not hold (`ui.attachOnType`). */
  blockedKey(p: TPane): void;
  resize(tree: SplitNode): void;
  /** A row of the go-to picker. */
  pick(row: GotoRow): void;
  openToast(item: InboxItem): void;
  say(text: string | undefined, tone?: "error" | "info"): void;
  closeNotice(): void;
}

export const Terminals = scopedStore<TerminalsState, TerminalsInit>(
  "Terminals",
  ({ daemon, route, env }) =>
    (set, get, api) => {
      const d = () => daemon.getState();
      const client = (): DaemonClient => d().client;
      const model = () => get().model;
      const repoName = () => model().repoName;
      const keyOf = (p: TPane) => keyIn(model().view, p);
      /** The repository a pane is in (a task's panes are in several). */
      const repoOf = (p: TPane | undefined) => p?.repo ?? repoName();
      const controlsOf = (p: TPane | undefined) =>
        runControls(
          client(),
          asAction(api, daemon),
          d().me,
          d().run(p?.runId, repoOf(p)),
          env.current.hostEditor,
        );
      const act = (request: (by: string) => Promise<Answer>, options: ActionOptions = {}) =>
        runAction(api, daemon, request, options);
      const handles = new Map<string, TerminalHandle>();
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const later = (fn: () => void, ms: number) => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
        return t;
      };
      let flashTimer: ReturnType<typeof setTimeout> | undefined;
      // Known from the first answer that has terminals: before it, nothing is drawn to be new to.
      let known: Set<string> | undefined;
      const newRows = (rows: readonly TerminalRow[]): Partial<TerminalsState> => {
        if (!known) {
          if (rows.length > 0) known = new Set(rows.map((r) => r.key));
          return {};
        }
        const seen = known;
        const added = rows.filter((r) => !seen.has(r.key));
        if (added.length === 0) return {};
        for (const r of added) seen.add(r.key);
        const keys = added.map((r) => r.key);
        later(() => set((s) => ({ fresh: s.fresh.filter((k) => !keys.includes(k)) })), 8000);
        return { fresh: [...get().fresh, ...keys], freshToast: added[added.length - 1] };
      };
      /** The choices changed (or the daemon did): the view made again, shared with the last one. */
      const settle = (changes: Partial<Choices> = {}) => {
        const s = get();
        const next = settled(d(), { ...s, ...changes });
        set({ ...next, model: keptFrom(s.model, next.model), ...newRows(next.model.rows) });
      };
      const setFilter = (f: TerminalFilter) => {
        keep(TERMINALS_STORE, JSON.stringify({ filter: f, grouping: get().grouping }));
        settle({ filter: f });
      };
      /** Shows a tab, in the sidebar entry it sits under, with one of its panes focused. */
      const showTab = (t: WorkbenchTab, paneId?: string) =>
        settle({
          repoId: repoOfTab(model().repos, t.key)?.id,
          tabKey: t.key,
          ...(paneId ? { focus: paneId } : {}),
        });
      const retire = (key: string, on: boolean) =>
        settle({ retiring: on ? [...get().retiring, key] : get().retiring.filter((k) => k !== key) });
      /** A request whose answer is a pane: the pane gets the focus. */
      const opening = async (fn: () => ReturnType<DaemonClient["openPane"]>, refused?: string) => {
        let id: string | undefined;
        await act(
          async () => {
            const r = await fn();
            id = r.data?.id;
            return r;
          },
          refused ? { refused } : {},
        );
        if (id) set({ focus: id });
        return id;
      };
      const closeTab = async (t: WorkbenchTab, ask = true) => {
        if (ask && !window.confirm(`Close ${t.label} and its ${t.panes.length} pane(s)?`)) return;
        if (closesWorkspace(model().repos, t)) {
          await act(() => client().closeWorkspace(t.workspaceId, repoName()));
          return;
        }
        for (const id of t.panes) await act(() => client().closePane(id, repoName()));
      };
      /** Continues a run's paused panes and undriven runs, or one paused pane; says what the daemon did. */
      const continueThe = async (
        what: { readonly runId: string } | { readonly paneId: string },
        repo: string | undefined,
      ) => {
        let said: string | undefined;
        await act(
          async (by) => {
            const r =
              "runId" in what
                ? await client().continueRun(what.runId, by, repo)
                : await client().continuePane(what.paneId, by, repo);
            if (r.ok && r.data) said = continueText(r.data);
            return r;
          },
          { who: true, refused: "Nothing was continued" },
        );
        if (said) sayIn(api, said, "info");
      };
      const focusBy = (p: TPane | undefined, step: 1 | -1) =>
        set({ focus: neighborPane(model().tree, p && keyOf(p), step) });
      const runOfCommand = (p: TPane | undefined, t: WorkbenchTab | undefined) => p?.runId ?? t?.runId;
      /**
       * What every command does (model.ts `WORKBENCH_COMMANDS` names them): the keys, the two
       * right-click menus and the buttons of this screen all run these, on the focused pane or on
       * the one under the menu.
       */
      const commands: Record<string, (p: TPane | undefined, t: WorkbenchTab | undefined) => void> = {
        attach: (p) => p && void get().attach(p),
        release: (p) => void controlsOf(p).release(),
        zoom: (p) => set((s) => ({ zoom: s.zoom || !p ? undefined : keyOf(p) })),
        splitRight: (p) => p && void opening(() => client().splitPane(p.id, "right", repoName())),
        splitDown: (p) => p && void opening(() => client().splitPane(p.id, "down", repoName())),
        copyMode: (p) => p && set({ mode: { kind: "copy", pane: keyOf(p) } }),
        plan: (p, t) => {
          const runId = runOfCommand(p, t);
          if (runId) navigate({ screen: "run", runId, tab: "overview" });
        },
        changes: (p, t) => {
          const runId = runOfCommand(p, t);
          if (runId) navigate({ screen: "run", runId, tab: "changes" });
        },
        /** The editor on a pane's directory, or on the tab's run (its worktree). */
        editor: (p, t) => {
          const runId = t?.runId;
          const hostEditor = env.current.hostEditor;
          if (p)
            void act(hostEditor?.({ cwd: p.cwd }) ?? (() => client().openPaneEditor(p.id, repoName())), {
              done: "opened in the editor",
            });
          else if (runId)
            void act(
              hostEditor?.({ worktree: d().run(runId, repoName())?.worktree?.path }) ??
                (() => client().openEditor(runId, {}, repoName())),
              { done: "opened in the editor" },
            );
        },
        taskFromHere: (p) => draftInBacklog(p?.runId ? { refs: [{ run: p.runId }] } : {}),
        closePane: (p) => {
          if (!p) return;
          if (!confirmed(closePaneQuestion(p, optionIn(d(), "ui.confirmClosePane", true)))) return;
          void act(() => client().closePane(p.id, repoOf(p)));
        },
        newShellTab: () => {
          const repo = model().repo;
          if (!repo) return;
          void act(() =>
            client().openPane(
              {
                ...(repo.id === "repo" ? {} : { workspace: repo.id }),
                label: "shell",
                role: "shell",
                newTab: true,
              },
              repoName(),
            ),
          );
        },
        newTab: () => env.current.newChat(),
        backlog: () => draftInBacklog(),
        newShell: (_p, t) =>
          t &&
          void opening(() =>
            client().openPane(
              { workspace: t.workspaceId, tab: t.tabId, role: "shell", label: "shell" },
              repoName(),
            ),
          ),
        closeTab: (_p, t) => t && void closeTab(t),
        focusLeft: (p) => focusBy(p, -1),
        focusUp: (p) => focusBy(p, -1),
        focusRight: (p) => focusBy(p, 1),
        focusDown: (p) => focusBy(p, 1),
        goto: () => set({ mode: { kind: "goto" } }),
        nextWaiting: () => {
          const next = nextWaitingTab(model().repos, model().tab?.key);
          if (next) showTab(next);
        },
        help: () => openHelp(),
      };
      const view = readView();
      const first = settled(d(), {
        route,
        repoId: undefined,
        tabKey: undefined,
        filter: view.filter,
        retiring: [],
        focus: undefined,
        shown: undefined,
        zoom: undefined,
        zoomTab: undefined,
      });
      newRows(first.model.rows);
      return {
        ...NO_ACTION,
        ...first,
        daemon,
        grouping: view.grouping,
        treeNarrow: readNarrow(),
        flash: undefined,
        scrollTo: undefined,
        fresh: [],
        freshToast: undefined,
        mode: IDLE,
        dismissed: [],

        connect: () => {
          const off = daemon.subscribe((now, before) => {
            if (VIEW_FIELDS.some((k) => now[k] !== before[k])) settle();
          });
          // What changed between the first draw and now.
          settle();
          return () => {
            off();
            clearTimeout(flashTimer);
            for (const t of timers) clearTimeout(t);
            timers.clear();
          };
        },
        routeTo: (next) => {
          const r = get().route;
          if (
            r.task !== next.task ||
            r.session !== next.session ||
            r.group !== next.group ||
            r.showPane !== next.showPane
          )
            settle({ route: next });
        },
        chooseRepo: (id) => settle({ repoId: id, tabKey: undefined }),
        chooseTab: (key) => settle({ tabKey: key }),
        setFilter,
        setGrouping: (g) => {
          keep(TERMINALS_STORE, JSON.stringify({ filter: get().filter, grouping: g }));
          set({ grouping: g });
        },
        setTreeNarrow: (narrow) => {
          keep(TREE_NARROW, narrow ? "1" : "0");
          set({ treeNarrow: narrow });
        },
        eye: (key) => setFilter(toggleHidden(get().filter, model().rows, key)),
        taskEye: (runId) => setFilter(toggleTaskHidden(get().filter, model().rows, runId)),
        focusOn: (key) => set({ focus: key }),
        goTo: (key, flash = false) => {
          const s = get();
          const r = rowAt(s.model, key);
          if (!r) return;
          if (!passes(r, s.filter)) setFilter(showing(s.filter, r));
          // Not a tile of this view (a sub-terminal on a task's view): the All view has every terminal.
          if (s.model.view !== "all" && !s.model.viewKeys.includes(key))
            navigate({ screen: "grid", group: "all" });
          set((now) => ({
            zoom: now.zoom && now.zoom !== key ? undefined : now.zoom,
            focus: key,
            scrollTo: key,
            ...(flash ? { flash: key } : {}),
          }));
          if (flash) {
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => set({ flash: undefined }), 3000);
          }
        },
        scrolled: () => set({ scrollTo: undefined }),
        toggleZoom: (key) => set((s) => ({ zoom: s.zoom === key ? undefined : key })),
        setMode: (m) => set((s) => ({ mode: typeof m === "function" ? m(s.mode) : m })),
        openMenu: (at, menus, p, t, label) => {
          if (p) set({ focus: keyOf(p) });
          const c = controlsOf(p);
          const keymap = keyMapOf(d().options);
          const items: MenuItem[] = menuCommands(menus, {
            pane: p ? { runId: p.runId, role: p.role, asks: paneStateOf(p) === "asks" } : undefined,
            attached: c.attached,
            taken: c.taken,
            zoomed: p !== undefined && get().zoom === keyOf(p),
            tab: t ? { kind: t.kind, runId: t.runId, panes: t.panes.length } : undefined,
          }).map((x) => ({
            label: x.label,
            key: keyLabel(keymap, x.id),
            separator: x.separator,
            disabled: x.disabled,
            onSelect: () => commands[x.id]?.(p, t),
          }));
          set({ mode: { kind: "menu", x: at.x, y: at.y, items, label } });
        },
        dismissToast: (key) => set((s) => ({ dismissed: [...s.dismissed, key] })),
        closeFreshToast: () => set({ freshToast: undefined }),
        showFresh: () => {
          const t = get().freshToast;
          if (!t) return;
          get().goTo(t.key, true);
          set({ freshToast: undefined });
        },
        setHandle: (key, h) => {
          handles.set(key, h);
        },
        handle: (key) => handles.get(key),
        command: (id, p, t) => {
          const run = commands[id];
          if (!run) return false;
          run(p, t);
          return true;
        },
        attach: async (p) => {
          await controlsOf(p).attach();
          set({ focus: keyOf(p) });
          handles.get(keyOf(p))?.focus();
        },
        retryPane: async (p) => {
          const repo = repoName();
          // A run's conductor is resumed in place.
          if (p.role === "conductor" && p.runId) {
            const runId = p.runId;
            await act(() => client().ptyOpen(runId, repo), { refused: "The session did not start" });
            return;
          }
          // Any other pane gets a new one beside it with the same program, and the dead one goes; the
          // dead one is not drawn from the click on, so the two are never on the screen together.
          const key = keyOf(p);
          retire(key, true);
          let process: { argv: string[] } | { host: string; agent: string; prompt: string };
          if (p.process.kind === "command") process = { argv: [...p.process.argv] };
          else {
            // The host the pane had, when it is installed; else the first installed one of the order.
            const s = await client().supervisor(repo);
            const host = retryHost(p.process.host, s.data?.policy.hostOrder ?? [], s.data?.hostStatus);
            if (!host) {
              retire(key, false);
              sayIn(api, noHostText(s.data?.hostStatus ?? []));
              return;
            }
            process = { host, agent: p.process.agent, prompt: p.process.prompt };
          }
          const id = await opening(
            () =>
              client().openPane(
                { workspace: workspaceOfPane(p), tab: p.tab, role: p.role, label: p.label, ...process },
                repo,
              ),
            "The pane did not start",
          );
          if (!id) {
            retire(key, false);
            return;
          }
          const closed = await client().closePane(p.id, repo);
          // Still there: it is drawn again, with what the daemon said.
          if (!closed.ok) {
            retire(key, false);
            sayIn(api, closed.error?.message ?? "the pane was not closed");
          }
        },
        continuePane: (p) => continueThe({ paneId: p.id }, repoOf(p)),
        continueTask: async () => {
          const chosen = model().chosen;
          if (chosen) await continueThe({ runId: chosen.runId }, chosen.repo);
        },
        closeFinished: async () => {
          for (const p of model().endedHere) await act(() => client().closePane(p.id, repoOf(p)));
        },
        closeFrame: (p) => {
          const { view, tab, keys } = model();
          if (view === "tabs" && tab && keys.length === 1) void closeTab(tab, false);
          else void act(() => client().closePane(p.id, repoOf(p)));
        },
        blockedKey: (p) => {
          const how = optionIn<"ask" | "always" | "never">(d(), "ui.attachOnType", "ask");
          if (how === "never") return;
          if (how === "always") void get().attach(p);
          else set({ mode: { kind: "ask", pane: keyOf(p) } });
        },
        resize: (tree) => {
          const tab = model().tab;
          if (tab) void act(() => client().setTree(tab.tabId, tree, repoName()));
        },
        pick: (row) => {
          set({ mode: IDLE });
          if (row.task) {
            navigate({ screen: "grid", task: row.task.runId, session: row.task.session });
            const focus = row.focusKey ?? row.paneId;
            if (focus) set({ focus });
            return;
          }
          const t = row.tab;
          if (!t) return;
          showTab(
            t,
            row.paneId ?? model().panes.find((p) => p.runId === t.runId && p.role === "conductor")?.id,
          );
        },
        openToast: (toast) => {
          // The host's own prompt is answered in its pane; every other question on its card.
          if (toast.question.source !== "permission") {
            navigate({ screen: "inbox", pick: decisionKey(toast) });
            return;
          }
          const conductor = model().panes.find((p) => p.runId === toast.runId && p.role === "conductor");
          const t = tabOfRun(model().repos, toast.runId);
          if (t) showTab(t);
          if (conductor) void get().attach(conductor);
        },
        say: (text, tone = "error") => sayIn(api, text, tone),
        closeNotice: () => sayIn(api, undefined),
      };
    },
);

/** One value of the Terminals' state: the part draws again only when it changed. */
export const useTerminals = <T>(select: (s: TerminalsState) => T): T => useScoped(Terminals, select);
/** The store at the moment of an event: no subscription. */
export const useTerminalsApi = () => useScopedApi(Terminals);

/** One value of the daemon's state (the screen's daemon): the part draws again only when it changed. */
export const useTerminalsDaemon = <T>(select: (d: Daemon) => T): T =>
  useStore(
    useTerminals((s) => s.daemon),
    select,
  );
/** The value of one option (S1), or the fallback while the options are not here yet. */
export const useTerminalsOption = <T>(key: string, fallback: T): T =>
  useTerminalsDaemon((d) => optionIn(d, key, fallback));

/** The key of the focused pane. */
export const focusKeyOf = (s: TerminalsState): string | undefined => focusIn(s.model, s.focus);
/** The focused pane, for a key's command. */
export const focusedOf = (s: TerminalsState): TPane | undefined => paneAt(s.model, focusKeyOf(s));
/** A pane of the shown repository by its id (the ask's pane when its key is not drawn). */
export const paneById = (s: TerminalsState, id: string): PaneView | undefined =>
  s.model.panes.find((p) => p.id === id);
