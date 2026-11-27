/**
 * A store per screen (ADR-0113): each copy of a screen has its own store; a part draws again only
 * when the value it reads changed; the Backlog's actions keep their state in the store.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Profiler, type ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { BodyField, LabelsField, TitleField } from "../src/features/backlog/new-task-form.tsx";
import { Backlog, type BacklogInit, type BacklogState } from "../src/features/backlog/state.ts";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import { createStateStore, type Store } from "../src/shared/daemon/daemon-store.ts";
import { type ActionState, IDLE, runAction } from "../src/shared/state/action.ts";
import { ScopeProvider, scopedStore, useScoped, useScopedApi } from "../src/shared/state/scoped-store.ts";

type Calls = Record<string, unknown[][]>;

/** A daemon whose client records each call and answers what `answers` says. */
function fakeDaemon(answers: Record<string, unknown> = {}): { daemon: Store<Daemon>; calls: Calls } {
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
    repo: "shop",
    url: "http://d",
    me: "ana",
    who: async () => "ana",
  }) as unknown as Store<Daemon>;
  return { daemon, calls };
}

/** The Backlog's store as the screen makes it. */
function backlog(daemon: Store<Daemon>, over: Partial<BacklogInit> = {}): StoreApi<BacklogState> {
  return createStore<BacklogState>()(
    Backlog.create({ daemon, routeId: undefined, draft: undefined, openRun: () => {}, ...over }),
  );
}

const issue = (over: Record<string, unknown> = {}) =>
  ({ id: "i001", title: "Flaky", status: "open", ...over }) as never;

describe("the Backlog's state", () => {
  test("a route's item wins over the one picked; the picked one comes back when the route names none", () => {
    const s = backlog(fakeDaemon().daemon, { routeId: "i002" });
    s.getState().pick("i003");
    expect([s.getState().picked, s.getState().routeId]).toEqual(["i003", "i002"]);
    s.getState().routeTo("i004");
    expect([s.getState().picked, s.getState().routeId]).toEqual([undefined, "i004"]);
  });

  test("a draft from another screen opens the form with its title and what it points at", () => {
    const s = backlog(fakeDaemon().daemon, { draft: { title: "From a pane", refs: [{ run: "r1" }] } });
    expect([s.getState().adding, s.getState().draft.title, s.getState().refs]).toEqual([
      true,
      "From a pane",
      [{ run: "r1" }],
    ]);
  });

  test("a blank title asks nothing and says why; a good one is sent trimmed, with its labels split", async () => {
    const { daemon, calls } = fakeDaemon({ addIssue: { ok: true, data: { id: "i009" } } });
    const s = backlog(daemon);
    s.getState().openForm();
    s.getState().edit("title", "   ");
    expect(await s.getState().add()).toBe(false);
    expect([calls.addIssue, s.getState().notice?.text]).toEqual([undefined, "a task needs a title"]);
    s.getState().edit("title", "  Flaky checkout ");
    s.getState().edit("labels", "ci, , tests");
    expect(await s.getState().add()).toBe(true);
    expect(calls.addIssue?.[0]?.[0]).toMatchObject({
      title: "Flaky checkout",
      labels: ["ci", "tests"],
      by: "ana",
    });
    // Added: the form closes empty, the new task is the one shown, the notice is gone.
    expect([s.getState().adding, s.getState().draft.title, s.getState().picked, s.getState().notice]).toEqual(
      [false, "", "i009", undefined],
    );
  });

  test("a start with no workflow and no plan asks nothing; with a plan it starts on the plan's own", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = backlog(daemon);
    expect(await s.getState().start(issue(), undefined)).toBe(false);
    expect(calls.startIssue).toBeUndefined();
    expect(s.getState().notice?.text).toContain("no workflow to start a run on");
    await s.getState().start(issue({ plan: { runId: "r1" } }), "mt-feature");
    expect(calls.startIssue?.[0]?.[1]).toEqual({});
    s.getState().want("mt-bugfix");
    await s.getState().start(issue({ plan: { runId: "r1" } }), "mt-bugfix");
    expect(calls.startIssue?.[1]?.[1]).toEqual({ workflow: "mt-bugfix" });
  });

  test("refused for uncommitted changes: the retry starts again from the last commit; closing forgets it", async () => {
    const refusal = { ok: false, error: { message: "uncommitted changes", details: { check: "tree" } } };
    const { daemon, calls } = fakeDaemon({ startIssue: refusal });
    const s = backlog(daemon);
    await s.getState().start(issue(), "mt-feature");
    expect([s.getState().notice?.text, typeof s.getState().retry]).toEqual([
      "uncommitted changes",
      "function",
    ]);
    s.getState().retry?.();
    await Promise.resolve();
    expect(calls.startIssue?.[1]?.[1]).toEqual({ workflow: "mt-feature", allowDirty: true });
    s.getState().closeNotice();
    expect([s.getState().notice, s.getState().retry]).toEqual([undefined, undefined]);
  });

  test("Done asks first: a no sends nothing", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = backlog(daemon);
    const confirm = mock(() => false);
    globalThis.window = { confirm } as never;
    expect(await s.getState().finish(issue(), "done")).toBe(false);
    expect([confirm.mock.calls.length, calls.closeIssue]).toEqual([1, undefined]);
  });
});

describe("an action in a screen's store", () => {
  test("busy while the request runs; the refusal stays as the notice; a cancelled name runs nothing", async () => {
    const store = createStore<ActionState>(() => IDLE);
    const { daemon } = fakeDaemon();
    let seen: boolean | undefined;
    await runAction(store, daemon, async () => {
      seen = store.getState().busy;
      return { ok: false, error: { message: "no" } };
    });
    expect([seen, store.getState().busy, store.getState().notice]).toEqual([
      true,
      false,
      { text: "no", tone: "error" },
    ]);
    const nobody = createStateStore({ me: "", who: async () => "" }) as unknown as Store<Daemon>;
    const request = mock(async () => ({ ok: true }));
    expect(await runAction(store, nobody, request, { who: true })).toBe(false);
    expect(request.mock.calls.length).toBe(0);
  });
});

/** The Backlog's store the last drawn part saw, for the test to act on. */
let grabbed: StoreApi<BacklogState> | undefined;
function Grab() {
  grabbed = useScopedApi(Backlog);
  return null;
}

interface CounterState {
  readonly n: number;
  up(): void;
}
const Counter = scopedStore<CounterState, number>("Counter", (start) => (set) => ({
  n: start,
  up: () => set((s) => ({ n: s.n + 1 })),
}));
const counters: StoreApi<CounterState>[] = [];
function Shown() {
  const n = useScoped(Counter, (s) => s.n);
  counters.push(useScopedApi(Counter));
  return <span>{n}</span>;
}

describe("parts that read a screen's store", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  /** How many times each named part committed. */
  const counted = (draws: Record<string, number>, id: string, children: ReactNode) => (
    <Profiler
      id={id}
      onRender={() => {
        draws[id] = (draws[id] ?? 0) + 1;
      }}
    >
      {children}
    </Profiler>
  );

  test("typing a title draws the title field again, not the other fields", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { daemon } = fakeDaemon();
    const draws: Record<string, number> = {};
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <ScopeProvider
          store={Backlog}
          init={{ daemon, routeId: undefined, draft: undefined, openRun: () => {} }}
        >
          <Grab />
          {counted(draws, "title", <TitleField />)}
          {counted(draws, "body", <BodyField />)}
          {counted(draws, "labels", <LabelsField />)}
        </ScopeProvider>,
      ),
    );
    expect(draws).toEqual({ title: 1, body: 1, labels: 1 });
    act(() => grabbed?.getState().edit("title", "F"));
    act(() => grabbed?.getState().edit("title", "Fl"));
    act(() => grabbed?.getState().pick("i002"));
    expect(draws).toEqual({ title: 3, body: 1, labels: 1 });
    act(() => root.unmount());
  });

  test("the provider drawn again keeps its store: what the screen kept stays, a new init is not read", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    counters.length = 0;
    const host = document.createElement("div");
    const root = createRoot(host);
    const draw = (start: number) =>
      root.render(
        <ScopeProvider store={Counter} init={start}>
          <Shown />
        </ScopeProvider>,
      );
    act(() => draw(1));
    act(() => counters[0]?.getState().up());
    act(() => draw(7));
    expect(host.textContent).toBe("2");
    act(() => root.unmount());
  });

  test("two copies of a screen have two stores", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    counters.length = 0;
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <>
          <ScopeProvider store={Counter} init={1}>
            <Shown />
          </ScopeProvider>
          <ScopeProvider store={Counter} init={10}>
            <Shown />
          </ScopeProvider>
        </>,
      ),
    );
    act(() => counters[0]?.getState().up());
    expect(host.textContent).toBe("210");
    act(() => root.unmount());
  });
});
