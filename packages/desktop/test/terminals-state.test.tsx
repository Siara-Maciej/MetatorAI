/**
 * The Terminals screen and a run's Terminal tab keep their state in a store per screen (ADR-0113):
 * the stores' transitions, and for each hot path (focusing a pane, typing in the go-to picker,
 * a toggle, typing a line) which parts draw again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Profiler, type ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { Composer, PaneTabs } from "../src/features/runs/terminal-tab.tsx";
import { paneFacts, TerminalTab, type TerminalTabState } from "../src/features/runs/terminal-tab-state.ts";
import { FilterBar, TaskTiles, TerminalsBar } from "../src/features/terminals/by-task-view.tsx";
import { FilterChip, GotoHint, GotoInput, GotoRows } from "../src/features/terminals/goto.tsx";
import { Goto, type GotoState } from "../src/features/terminals/goto-state.ts";
import {
  focusKeyOf,
  Terminals,
  type TerminalsInit,
  type TerminalsState,
} from "../src/features/terminals/state.ts";
import { TerminalTree, TreeNode } from "../src/features/terminals/terminal-tree.tsx";
import { Tile } from "../src/features/terminals/tile.tsx";
import type { TerminalsRoute } from "../src/features/terminals/view.ts";
import { ThreadChat, ThreadHead, ThreadTasks } from "../src/features/threads/thread-screen.tsx";
import { Thread, type ThreadState } from "../src/features/threads/thread-state.ts";
import type { PaneView } from "../src/shared/api/api.ts";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import { createStateStore, type Store } from "../src/shared/daemon/daemon-store.ts";
import { type ScopedStore, ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";

type Calls = Record<string, unknown[][]>;
type TPane = PaneView & { readonly repo?: string };

const pane = (id: string, extra: Partial<PaneView> = {}): TPane =>
  ({
    id,
    tab: "w1:t1",
    role: "worker",
    label: id,
    cwd: "/x",
    process: { kind: "command", argv: ["sh"] },
    createdAt: "2026-11-19T10:00:00.000Z",
    state: { state: "idle" },
    ...extra,
  }) as never;

/** One task (run r1): its conductor and two workers; a shell tab beside it. */
const PANES: TPane[] = [
  pane("w1:p1", { runId: "r1", role: "conductor", label: "conductor" }),
  pane("w1:p2", { runId: "r1", label: "mt-implementer-1" }),
  pane("w1:p3", { runId: "r1", label: "mt-test-author-1" }),
  pane("w1:p4", {
    tab: "w1:t2",
    role: "shell",
    label: "shell",
    ended: { at: "2026-11-19T10:05:00.000Z", reason: "exit" } as never,
  }),
];
const RUNS = [
  {
    runId: "r1",
    task: "Fix the flaky checkout",
    status: "active",
    questions: [],
    stages: [],
    updatedAt: "2026-11-19T10:00:00.000Z",
  },
];
const WORKSPACES = [
  {
    id: "w1",
    label: "shop",
    cwd: "/x",
    tabs: [
      { id: "w1:t1", label: "agents", panes: ["w1:p1", "w1:p2", "w1:p3"] },
      { id: "w1:t2", label: "shell", panes: ["w1:p4"] },
    ],
  },
];

/** A daemon whose client records each call and answers what `answers` says. */
function fakeDaemon(answers: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const calls: Calls = {};
  const client = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        async (...args: unknown[]) => {
          calls[name] = [...(calls[name] ?? []), args];
          return answers[name] ?? { ok: true, data: undefined };
        },
    },
  );
  const daemon = createStateStore({
    client,
    url: "http://d",
    me: "ana",
    who: async () => "ana",
    repo: undefined,
    repos: [],
    runs: RUNS,
    panes: PANES,
    systemPlans: [],
    workspaces: WORKSPACES,
    options: [],
    inbox: [],
    paneAsks: [],
    ...over,
  }) as unknown as Store<Daemon>;
  // `run` and `panesOf` read the state they are part of, as the daemon's own do.
  const bind = () => {
    const s = daemon.getState() as unknown as Record<string, unknown>;
    daemon.setState({
      run: (runId: string | undefined) => (s.runs as typeof RUNS).find((r) => r.runId === runId),
      panesOf: () => s.panes,
    } as never);
  };
  bind();
  daemon.subscribe((now, before) => {
    if (now.runs !== before.runs || now.panes !== before.panes) bind();
  });
  return { daemon, calls };
}

const env = () => ({ current: { newChat: mock(() => {}), hostEditor: undefined } });

function terminals(daemon: Store<Daemon>, route: TerminalsRoute): StoreApi<TerminalsState> {
  return createStore<TerminalsState>()(Terminals.create({ daemon, route, env: env() }));
}

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
// The window keeps the Terminals' filter: each test starts without one.
beforeEach(() => window.localStorage.clear());

describe("the Terminals' state", () => {
  test("the route chooses the view: every terminal, a task's session, the workspaces' tabs", () => {
    const { daemon } = fakeDaemon();
    const s = terminals(daemon, { group: "all" });
    expect([s.getState().model.view, s.getState().model.keys]).toEqual(["all", ["w1:p1", "w1:p2", "w1:p3"]]);
    s.getState().routeTo({ task: "r1", session: "r1" });
    expect(s.getState().model.view).toBe("session");
    s.getState().routeTo({ group: "workspaces" });
    expect([s.getState().model.view, s.getState().model.tab?.key]).toEqual(["tabs", "w1:t1"]);
  });

  test("a pane asked for by the route: its tab, and the focus", () => {
    const s = terminals(fakeDaemon().daemon, { group: "workspaces", showPane: "w1:p4" });
    expect([s.getState().model.tab?.key, s.getState().shown, focusKeyOf(s.getState())]).toEqual([
      "w1:t2",
      "w1:p4",
      "w1:p4",
    ]);
  });

  test("the focus is the pane chosen while it is drawn, else the first", () => {
    const s = terminals(fakeDaemon().daemon, { group: "all" });
    expect(focusKeyOf(s.getState())).toBe("w1:p1");
    s.getState().focusOn("w1:p3");
    expect(focusKeyOf(s.getState())).toBe("w1:p3");
    s.getState().focusOn("gone");
    expect(focusKeyOf(s.getState())).toBe("w1:p1");
    // focusRight goes around the leaves.
    s.getState().focusOn("w1:p3");
    s.getState().command("focusRight", s.getState().model.tabPanes[2], undefined);
    expect(focusKeyOf(s.getState())).toBe("w1:p1");
    expect(s.getState().command("noSuchCommand", undefined, undefined)).toBe(false);
  });

  test("going to a hidden terminal opens the filter just enough, focuses it and flashes it", () => {
    const s = terminals(fakeDaemon().daemon, { group: "all" });
    s.getState().setFilter({ ...s.getState().filter, panes: ["w1:p2"] });
    expect(s.getState().model.keys).toEqual(["w1:p1", "w1:p3"]);
    s.getState().goTo("w1:p2", true);
    expect([
      s.getState().model.keys.includes("w1:p2"),
      s.getState().focus,
      s.getState().scrollTo,
      s.getState().flash,
    ]).toEqual([true, "w1:p2", "w1:p2", "w1:p2"]);
    // The window keeps the filter.
    expect(JSON.parse(window.localStorage.getItem("metator.terminals") ?? "{}").filter.panes).toEqual([]);
  });

  test("the zoom is the tab's: another tab drops it", () => {
    const s = terminals(fakeDaemon().daemon, { group: "workspaces" });
    s.getState().toggleZoom("w1:p2");
    expect(s.getState().zoom).toBe("w1:p2");
    s.getState().chooseTab("w1:t2");
    expect(s.getState().zoom).toBeUndefined();
  });

  test("Retry hides the dead pane at once; a refused start draws it again with what was said", async () => {
    const refused = { ok: false, error: { message: "no shell" } };
    const { daemon, calls } = fakeDaemon({ openPane: refused });
    const s = terminals(daemon, { group: "workspaces" });
    s.getState().chooseTab("w1:t2");
    const dead = s.getState().model.tabPanes[0] as TPane;
    const retry = s.getState().retryPane(dead);
    expect(s.getState().model.keys).toEqual([]);
    await retry;
    expect(calls.openPane?.[0]?.[0]).toMatchObject({ argv: ["sh"], role: "shell" });
    expect([s.getState().model.keys, s.getState().notice?.text]).toEqual([["w1:p4"], "no shell"]);
    expect(calls.closePane).toBeUndefined();
  });

  test("a terminal that appears while the screen is open is new, and said in a toast", () => {
    const { daemon } = fakeDaemon();
    const s = terminals(daemon, { group: "all" });
    const stop = s.getState().connect();
    expect(s.getState().fresh).toEqual([]);
    daemon.setState({
      panes: [...PANES, pane("w1:p5", { runId: "r1", label: "gate", role: "gate" })],
    } as never);
    expect([s.getState().fresh, s.getState().freshToast?.key]).toEqual([["w1:p5"], "w1:p5"]);
    stop();
  });

  test("a key typed into a pane the person does not hold asks to take the keyboard (ui.attachOnType)", () => {
    const s = terminals(fakeDaemon().daemon, { group: "all" });
    s.getState().blockedKey(s.getState().model.tabPanes[1] as TPane);
    expect(s.getState().mode).toEqual({ kind: "ask", pane: "w1:p2" });
  });
});

describe("the go-to picker's state", () => {
  test("words and a state point at the first row again; the pointer stays within the rows", () => {
    const s = createStore<GotoState>()(Goto.create(undefined));
    s.getState().move(1, 3);
    s.getState().move(1, 3);
    s.getState().move(1, 3);
    expect(s.getState().index).toBe(2);
    s.getState().type("imp");
    expect([s.getState().query, s.getState().index]).toEqual(["imp", 0]);
    s.getState().move(-1, 3);
    expect(s.getState().index).toBe(0);
    s.getState().point(1);
    s.getState().choose("asks");
    expect([s.getState().filter, s.getState().index]).toEqual(["asks", 0]);
  });
});

describe("the Terminal tab's state", () => {
  const tab = (daemon: Store<Daemon>, pane?: string) =>
    createStore<TerminalTabState>()(TerminalTab.create({ daemon, runId: "r1", repo: undefined, pane }));

  test("the pane shown: the one chosen while the run has it, else the conductor", () => {
    expect(paneFacts(PANES, "w1:p2", false)).toMatchObject({
      shown: "w1:p2",
      conductor: "w1:p1",
      noTerminal: false,
    });
    expect(paneFacts(PANES, "gone", false)).toMatchObject({
      shown: "w1:p1",
      noTerminal: true,
      nothingLives: true,
    });
    expect(paneFacts(PANES, undefined, true).noTerminal).toBe(false);
  });

  test("the route's pane wins only when the route changes", () => {
    const s = tab(fakeDaemon().daemon, "w1:p2");
    s.getState().choose("w1:p3");
    s.getState().routeTo("w1:p2");
    expect(s.getState().chosen).toBe("w1:p3");
    s.getState().routeTo("w1:p1");
    expect(s.getState().chosen).toBe("w1:p1");
  });

  test("the run's own terminal is shown once its session lived, and stays", () => {
    const { daemon } = fakeDaemon();
    const s = tab(daemon);
    const stop = s.getState().connect();
    expect(s.getState().opened).toBe(false);
    const alive = { alive: true, sessionId: "s1", lastOutputAt: "2026-11-19T10:00:00.000Z" };
    daemon.setState({ panes: PANES.map((p) => (p.id === "w1:p1" ? { ...p, live: alive } : p)) } as never);
    expect(s.getState().opened).toBe(true);
    daemon.setState({ panes: PANES } as never);
    expect(s.getState().opened).toBe(true);
    stop();
  });

  test("Send while the person does not hold the keyboard attaches first; a new shell is the pane shown", async () => {
    const { daemon, calls } = fakeDaemon({ openPane: { ok: true, data: { id: "w1:p9" } } });
    const s = tab(daemon);
    s.getState().type("yes");
    await s.getState().send();
    expect([calls.attach?.[0]?.slice(0, 2), s.getState().line]).toEqual([["r1", "ana"], "yes"]);
    await s.getState().openShell();
    expect([calls.openPane?.[0]?.[0], s.getState().chosen]).toEqual([
      { runId: "r1", role: "shell", label: "shell" },
      "w1:p9",
    ]);
  });

  test("closing a pane that lives asks first; a no closes nothing", async () => {
    const alive = { alive: true, sessionId: "s2", lastOutputAt: "2026-11-19T10:00:00.000Z" };
    const { daemon, calls } = fakeDaemon({}, {});
    daemon.setState({ panes: PANES.map((p) => (p.id === "w1:p2" ? { ...p, live: alive } : p)) } as never);
    const s = tab(daemon, "w1:p2");
    const confirm = mock(() => false);
    window.confirm = confirm;
    await s.getState().close("w1:p2");
    expect([confirm.mock.calls.length, calls.closePane, s.getState().chosen]).toEqual([
      1,
      undefined,
      "w1:p2",
    ]);
    confirm.mockImplementation(() => true);
    await s.getState().close("w1:p2");
    expect([calls.closePane?.length, s.getState().chosen]).toEqual([1, undefined]);
  });
});

/* ---------- which parts draw again ---------- */

/** How many times each named part committed. */
const counted = (draws: Record<string, number>, id: string, children: ReactNode) => (
  <Profiler
    key={id}
    id={id}
    onRender={() => {
      draws[id] = (draws[id] ?? 0) + 1;
    }}
  >
    {children}
  </Profiler>
);

/** The store the last drawn part saw, for the test to act on. */
let grabbed: StoreApi<unknown> | undefined;
function Grab<S, I>({ store }: { readonly store: ScopedStore<S, I> }) {
  grabbed = useScopedApi(store) as StoreApi<unknown>;
  return null;
}
const the = <S,>() => (grabbed as StoreApi<S>).getState();

async function draw(node: ReactNode) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.createElement("div"));
  act(() => root.render(node));
  return {
    act: (fn: () => void) => act(fn),
    done: () => act(() => root.unmount()),
  };
}

const KEYS = ["w1:p1", "w1:p2", "w1:p3"];

function inTerminals(daemon: Store<Daemon>, route: TerminalsRoute, children: ReactNode) {
  const init: TerminalsInit = { daemon, route, env: env() };
  return (
    <ScopeProvider store={Terminals} init={init}>
      <Grab store={Terminals} />
      {children}
    </ScopeProvider>
  );
}

describe("parts of the Terminals that read the store", () => {
  test("focusing a pane draws the two frames and the two tree nodes that changed, nothing else", async () => {
    const draws: Record<string, number> = {};
    const r = await draw(
      inTerminals(
        fakeDaemon().daemon,
        { group: "all" },
        <>
          {counted(draws, "bar", <TerminalsBar />)}
          {counted(draws, "filters", <FilterBar />)}
          {KEYS.map((k) => counted(draws, `tile ${k}`, <Tile paneKey={k} />))}
          {KEYS.map((k) => counted(draws, `node ${k}`, <TreeNode rowKey={k} narrow={false} />))}
        </>,
      ),
    );
    const first = { ...draws };
    r.act(() => the<TerminalsState>().focusOn("w1:p2"));
    const again = Object.fromEntries(Object.entries(draws).map(([k, n]) => [k, n - (first[k] ?? 0)]));
    expect(again).toEqual({
      bar: 0,
      filters: 0,
      "tile w1:p1": 1,
      "tile w1:p2": 1,
      "tile w1:p3": 0,
      "node w1:p1": 1,
      "node w1:p2": 1,
      "node w1:p3": 0,
    });
    r.done();
  });

  test("a zoom draws the tiles' box; the zoomed tile, the bar, the filters and the tree stay", async () => {
    const draws: Record<string, number> = {};
    const r = await draw(
      inTerminals(
        fakeDaemon().daemon,
        { task: "r1", session: "r1" },
        <>
          {counted(draws, "filters", <FilterBar />)}
          {counted(draws, "tree", <TerminalTree />)}
          {counted(draws, "tiles", <TaskTiles />)}
        </>,
      ),
    );
    const first = { ...draws };
    r.act(() => the<TerminalsState>().toggleZoom("w1:p2"));
    expect(the<TerminalsState>().zoom).toBe("w1:p2");
    expect(Object.fromEntries(Object.entries(draws).map(([k, n]) => [k, n - (first[k] ?? 0)]))).toEqual({
      filters: 0,
      tree: 0,
      // The box of tiles, once; the zoomed tile is the same element and does not draw again.
      tiles: 1,
    });
    r.done();
  });

  test("a filter chip and the grouping draw the filters and what they hide; the tree's fold only the tree", async () => {
    const draws: Record<string, number> = {};
    const r = await draw(
      inTerminals(
        fakeDaemon().daemon,
        { group: "all" },
        <>
          {counted(draws, "bar", <TerminalsBar />)}
          {counted(draws, "filters", <FilterBar />)}
          {counted(draws, "tree", <TerminalTree />)}
          {KEYS.map((k) => counted(draws, `tile ${k}`, <Tile paneKey={k} />))}
        </>,
      ),
    );
    let before = { ...draws };
    const since = () => {
      const d = Object.fromEntries(Object.entries(draws).map(([k, n]) => [k, n - (before[k] ?? 0)]));
      before = { ...draws };
      return d;
    };
    r.act(() => the<TerminalsState>().setGrouping("repo"));
    since();
    // From one grouping that names the task on each tile to another: the tiles stay.
    r.act(() => the<TerminalsState>().setGrouping("flat"));
    expect(since()).toEqual({
      bar: 0,
      filters: 1,
      tree: 0,
      "tile w1:p1": 0,
      "tile w1:p2": 0,
      "tile w1:p3": 0,
    });
    r.act(() => the<TerminalsState>().setTreeNarrow(true));
    expect(since()).toEqual({
      bar: 0,
      filters: 0,
      tree: 1,
      "tile w1:p1": 0,
      "tile w1:p2": 0,
      "tile w1:p3": 0,
    });
    r.act(() => the<TerminalsState>().setFilter({ ...the<TerminalsState>().filter, text: "test" }));
    const after = since();
    // The filters show the new count; the tree dims the hidden nodes; the bar stays.
    expect([after.bar, after.filters, after.tree]).toEqual([0, 1, 1]);
    r.done();
  });

  test("typing in the go-to picker draws its field and its rows, not the state chips or the hint; a state draws the two chips that changed", async () => {
    const draws: Record<string, number> = {};
    const { daemon } = fakeDaemon();
    const s = terminals(daemon, { group: "all" });
    const m = s.getState().model;
    const data = { repos: m.repos, panes: m.panes, taskRows: m.gotoTaskRows };
    const r = await draw(
      <ScopeProvider store={Goto} init={undefined}>
        <Grab store={Goto} />
        {counted(draws, "input", <GotoInput data={data} onPick={() => {}} onClose={() => {}} />)}
        {counted(draws, "all", <FilterChip id="all" label="all" hotkey="a" />)}
        {counted(draws, "asks", <FilterChip id="asks" label="asks" hotkey="b" />)}
        {counted(draws, "working", <FilterChip id="working" label="working" hotkey="w" />)}
        {counted(draws, "rows", <GotoRows data={data} onPick={() => {}} />)}
        {counted(draws, "hint", <GotoHint />)}
      </ScopeProvider>,
    );
    expect(draws).toEqual({ input: 1, all: 1, asks: 1, working: 1, rows: 1, hint: 1 });
    r.act(() => the<GotoState>().type("i"));
    r.act(() => the<GotoState>().type("im"));
    expect(draws).toEqual({ input: 3, all: 1, asks: 1, working: 1, rows: 3, hint: 1 });
    r.act(() => the<GotoState>().choose("asks"));
    expect(draws).toEqual({ input: 3, all: 2, asks: 2, working: 1, rows: 4, hint: 1 });
    r.done();
  });
});

describe("parts of the Terminal tab that read the store", () => {
  test("typing a line draws the composer only; choosing another pane draws the pane tabs only", async () => {
    const draws: Record<string, number> = {};
    const { daemon } = fakeDaemon();
    const r = await draw(
      <ScopeProvider store={TerminalTab} init={{ daemon, runId: "r1", repo: undefined, pane: "w1:p2" }}>
        <Grab store={TerminalTab} />
        {counted(draws, "composer", <Composer runId="r1" repo={undefined} />)}
        {counted(draws, "panes", <PaneTabs runId="r1" repo={undefined} />)}
      </ScopeProvider>,
    );
    expect(draws).toEqual({ composer: 1, panes: 1 });
    r.act(() => the<TerminalTabState>().type("y"));
    r.act(() => the<TerminalTabState>().type("ye"));
    expect(draws).toEqual({ composer: 3, panes: 1 });
    // From one worker to another: the composer can type to both, so it does not draw again.
    r.act(() => the<TerminalTabState>().choose("w1:p3"));
    expect(draws).toEqual({ composer: 3, panes: 2 });
    r.done();
  });
});

/* ---------- a chat's screen ---------- */

const THREAD = {
  id: "t1",
  title: "Checkout chat",
  state: "open",
  panes: [{ paneId: "w1:p4" }],
  runs: ["r1"],
  chat: { status: "live" },
  updatedAt: "2026-11-19T10:00:00.000Z",
};
const chatDaemon = () => {
  const reloadThreads = mock(async () => {});
  const made = fakeDaemon({}, { threads: [THREAD], reloadThreads });
  return { ...made, reloadThreads };
};

describe("a chat's screen", () => {
  test("Close chat asks first while its chat lives; a no closes nothing", async () => {
    const { daemon, calls } = chatDaemon();
    const alive = { alive: true, sessionId: "s4", lastOutputAt: "2026-11-19T10:00:00.000Z" };
    daemon.setState({
      panes: PANES.map((p) => (p.id === "w1:p4" ? { ...p, ended: undefined, live: alive } : p)),
    } as never);
    const s = createStore<ThreadState>()(Thread.create({ daemon, id: "t1" }));
    const confirm = mock(() => false);
    window.confirm = confirm;
    await s.getState().close();
    expect([confirm.mock.calls.length, calls.closeThread]).toEqual([1, undefined]);
    confirm.mockImplementation(() => true);
    await s.getState().close();
    expect(calls.closeThread?.[0]?.slice(0, 2)).toEqual(["t1", "ana"]);
  });

  test("a run that changes draws the bar's word and the tasks again, not the chat's terminal", async () => {
    const draws: Record<string, number> = {};
    const { daemon } = chatDaemon();
    const r = await draw(
      <ScopeProvider store={Thread} init={{ daemon, id: "t1" }}>
        {counted(draws, "head", <ThreadHead />)}
        {counted(draws, "chat", <ThreadChat />)}
        {counted(draws, "tasks", <ThreadTasks />)}
      </ScopeProvider>,
    );
    expect(draws).toEqual({ head: 1, chat: 1, tasks: 1 });
    r.act(() => daemon.setState({ runs: RUNS.map((x) => ({ ...x, status: "done" })) } as never));
    expect(draws).toEqual({ head: 2, chat: 1, tasks: 2 });
    // Its chat's pane changes: the terminal draws again, the bar and the tasks do not.
    r.act(() =>
      daemon.setState({ panes: PANES.map((p) => (p.id === "w1:p4" ? { ...p, label: "chat" } : p)) } as never),
    );
    expect(draws).toEqual({ head: 2, chat: 2, tasks: 2 });
    r.done();
  });
});
