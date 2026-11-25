import { describe, expect, test } from "bun:test";
import type { BoardCard } from "../src/shared/model/board.ts";
import { lookOf } from "../src/shared/model/look.ts";
import { parseRoute, routeHash } from "../src/shared/model/route.ts";
import type { WorkTask } from "../src/shared/model/tasks.ts";
import {
  chatTitleOf,
  followedThread,
  heldThread,
  type ThreadLike,
  TITLE_MAX,
  threadLine,
  threadOfTask,
  threadPane,
  threadsStamp,
  threadTitleOf,
  threadTree,
  threadWord,
  WITHOUT_CHAT,
} from "../src/shared/model/threads.ts";

const card = (runId: string, over: Partial<BoardCard> = {}): BoardCard => ({
  key: `run:${runId}`,
  kind: "run",
  column: "in-progress",
  title: runId,
  state: "working",
  ageMs: 0,
  updatedAt: "2026-11-20T10:00:00Z",
  needsYou: false,
  escalated: false,
  runId,
  ...over,
});

const task = (runId: string, over: Partial<WorkTask> = {}): WorkTask => {
  const head = card(runId, { ...(over.updatedAt ? { updatedAt: over.updatedAt } : {}) });
  return {
    key: `run:${runId}`,
    kind: "run",
    title: `task ${runId}`,
    column: "in-progress",
    state: "working",
    needsYou: 0,
    escalated: 0,
    blocked: 0,
    repos: [],
    ageMs: 0,
    updatedAt: "2026-11-20T10:00:00Z",
    head,
    subtasks: [],
    ...over,
  };
};

const thread = (id: string, over: Partial<ThreadLike> = {}): ThreadLike => ({
  id,
  title: `topic ${id}`,
  state: "open",
  updatedAt: "2026-11-20T09:00:00Z",
  runs: [],
  panes: [],
  ...over,
});

describe("which thread a task belongs to (round 16)", () => {
  test("the thread whose runs hold the task's top run; none when no thread names it", () => {
    const a = thread("a", { runs: ["r1"] });
    const b = thread("b", { runs: ["r2", "r3"] });
    expect(threadOfTask([a, b], task("r3"))?.id).toBe("b");
    expect(threadOfTask([a, b], task("r9"))).toBeUndefined();
  });

  test("a task made of steps is held by the run of one of its steps when its head is no run", () => {
    const t = task("x", { head: undefined, subtasks: [card("step-1"), card("step-2")] });
    expect(threadOfTask([thread("a", { runs: ["step-2"] })], t)?.id).toBe("a");
  });

  test("a task with no run at all is in no thread", () => {
    expect(threadOfTask([thread("a", { runs: ["r1"] })], task("r1", { head: undefined }))).toBeUndefined();
  });

  test("in a folder, a run of another repository with the same id is not the thread's", () => {
    const shop = thread("a", { runs: ["r1"], repo: "shop" });
    expect(threadOfTask([shop], task("r1", { head: card("r1", { repo: "shop" }) }))?.id).toBe("a");
    expect(threadOfTask([shop], task("r1", { head: card("r1", { repo: "billing" }) }))).toBeUndefined();
  });
});

describe("a thread row's one word (round 16)", () => {
  test("chat when it has no task", () => {
    expect(threadWord([], [])).toBe("chat");
  });

  test("its most urgent open task's word: needs you, then blocked, then working", () => {
    const working = task("w");
    const blocked = task("b", { state: "escalated" });
    const asks = task("n", { needsYou: 1 });
    expect(threadWord([working], [])).toBe("working");
    expect(threadWord([working, blocked], [])).toBe("blocked");
    expect(threadWord([working, blocked, asks], [])).toBe("needs you");
  });

  test("done when every task is finished; a finished task never outranks an open one", () => {
    const done = task("d", { column: "done", state: "done" });
    expect(threadWord([], [done])).toBe("done");
    expect(threadWord([task("w")], [done])).toBe("working");
  });

  test("its chat asking needs the person, whatever its tasks say", () => {
    expect(threadWord([], [], true)).toBe("needs you");
    expect(threadWord([task("w")], [], true)).toBe("needs you");
  });

  test("the row's own word for a task is what counts (a run of its own reads its panes)", () => {
    expect(threadWord([task("w", { state: "idle" })], [], false, () => "working")).toBe("working");
  });

  test("a thread with no task draws the chat look, not one of the four", () => {
    expect(lookOf("chat", "chat").glyph).toBe("›");
    // A closed thread is quiet: never one of the four words' colours.
    expect(lookOf("chat", "closed")).toEqual({ glyph: "–", tone: "faint" });
  });
});

describe("the sidebar's tree of threads (round 16)", () => {
  const T1 = "2026-11-20T08:00:00Z";
  const T2 = "2026-11-20T11:00:00Z";
  const T3 = "2026-11-20T12:00:00Z";

  test("each task under its thread, the rest in Without a chat, finished ones apart", () => {
    const tree = threadTree({
      threads: [thread("a", { runs: ["r1", "r2"] })],
      tasks: [task("r1"), task("r2", { column: "done", state: "done" }), task("r3")],
    });
    expect(tree.threads.map((g) => g.thread?.id)).toEqual(["a"]);
    const [a] = tree.threads;
    expect(a?.open.map((t) => t.key)).toEqual(["run:r1"]);
    expect(a?.finished.map((t) => t.key)).toEqual(["run:r2"]);
    expect(tree.without?.key).toBe(WITHOUT_CHAT);
    expect(tree.without?.title).toBe("Without a chat");
    expect(tree.without?.open.map((t) => t.key)).toEqual(["run:r3"]);
  });

  test("no Without a chat group when every task is in a thread", () => {
    const tree = threadTree({ threads: [thread("a", { runs: ["r1"] })], tasks: [task("r1")] });
    expect(tree.without).toBeUndefined();
  });

  test("a finished task no thread holds is in Without a chat too, behind its finished", () => {
    const tree = threadTree({ threads: [], tasks: [task("r1", { column: "done", state: "done" })] });
    expect(tree.without?.open).toEqual([]);
    expect(tree.without?.finished.map((t) => t.key)).toEqual(["run:r1"]);
  });

  test("threads: what needs the person first, then the most recently updated", () => {
    const tree = threadTree({
      threads: [
        thread("old", { updatedAt: T1 }),
        thread("new", { updatedAt: T2 }),
        thread("asks", { updatedAt: T1, runs: ["r1"] }),
      ],
      tasks: [task("r1", { needsYou: 1, updatedAt: T1 })],
    });
    expect(tree.threads.map((g) => g.thread?.id)).toEqual(["asks", "new", "old"]);
  });

  test("a thread's newest change counts its tasks' changes too", () => {
    const tree = threadTree({
      threads: [thread("quiet", { updatedAt: T2 }), thread("busy", { updatedAt: T1, runs: ["r1"] })],
      tasks: [task("r1", { updatedAt: T3 })],
    });
    expect(tree.threads.map((g) => g.thread?.id)).toEqual(["busy", "quiet"]);
    expect(tree.threads[0]?.updatedAt).toBe(T3);
  });

  test("a thread whose chat asks sorts first", () => {
    const tree = threadTree({
      threads: [thread("a", { updatedAt: T2 }), thread("b", { updatedAt: T1 })],
      tasks: [],
      chatAsks: (t) => t.id === "b",
    });
    expect(tree.threads.map((g) => [g.thread?.id, g.word])).toEqual([
      ["b", "needs you"],
      ["a", "chat"],
    ]);
  });

  test("closed threads apart, the most recently closed first, with their tasks", () => {
    const tree = threadTree({
      threads: [
        thread("open"),
        thread("c1", { state: "closed", closedAt: T1, runs: ["r1"] }),
        thread("c2", { state: "closed", closedAt: T2 }),
      ],
      tasks: [task("r1")],
    });
    expect(tree.threads.map((g) => g.thread?.id)).toEqual(["open"]);
    expect(tree.closed.map((g) => g.thread?.id)).toEqual(["c2", "c1"]);
    expect(tree.closed[1]?.open.map((t) => t.key)).toEqual(["run:r1"]);
    // A task of a closed thread is still that thread's, not "Without a chat".
    expect(tree.without).toBeUndefined();
  });

  test("tasks keep the order they came in inside a thread", () => {
    const tree = threadTree({
      threads: [thread("a", { runs: ["r1", "r2", "r3"] })],
      tasks: [task("r3"), task("r1"), task("r2")],
    });
    expect(tree.threads[0]?.open.map((t) => t.key)).toEqual(["run:r3", "run:r1", "run:r2"]);
  });

  test("a thread row's line counts its tasks, and says nothing without one", () => {
    expect(threadLine({ open: [task("a")], finished: [task("b")] })).toBe("2 tasks");
    expect(threadLine({ open: [task("a")], finished: [] })).toBe("1 task");
    expect(threadLine({ open: [], finished: [] })).toBe("");
  });
});

describe("a thread's chat terminal and where it is shown (round 16)", () => {
  const pane = (id: string, over: { repo?: string; threadId?: string } = {}) => ({ id, ...over });

  test("the last pane the thread names that the layout still has", () => {
    const th = thread("a", { panes: [{ paneId: "w1:p1" }, { paneId: "w2:p1" }] });
    expect(threadPane(th, [pane("w1:p1"), pane("w2:p1")])?.id).toBe("w2:p1");
    expect(threadPane(th, [pane("w1:p1")])?.id).toBe("w1:p1");
  });

  test("in a folder, the pane of the thread's repository", () => {
    const th = thread("a", { panes: [{ paneId: "w1:p1", repo: "shop" }] });
    expect(threadPane(th, [pane("w1:p1", { repo: "billing" }), pane("w1:p1", { repo: "shop" })])?.repo).toBe(
      "shop",
    );
  });

  test("else the newest pane the layout marks with the thread", () => {
    const th = thread("a");
    expect(threadPane(th, [pane("w1:p1", { threadId: "a" }), pane("w2:p1", { threadId: "a" })])?.id).toBe(
      "w2:p1",
    );
    expect(threadPane(th, [pane("w1:p1", { threadId: "b" })])).toBeUndefined();
  });

  test("the route of a thread goes there and back", () => {
    expect(routeHash({ screen: "thread", id: "20261120-prices" })).toBe("#/thread/20261120-prices");
    expect(parseRoute("#/thread/20261120-prices")).toEqual({ screen: "thread", id: "20261120-prices" });
    expect(parseRoute("#/thread")).toEqual({ screen: "inbox" });
  });

  test("Home's prefix is the title of the task's thread", () => {
    expect(threadTitleOf([thread("a", { title: "Prices", runs: ["r1"] })], task("r1"))).toBe("Prices");
    expect(threadTitleOf([thread("a", { runs: ["r1"] })], task("r2"))).toBeUndefined();
  });

  test("the thread that holds what is shown: the thread itself, or the thread of a run's task", () => {
    const a = thread("a", { runs: ["r1"] });
    const tasks = [task("r1", { subtasks: [card("child")] })];
    expect(heldThread([a], tasks, { thread: "a" })?.id).toBe("a");
    expect(heldThread([a], tasks, { runId: "child" })?.id).toBe("a");
    expect(heldThread([a], tasks, { runId: "other" })).toBeUndefined();
    expect(heldThread([a], tasks, {})).toBeUndefined();
  });
});

describe("a chat's title from the person's words (round 16)", () => {
  test("the first line, as it is, when it fits", () => {
    expect(chatTitleOf("  Add a discount\n\nwith a test")).toBe("Add a discount");
    expect(chatTitleOf("\n\nRound   prices")).toBe("Round prices");
  });

  test("cut at a word to the title's limit, with an ellipsis", () => {
    const long = `Add ${"very ".repeat(30)}long title`;
    const t = chatTitleOf(long);
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(t.endsWith("very…")).toBe(true);
  });

  test("a word longer than the limit is cut inside it", () => {
    const t = chatTitleOf("x".repeat(200));
    expect(t).toBe(`${"x".repeat(TITLE_MAX - 1)}…`);
  });
});

describe("when the app reads the threads again, and follows a new one (round 16)", () => {
  test("the stamp changes with the count or the newest change; a folder's repositories each count", () => {
    expect(threadsStamp({ threads: { open: 1, closed: 0, updatedAt: "t1" } })).toBe("1/0/t1");
    expect(threadsStamp({ threads: { open: 1, closed: 0, updatedAt: "t2" } })).not.toBe("1/0/t1");
    expect(threadsStamp({ threads: { open: 0, closed: 1, updatedAt: "t1" } })).not.toBe("1/0/t1");
    expect(threadsStamp({ repos: [{ threads: { open: 1, updatedAt: "a" } }, { name: "b" }] })).toBe("1/0/a|");
    expect(threadsStamp({ runs: [] })).toBe("");
    expect(threadsStamp(undefined)).toBe("");
  });

  test("a new thread opened from the one on screen is followed; an old one or another's is not", () => {
    const fresh = { id: "new", from: { thread: "shown" } };
    expect(followedThread(["shown"], [{ id: "shown" }, fresh], "shown")?.id).toBe("new");
    expect(followedThread(["shown", "new"], [{ id: "shown" }, fresh], "shown")).toBeUndefined();
    expect(followedThread(["shown"], [{ id: "x", from: { thread: "other" } }], "shown")).toBeUndefined();
    expect(followedThread([], [fresh], undefined)).toBeUndefined();
  });
});
