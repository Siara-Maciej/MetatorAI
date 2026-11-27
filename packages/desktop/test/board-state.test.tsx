/**
 * The Board's store (ADR-0113): the filter is kept, each board starts with Done folded, a drag's
 * note goes by itself, a start without a workflow asks nothing; typing a search draws the search
 * and the columns, not the chips; a tile draws again only when its own task changed.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createStore, type StoreApi } from "zustand/vanilla";
import { BoardColumn, BoardTile, RepoChip, SearchBoard } from "../src/features/board/board-screen.tsx";
import { Board, type BoardInit, type BoardState, columnOf } from "../src/features/board/state.ts";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import type { Store } from "../src/shared/daemon/daemon-store.ts";
import { NO_FILTER } from "../src/shared/model/board.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, drawRoot, fakeDaemon } from "./screen-kit.tsx";

const at = "2026-11-27T10:00:00.000Z";
const issue = (id: string, title = `task ${id}`) =>
  ({ id, title, status: "open", priority: "normal", createdAt: at, updatedAt: at }) as never;

const sources = (issues: Record<string, ReturnType<typeof issue>[]>) => ({
  runs: [],
  plans: [],
  repos: Object.keys(issues),
  issues: Object.entries(issues).map(([repo, list]) => ({ repo, issues: list })),
  issuesKey: "board-issues:shop,web",
  issuesError: undefined,
});

const init = (daemon: Store<Daemon>, over: Partial<BoardInit> = {}): BoardInit => ({
  daemon,
  openKey: undefined,
  filter: NO_FILTER,
  openRun: () => {},
  ...over,
});
const board = (daemon: Store<Daemon>, over: Partial<BoardInit> = {}): StoreApi<BoardState> =>
  createStore<BoardState>()(Board.create(init(daemon, over)));

describe("the Board's state", () => {
  test("a repository chip pressed twice lets it go; Done folds again on another board, not on the same", () => {
    const s = board(fakeDaemon().daemon, { openKey: "plan:p1" });
    s.getState().toggleRepo("shop");
    s.getState().toggleRepo("web");
    s.getState().toggleRepo("shop");
    s.getState().toggleState("blocked");
    expect([s.getState().filter.repos, s.getState().filter.states]).toEqual([["web"], ["blocked"]]);
    s.getState().showFinished();
    s.getState().routeTo("plan:p1");
    expect(s.getState().showDone).toBe(true);
    s.getState().routeTo(undefined);
    expect([s.getState().openKey, s.getState().showDone]).toEqual([undefined, false]);
  });

  test("a drag's note stays a few seconds, once, then goes", () => {
    const timers: (() => void)[] = [];
    const later = spyOn(globalThis, "setTimeout").mockImplementation(((f: () => void) => {
      timers.push(f);
      return 0;
    }) as never);
    const s = board(fakeDaemon().daemon);
    s.getState().drag();
    s.getState().drag();
    expect([s.getState().dragged, timers.length]).toEqual([true, 1]);
    timers[0]?.();
    expect(s.getState().dragged).toBe(false);
    later.mockRestore();
  });

  test("a start on a repository with no workflow asks nothing and says why; one with a workflow opens its run", async () => {
    const openRun = mock(() => {});
    const none = fakeDaemon({ workflows: { ok: true, data: { workflows: [] } } });
    const s = board(none.daemon, { openRun });
    const card = { key: "issue:shop/i1", kind: "issue", issueId: "i1", repo: "shop" } as never;
    expect(await s.getState().start(card)).toBe(false);
    expect([none.calls.startIssue, s.getState().notice?.text]).toEqual([
      undefined,
      "this repository has no workflow",
    ]);
    const some = fakeDaemon({
      workflows: { ok: true, data: { workflows: [{ id: "mt-feature" }] } },
      startIssue: { ok: true, data: { runId: "r7" } },
    });
    expect(await board(some.daemon, { openRun }).getState().start(card)).toBe(true);
    expect([some.calls.startIssue?.[0], openRun.mock.calls[0]]).toEqual([
      ["i1", { workflow: "mt-feature" }, "shop"],
      ["r7"],
    ]);
  });

  test("a step not started opens its detail; the tasks are fed and filtered into their columns", () => {
    const s = board(fakeDaemon().daemon);
    s.getState().openCard({ key: "step:/p1/s1", kind: "step", planId: "p1", stepId: "s1" } as never);
    expect(s.getState().stepOpen).toEqual({ planId: "p1", stepId: "s1", repo: undefined });
    s.getState().feed(sources({ shop: [issue("i1"), issue("i2", "Flaky checkout")], web: [issue("i3")] }));
    expect(columnOf(s.getState(), "todo", Date.now()).shown.length).toBe(3);
    s.getState().setText("flaky");
    expect(columnOf(s.getState(), "todo", Date.now()).shown.map((t) => t.task?.title)).toEqual([
      "Flaky checkout",
    ]);
  });
});

let grabbed: StoreApi<BoardState> | undefined;
function Grab() {
  grabbed = useScopedApi(Board);
  return null;
}

describe("parts of the Board", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("typing a search draws the search and the column whose cards changed, not the chips", async () => {
    const { daemon } = fakeDaemon();
    const draws: Record<string, number> = {};
    const r = await drawRoot();
    r.draw(
      <ScopeProvider store={Board} init={init(daemon)}>
        <Grab />
        {counted(draws, "search", <SearchBoard />)}
        {counted(draws, "shop", <RepoChip repo="shop" />)}
        {counted(draws, "web", <RepoChip repo="web" />)}
        {counted(draws, "todo", <BoardColumn column="todo" label="To do" index={0} />)}
        {counted(draws, "done", <BoardColumn column="done" label="Done" index={4} />)}
      </ScopeProvider>,
    );
    r.act(() =>
      grabbed?.getState().feed(sources({ shop: [issue("i1"), issue("i2", "Flaky")], web: [issue("i3")] })),
    );
    expect(draws).toEqual({ search: 1, shop: 1, web: 1, todo: 2, done: 1 });
    r.act(() => grabbed?.getState().setText("f"));
    r.act(() => grabbed?.getState().setText("fl"));
    // "f" and "fl" both leave only "Flaky": the column draws once, the chips never.
    expect(draws).toEqual({ search: 3, shop: 1, web: 1, todo: 3, done: 1 });
    r.act(() => grabbed?.getState().toggleRepo("web"));
    expect([draws.shop, draws.web]).toEqual([1, 2]);
    r.done();
  });

  test("a task that changed draws its own tile again, not the others", async () => {
    const { daemon } = fakeDaemon();
    const now = spyOn(Date, "now").mockReturnValue(Date.parse(at));
    const draws: Record<string, number> = {};
    const r = await drawRoot();
    r.draw(
      <ScopeProvider store={Board} init={init(daemon)}>
        <Grab />
        {counted(draws, "i1", <BoardTile tileKey="issue:shop/i1" col={0} row={0} />)}
        {counted(draws, "i2", <BoardTile tileKey="issue:shop/i2" col={0} row={1} />)}
      </ScopeProvider>,
    );
    r.act(() => grabbed?.getState().feed(sources({ shop: [issue("i1"), issue("i2")] })));
    const titles = () => [...r.host.querySelectorAll(".card-title")].map((x) => x.textContent);
    expect([titles(), draws]).toEqual([["task i1", "task i2"], { i1: 2, i2: 2 }]);
    // The daemon's answer again, i2 renamed: only i2's tile draws.
    r.act(() => grabbed?.getState().feed(sources({ shop: [issue("i1"), issue("i2", "renamed")] })));
    expect([titles(), draws]).toEqual([["task i1", "renamed"], { i1: 2, i2: 3 }]);
    now.mockRestore();
    r.done();
  });
});
