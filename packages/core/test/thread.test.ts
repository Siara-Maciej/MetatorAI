import { describe, expect, test } from "bun:test";
import {
  EMPTY_LAYOUT,
  LayoutDocument,
  THREAD_FACTS_MAX,
  THREAD_SUMMARY_MAX,
  type Thread,
  ThreadDocument,
  type ThreadTask,
  threadId,
  threadOfRun,
  threadTree,
  threadWithFact,
} from "@metator/core";

const at = "2026-11-22T10:00:00.000Z";
const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "20261122-prices",
  title: "Prices",
  state: "open",
  createdAt: at,
  updatedAt: at,
  summary: "",
  runs: [],
  issues: [],
  mrs: [],
  panes: [],
  facts: [],
  ...over,
});
const task = (runId: string, over: Partial<ThreadTask> = {}): ThreadTask => ({
  runId,
  task: `task of ${runId}`,
  status: "active",
  stage: "build",
  attention: "driving",
  updatedAt: at,
  ...over,
});

describe("Thread: the document", () => {
  test("a thread round-trips through its document; a title over 80 or a summary over 1500 is refused", () => {
    const t = thread({ summary: "We round prices half up.", facts: [{ at, text: "opened by ann" }] });
    expect(ThreadDocument.parse(ThreadDocument.stamp(t), "t.json")._unsafeUnwrap()).toEqual(t);
    expect(() => ThreadDocument.stamp(thread({ title: "x".repeat(81) }))).toThrow();
    expect(() => ThreadDocument.stamp(thread({ summary: "x".repeat(THREAD_SUMMARY_MAX + 1) }))).toThrow();
    expect(() => ThreadDocument.stamp(thread({ id: "prices" }))).toThrow();
  });

  test("an id is the day and the title's slug; a taken one gets -2, -3", () => {
    const taken = new Set(["20261122-price-rounding", "20261122-price-rounding-2"]);
    expect(threadId("Price rounding!", new Date(at), () => false)).toBe("20261122-price-rounding");
    expect(threadId("Price rounding", new Date(at), (id) => taken.has(id))).toBe("20261122-price-rounding-3");
    expect(threadId("???", new Date(at), () => false)).toBe("20261122-chat");
  });

  test("facts keep the newest 50: the oldest is dropped, and the thread is updated", () => {
    let t = thread();
    for (let i = 1; i <= THREAD_FACTS_MAX + 2; i++)
      t = threadWithFact(t, `fact ${i}`, `2026-11-22T10:00:${String(i % 60).padStart(2, "0")}.000Z`);
    expect(t.facts).toHaveLength(THREAD_FACTS_MAX);
    expect(t.facts[0]?.text).toBe("fact 3");
    expect(t.facts.at(-1)?.text).toBe(`fact ${THREAD_FACTS_MAX + 2}`);
    expect(t.updatedAt).toBe(t.facts.at(-1)?.at as string);
    // A fact is one line, and not a novel.
    const long = threadWithFact(thread(), `a\nb ${"x".repeat(400)}`, at);
    expect(long.facts[0]?.text.startsWith("a b ")).toBe(true);
    expect(long.facts[0]?.text.length).toBeLessThanOrEqual(300);
  });

  test("the thread of a run is the one that lists it", () => {
    const a = thread({ id: "20261122-a", runs: ["r1"] });
    const b = thread({ id: "20261122-b", runs: ["r2", "r3"] });
    expect(threadOfRun([a, b], "r3")?.id).toBe("20261122-b");
    expect(threadOfRun([a, b], "r9")).toBeUndefined();
  });
});

describe("threadTree: one hierarchy for the sidebar", () => {
  test("a thread holds its own top runs; a run no thread lists is without a chat; child runs never stand alone", () => {
    const tree = threadTree(
      [thread({ id: "20261122-a", runs: ["r1", "gone"] })],
      [task("r1"), task("r2"), task("r3", { parent: "r1" })],
    );
    expect(tree.threads.map((t) => [t.id, t.tasks.map((x) => x.runId)])).toEqual([["20261122-a", ["r1"]]]);
    expect(tree.withoutChat.map((x) => x.runId)).toEqual(["r2"]);
    expect(tree.closed).toEqual([]);
  });

  test("a thread of the folder itself lists runs of any repository, each once (ADR-0114)", () => {
    const tree = threadTree(
      [
        { ...thread({ id: "20261122-shop", runs: ["r1"] }), repo: "shop" },
        { ...thread({ id: "20261122-folder", runs: ["r1", "r2"] }), repo: "." },
      ],
      [
        task("r1", { repo: "shop" }),
        task("r1", { repo: "web" }),
        task("r2", { repo: "shop" }),
        task("r3", { repo: "web" }),
      ],
    );
    const tasksOf = (id: string) =>
      tree.threads
        .find((t) => t.id === id)
        ?.tasks.map((x) => `${x.repo}:${x.runId}`)
        .sort();
    // A repository's thread takes only its own repository's run.
    expect(tasksOf("20261122-shop")).toEqual(["shop:r1"]);
    // Two repositories use the run id r1: the folder's thread takes the one no thread has yet.
    expect(tasksOf("20261122-folder")).toEqual(["shop:r2", "web:r1"]);
    expect(tree.withoutChat.map((x) => `${x.repo}:${x.runId}`)).toEqual(["web:r3"]);
  });

  test("a run of a closed thread stays with it: closed threads are their own group, newest closed first", () => {
    const tree = threadTree(
      [
        thread({ id: "20261122-a", state: "closed", closedAt: "2026-11-22T11:00:00.000Z", runs: ["r1"] }),
        thread({ id: "20261122-b", state: "closed", closedAt: "2026-11-22T12:00:00.000Z" }),
      ],
      [task("r1")],
    );
    expect(tree.threads).toEqual([]);
    expect(tree.closed.map((t) => t.id)).toEqual(["20261122-b", "20261122-a"]);
    expect(tree.withoutChat).toEqual([]);
  });

  test("threads that need you come first, then the most recently updated; a thread's attention is its most urgent task's", () => {
    const tree = threadTree(
      [
        thread({ id: "20261122-old", updatedAt: "2026-11-22T09:00:00.000Z", runs: ["r1", "r2"] }),
        thread({ id: "20261122-new", updatedAt: "2026-11-22T12:00:00.000Z" }),
        thread({ id: "20261122-mid", updatedAt: "2026-11-22T10:00:00.000Z", runs: ["r3"] }),
      ],
      [
        task("r1", { attention: "done", status: "done" }),
        task("r2", { attention: "you" }),
        task("r3", { attention: "driving", updatedAt: "2026-11-22T13:00:00.000Z" }),
      ],
    );
    expect(tree.threads.map((t) => [t.id, t.attention])).toEqual([
      ["20261122-old", "you"],
      ["20261122-mid", "driving"],
      ["20261122-new", undefined],
    ]);
    expect(tree.threads[0]?.tasks.map((x) => x.runId)).toEqual(["r2", "r1"]);
  });

  test("in a folder a run is its repository's: the same id in another repository is not the thread's", () => {
    const tree = threadTree(
      [{ ...thread({ id: "20261122-a", runs: ["r1"] }), repo: "shop" }],
      [task("r1", { repo: "shop" }), task("r1", { repo: "billing" })],
    );
    expect(tree.threads[0]?.tasks.map((x) => x.repo)).toEqual(["shop"]);
    expect(tree.withoutChat.map((x) => x.repo)).toEqual(["billing"]);
  });
});

describe("Layout v5: a chat pane names its thread", () => {
  test("a v4 layout reads as v5 without threads; a pane keeps its threadId", () => {
    const pane = {
      id: "w1:p1",
      tab: "w1:t1",
      role: "apps",
      label: "chat",
      cwd: "/repo",
      process: { kind: "host", host: "claude", agent: "mt-chat", prompt: "" },
      createdAt: at,
    };
    const workspaces = [
      {
        id: "w1",
        label: "chat",
        cwd: "/repo",
        tabs: [{ id: "w1:t1", label: "chat", panes: ["w1:p1"] }],
        createdAt: at,
      },
    ];
    const v4 = { kind: "Layout", schemaVersion: 4, ...EMPTY_LAYOUT, workspaces, panes: [pane] };
    expect(LayoutDocument.parse(v4, "layout.json")._unsafeUnwrap().panes[0]).toEqual(pane as never);
    const v5 = LayoutDocument.stamp({
      ...EMPTY_LAYOUT,
      workspaces,
      panes: [{ ...pane, threadId: "20261122-prices" }],
    } as never);
    expect(v5.schemaVersion).toBe(5);
    expect(LayoutDocument.parse(v5, "layout.json")._unsafeUnwrap().panes[0]?.threadId).toBe(
      "20261122-prices",
    );
  });
});
