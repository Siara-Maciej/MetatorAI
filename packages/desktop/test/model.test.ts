import { describe, expect, test } from "bun:test";
import type { InboxItem, RunOverview } from "../src/api.ts";
import {
  answerCommand,
  byPanelOrder,
  duration,
  groupByFeature,
  inboxChips,
  newQuestions,
  nextWaiting,
  parseRoute,
  questionKind,
  routeHash,
  stageGlyph,
  stepLabel,
  wasAway,
} from "../src/model.ts";

const run = (runId: string, extra: Partial<RunOverview> = {}): RunOverview =>
  ({
    runId,
    workflow: "mt-feature",
    task: runId,
    autonomy: "L0",
    status: "active",
    stage: "build",
    attention: "driving",
    stages: [],
    questions: [],
    driving: true,
    driver: "agent",
    died: false,
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    elapsedMs: 0,
    services: [],
    ...extra,
  }) as RunOverview;

describe("panel order and groups", () => {
  test("waits for you first, then working, stopped, escalated, finished; newest first within", () => {
    const runs = [
      run("a", { attention: "done" }),
      run("b", { attention: "stopped" }),
      run("c", { attention: "you", updatedAt: "2026-11-02T09:00:00.000Z" }),
      run("d", { attention: "you", updatedAt: "2026-11-02T11:00:00.000Z" }),
      run("e", { attention: "driving" }),
      run("f", { attention: "escalated" }),
      run("g", { attention: "aborted" }),
    ];
    expect(byPanelOrder(runs).map((r) => r.runId)).toEqual(["d", "c", "e", "b", "f", "a", "g"]);
  });

  test("steps of one parent form a feature group in start order; a parent of unknown runs stands alone", () => {
    const runs = [
      run("p"),
      run("s2", { parent: "p", createdAt: "2026-11-02T12:00:00.000Z", status: "done" }),
      run("s1", { parent: "p", createdAt: "2026-11-02T11:00:00.000Z" }),
      run("x", { parent: "gone" }),
      run("q", { children: ["elsewhere"] }),
    ];
    const g = groupByFeature(runs);
    expect(g.groups).toEqual([
      { parent: "p", steps: [runs[2] as RunOverview, runs[1] as RunOverview], done: 1 },
    ]);
    expect(g.standalone.map((r) => r.runId)).toEqual(["x", "q"]);
    expect(stepLabel(runs[1] as RunOverview, g.groups)).toBe("F · 2/2");
    expect(stepLabel(runs[3] as RunOverview, g.groups)).toBeUndefined();
  });

  test("the next session that waits, after the current one, around the end", () => {
    const runs = [run("a", { attention: "you" }), run("b"), run("c", { attention: "you" })];
    expect(nextWaiting(runs, undefined)?.runId).toBe("a");
    expect(nextWaiting(runs, "a")?.runId).toBe("c");
    expect(nextWaiting(runs, "c")?.runId).toBe("a");
    expect(nextWaiting([run("b")], "b")).toBeUndefined();
  });
});

describe("inbox rows and the card", () => {
  const item = (q: Partial<InboxItem["question"]>, driving = false): InboxItem =>
    ({
      runId: "r",
      task: "t",
      stage: "s",
      driving,
      waitedMs: 0,
      question: {
        id: "q001",
        runId: "r",
        stage: "s",
        source: "gate",
        prompt: "?",
        options: [],
        multiSelect: false,
        askedAt: "",
        ...q,
      },
    }) as InboxItem;

  test("kind and chips come from the question and its card", () => {
    expect([
      questionKind({ source: "gate" }),
      questionKind({ source: "permission" }),
      questionKind({ source: "agent" }),
    ]).toEqual(["GATE", "PERMISSION", "QUESTION"]);
    expect(
      inboxChips(
        item(
          {
            source: "permission",
            card: {
              task: "t",
              done: [],
              artifacts: [],
              reversible: false,
              blastRadius: { files: 3, areas: ["src"] },
              costOfDelay: ["blocks wave 2"],
            },
          },
          true,
        ),
      ),
    ).toEqual(["not reversible", "blast 3 files", "policy candidate", "blocks wave", "agent idle"]);
    expect(inboxChips(item({}))).toEqual([]);
  });

  test("the footer command is what answering writes: approve for a gate, answer otherwise", () => {
    const q = { id: "q002", runId: "20261102-mt-feature-a", source: "gate" as const, stage: "plan-approval" };
    expect(answerCommand(q, "Approve", "alice")).toBe(
      "metator run approve plan-approval --run 20261102-mt-feature-a --choice Approve --by alice",
    );
    expect(answerCommand({ ...q, source: "agent" }, "half even", "")).toBe(
      'metator run answer q002 --run 20261102-mt-feature-a --choice "half even" --by <you>',
    );
  });

  test("new questions are the ones not seen before", () => {
    const before = [{ id: "q001", runId: "r" }];
    const after = [
      { id: "q001", runId: "r", prompt: "old" },
      { id: "q002", runId: "r", prompt: "new" },
    ];
    expect(newQuestions(before, after).map((q) => q.prompt)).toEqual(["new"]);
  });
});

describe("formatting and routes", () => {
  test("durations read in the largest unit that fits", () => {
    expect([duration(3000), duration(240_000), duration(7_500_000), duration(3 * 86_400_000)]).toEqual([
      "3s",
      "4 min",
      "2 h 05",
      "3 d",
    ]);
    expect(duration(-5)).toBe("0s");
  });

  test("stage glyphs", () => {
    expect(
      ["done", "current", "waiting", "stopped", "pending"]
        .map((state) => stageGlyph({ state: state as never }))
        .join(""),
    ).toBe("✓⟳?✕·");
  });

  test("routes parse and print both ways; anything unknown is the inbox", () => {
    expect(parseRoute("#/session/2026%2Fa")).toEqual({ screen: "session", runId: "2026/a" });
    expect(parseRoute("#/grid/p")).toEqual({ screen: "grid", group: "p" });
    expect(parseRoute("#/grid")).toEqual({ screen: "grid" });
    expect(parseRoute("#/briefing/r")).toEqual({ screen: "briefing", runId: "r" });
    expect(parseRoute("#/briefing")).toEqual({ screen: "inbox" });
    expect(parseRoute("")).toEqual({ screen: "inbox" });
    expect(parseRoute("#/nope")).toEqual({ screen: "inbox" });
    for (const hash of [
      "#/inbox",
      "#/session/r",
      "#/grid",
      "#/grid/p",
      "#/graph",
      "#/supervisor",
      "#/briefing/r",
    ])
      expect(routeHash(parseRoute(hash))).toBe(hash);
  });

  test("away means ten minutes or more since the person last looked", () => {
    expect(wasAway(undefined, 1_000_000)).toBe(false);
    expect(wasAway(0, 599_999)).toBe(false);
    expect(wasAway(0, 600_000)).toBe(true);
  });
});
