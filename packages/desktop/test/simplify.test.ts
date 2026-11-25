import { describe, expect, test } from "bun:test";
import type { SystemPlanView } from "../src/shared/api/api.ts";
import { boardCards } from "../src/shared/model/board.ts";
import { blockedReason, firstLevel, LOOKS } from "../src/shared/model/look.ts";
import type { Run } from "../src/shared/model/runs.ts";
import { runPage, taskState, workTasks } from "../src/shared/model/tasks.ts";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const run = (runId: string, extra: Partial<Run> = {}): Run =>
  ({
    runId,
    workflow: "mt-feature",
    task: runId,
    autonomy: "L0",
    status: "active",
    stage: "build",
    attention: "driving",
    phase: "in-progress",
    stages: [
      { id: "plan", state: "done" },
      { id: "build", state: "current" },
      { id: "delivery", state: "next" },
    ],
    questions: [],
    driving: true,
    driver: "agent",
    died: false,
    host: "scenario",
    createdAt: "2026-11-18T11:00:00.000Z",
    updatedAt: "2026-11-18T11:30:00.000Z",
    elapsedMs: 60_000,
    services: [],
    ...extra,
  }) as Run;

type Step = SystemPlanView["steps"][number];
const step = (id: string, app: string, dependsOn: string[], extra: Partial<Step> = {}): Step =>
  ({ id, app, repo: app, task: `do ${id}`, dependsOn, status: "pending", ...extra }) as Step;
const plan = {
  plan: { id: "prices", task: "Prices in the customer's currency" },
  status: "approved",
  waves: [
    { wave: 1, steps: ["model", "tag"] },
    { wave: 2, steps: ["endpoint"] },
  ],
  steps: [
    step("model", "shop-api", [], { status: "running", run: "c1" }),
    step("tag", "shop-web", [], { status: "done", run: "c2" }),
    step("endpoint", "shop-api", ["model"]),
  ],
  repo: "shop-api",
} as unknown as SystemPlanView & { repo: string };

const tasksOf = (runs: Run[], plans = [plan]) =>
  workTasks(boardCards({ runs, issues: [], plans, now: NOW }), plans);

describe("four words on the first level (simplify, item 5)", () => {
  test("every fine state is one of needs you, working, blocked, done", () => {
    expect(["needs you", "asks", "proposed", "approval", "terminal"].map(firstLevel)).toEqual(
      Array(5).fill("needs you"),
    );
    expect(firstLevel("working")).toBe("working");
    // Blocked: escalated, waiting for another step, nothing driving it.
    expect(["escalated", "idle", "exited", "pending", "todo", undefined].map(firstLevel)).toEqual(
      Array(6).fill("blocked"),
    );
    // Done is done, also when it ended without its work or was not seen yet.
    expect(["done", "aborted", "finished"].map(firstLevel)).toEqual(["done", "done", "done"]);
    // Four looks, no more, on the first level.
    expect(Object.keys(LOOKS.first)).toEqual(["needs you", "working", "blocked", "done"]);
  });

  test("a blocked thing says why in one line", () => {
    expect(
      blockedReason({
        run: run("a", { status: "escalated", stage: "build", reason: "gate `test -f x` failed" }),
      }),
    ).toBe("escalated at build: gate `test -f x` failed");
    expect(blockedReason({ waitsFor: ["price-endpoint"] })).toBe("waits for price-endpoint");
    expect(blockedReason({ run: run("b", { attention: "stopped", driving: false }) })).toBe(
      "nothing drives it: Open a session",
    );
    expect(blockedReason({})).toBe("not started: nothing drives it yet");
    const long = blockedReason({ run: run("c", { status: "escalated", reason: "x".repeat(300) }) });
    expect(long.length).toBeLessThan(150);
  });

  test("a task needs the person when any of its steps does", () => {
    const t = tasksOf([
      run("sys", { workflow: "mt-system-change", stage: "children", children: ["c1", "c2"] }),
      run("c1", { attention: "you", repo: "shop-api" }),
      run("c2", { status: "done", attention: "done", phase: "done", repo: "shop-web" }),
    ]).find((x) => x.kind === "system");
    expect(t && taskState(t)).toBe("needs you");
  });
});

describe("the page of a task and of a step (simplify, items 2 and 3)", () => {
  const runs = [
    run("sys", { workflow: "mt-system-change", stage: "children", children: ["c1", "c2"] }),
    run("c1", { status: "escalated", attention: "escalated", stage: "build", reason: "tests failed" }),
    run("c2", { status: "done", attention: "done", phase: "done" }),
    run("alone"),
  ];
  const tasks = tasksOf(runs);
  const of = (id: string) => runs.find((r) => r.runId === id);

  test("a system run is a task's page: its steps' progress, blocked by the step that escalated", () => {
    const p = runPage(of("sys") as Run, "working", tasks, of);
    expect([p.task, p.title, p.state]).toEqual([true, "Prices in the customer's currency", "blocked"]);
    expect(p.progress).toEqual({ done: 1, of: 3, text: "1 of 3 steps done" });
    expect(p.why).toBe("model: escalated at build: tests failed");
    expect(p.partOf).toBeUndefined();
  });

  test("a step's page leads back to its task and says why it stands still", () => {
    const p = runPage(of("c1") as Run, "escalated", tasks, of);
    expect([p.task, p.title, p.state]).toEqual([false, "model: do model", "blocked"]);
    expect(p.partOf).toEqual({
      key: "plan:prices",
      title: "Prices in the customer's currency",
      runId: "sys",
    });
    expect(p.why).toBe("escalated at build: tests failed");
    expect(p.progress).toEqual({ done: 1, of: 3, text: "1 of 3 stages done" });
  });

  test("a run of its own is a step's page with no breadcrumb; working says no reason", () => {
    const p = runPage(of("alone") as Run, "working", tasks, of);
    expect([p.task, p.state, p.why, p.partOf]).toEqual([false, "working", undefined, undefined]);
  });

  test("a run with child runs is a task's page too", () => {
    const parentRuns = [run("p", { children: ["k"] }), run("k", { parent: "p", attention: "you" })];
    const p = runPage(parentRuns[0] as Run, "working", tasksOf(parentRuns, []), (id) =>
      parentRuns.find((r) => r.runId === id),
    );
    expect([p.task, p.state, p.progress.text]).toEqual([true, "needs you", "0 of 1 steps done"]);
  });
});

describe("a decision has one address; a run that asks can still get a session (polish)", () => {
  test("a decision's address is its repository, run and question; it parses back to the same pick", async () => {
    const { decisionKey, needsQueue, pickedNeed } = await import("../src/shared/model/needs.ts");
    const { parseRoute, routeHash } = await import("../src/shared/model/route.ts");
    const q = { id: "q002", runId: "r1", prompt: "ok?", source: "gate", options: [], askedAt: "" };
    const item = (repo?: string) =>
      ({ runId: "r1", repo, question: q, stage: "plan-approval", waitedMs: 0, driving: false }) as never;
    expect(decisionKey(item("shop-api"))).toBe("shop-api/r1/q002");
    expect(decisionKey(item())).toBe("r1/q002");
    const route = { screen: "inbox" as const, pick: "shop-api/r1/q002" };
    expect(routeHash(route)).toBe("#/inbox/shop-api/r1/q002");
    expect(parseRoute("#/inbox/shop-api/r1/q002")).toEqual(route);
    // The old encoded form still opens it.
    expect(parseRoute("#/inbox/shop-api%2Fr1%2Fq002")).toEqual(route);
    // Opening it shows exactly that card, not the queue's first; two runs with one question id
    // in two repositories are two decisions.
    const rows = needsQueue([item("a"), item("shop-api")], []);
    expect(pickedNeed(rows, "shop-api/r1/q002")?.repo).toBe("shop-api");
  });

  test("a run that asks on a card with no session and no drive can still open its conductor", async () => {
    const { asksWithoutSession } = await import("../src/features/runs/model.ts");
    const { idleRuns } = await import("../src/shared/model/needs.ts");
    const asks = run("a", {
      attention: "you",
      driving: false,
      questions: [{ id: "q1" }] as never,
    });
    expect(asksWithoutSession(asks, [])).toBe(true);
    // idleRuns never offers it (it asks), so the page offers the session this way.
    expect(idleRuns([asks], [])).toEqual([]);
    expect(asksWithoutSession(asks, [{ runId: "a", live: { alive: true } } as never])).toBe(false);
    expect(asksWithoutSession(run("b", { driving: true, questions: [{ id: "q1" }] as never }), [])).toBe(
      false,
    );
    expect(asksWithoutSession(run("c", { driving: false }), [])).toBe(false);
    expect(asksWithoutSession(run("d", { status: "done", questions: [{ id: "q1" }] as never }), [])).toBe(
      false,
    );
  });
});
