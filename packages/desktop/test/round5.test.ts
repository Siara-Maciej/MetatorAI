import { describe, expect, test } from "bun:test";
import type { Issue, SystemPlanView } from "../src/api.ts";
import {
  boardCards,
  cardLine,
  columnCards,
  columnCounts,
  filterCards,
  filterFromStorage,
  NO_FILTER,
  parentOptions,
  partOfLine,
  swimlanes,
  systemRunOf,
} from "../src/board.ts";
import { plansShown, type Run } from "../src/model.ts";
import { criticalPath, FLOW, planFlow, waitsText } from "../src/plan-flow.ts";

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
    stages: [],
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
const step = (id: string, app: string, dependsOn: string[] = [], extra: Partial<Step> = {}): Step =>
  ({ id, app, repo: `/code/shop/${app}`, task: `do ${id}`, dependsOn, status: "pending", ...extra }) as Step;
/** The owner's flow: two backend steps and one frontend step at once, then the integration. */
const owner = (steps: Partial<Record<string, Partial<Step>>> = {}, status = "approved") =>
  ({
    plan: { id: "add-currency", task: "Add a currency to prices" },
    status,
    waves: [
      { wave: 1, steps: ["api-model", "api-endpoint", "web-price-tag"] },
      { wave: 2, steps: ["web-integration"] },
    ],
    steps: [
      step("api-model", "shop-api", [], steps["api-model"]),
      step("api-endpoint", "shop-api", [], steps["api-endpoint"]),
      step("web-price-tag", "shop-web", [], steps["web-price-tag"]),
      step(
        "web-integration",
        "shop-web",
        ["api-model", "api-endpoint", "web-price-tag"],
        steps["web-integration"],
      ),
    ],
    repo: "shop-api",
  }) as unknown as SystemPlanView & { repo: string };

describe("a decomposed task as a flow", () => {
  test("columns are the waves, lanes the repositories; two steps of one repository in a wave stack", () => {
    const f = planFlow(owner(), []);
    expect(f.columns.map((c) => c.label)).toEqual(["wave 1", "wave 2"]);
    expect(f.lanes.map((l) => l.name)).toEqual(["shop-api", "shop-web"]);
    const at = new Map(f.nodes.map((n) => [n.id, n]));
    // Same wave: the same column; the two backend steps one under the other in their lane.
    expect(at.get("api-model")?.x).toBe(at.get("web-price-tag")?.x);
    expect(at.get("api-endpoint")?.y).toBe((at.get("api-model")?.y ?? 0) + FLOW.H + FLOW.ROW_GAP);
    expect(at.get("web-integration")?.x).toBeGreaterThan(at.get("api-model")?.x ?? 0);
    // The task on the left, before every wave.
    expect(at.get("@task")?.x).toBeLessThan(at.get("api-model")?.x ?? 0);
    // The shop-api lane is two rows high; the shop-web lane one.
    expect(f.lanes[0]?.h).toBeGreaterThan(f.lanes[1]?.h ?? 0);
  });

  test("an arrow from the task into wave 1, and from each step depended on to the one that waits", () => {
    const f = planFlow(owner(), []);
    expect(f.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(
      [
        "@task>api-model",
        "@task>api-endpoint",
        "@task>web-price-tag",
        "api-model>web-integration",
        "api-endpoint>web-integration",
        "web-price-tag>web-integration",
      ].sort(),
    );
    // Every arrow runs left to right: it leaves a node's right edge and enters the next one's left.
    for (const e of f.edges) {
      const [x1, x2] = [Number(e.d.split(" ")[1]), Number(e.d.split(" ").at(-2)?.replace(",", ""))];
      expect(x2).toBeGreaterThan(x1);
    }
  });

  test("every step is a node: pending ones say what they wait for; started ones their run's state and stage", () => {
    const plan = owner({
      "api-model": { status: "done", run: "r1", runState: "done" },
      "api-endpoint": { status: "running", run: "r2", runState: "active", runStage: "build" },
      "web-price-tag": { status: "running", run: "r3", runState: "active", runStage: "plan-approval" },
    });
    const runs = [
      run("r2", { stage: "review" }),
      run("r3", { attention: "you", stage: "plan-approval", repo: "shop-web" }),
    ];
    const f = planFlow(plan, runs);
    const at = new Map(f.nodes.map((n) => [n.id, n]));
    // A run the app lists wins over the plan's view of it; one it does not list reads the view.
    expect([at.get("api-model")?.state, at.get("api-model")?.stage]).toEqual(["done", undefined]);
    expect([at.get("api-endpoint")?.state, at.get("api-endpoint")?.stage]).toEqual(["working", "review"]);
    expect(at.get("web-price-tag")?.state).toBe("needs you");
    expect(at.get("web-integration")?.state).toBe("pending");
    // It waits for the two steps not done yet; the done one is no longer a wait.
    expect(at.get("web-integration")?.waitsFor).toEqual(["api-endpoint", "web-price-tag"]);
    expect(waitsText(at.get("web-integration") as never)).toBe("waits for: api-endpoint, web-price-tag");
    expect(f.edges.find((e) => e.from === "api-model")?.met).toBe(true);
    expect(waitsText({ state: "pending", waitsFor: [] })).toBe("can start");
    expect(waitsText({ state: "working", waitsFor: [] })).toBeUndefined();
  });

  test("the critical path is every longest chain of steps, drawn heavier", () => {
    // The owner's flow: each step of wave 1 leads into the integration; all three chains are the longest.
    const p = criticalPath(owner());
    expect([p.steps, p.levels, p.length]).toEqual([
      ["api-model", "api-endpoint", "web-price-tag", "web-integration"],
      [["api-model", "api-endpoint", "web-price-tag"], ["web-integration"]],
      2,
    ]);
    const long = {
      waves: [],
      steps: [step("a", "x"), step("b", "x", ["a"]), step("c", "y", ["b"]), step("d", "y", ["a"])],
    };
    const l = criticalPath(long);
    expect([l.steps, l.length, l.on("a", "b"), l.on("b", "c"), l.on("a", "d")]).toEqual([
      ["a", "b", "c"],
      3,
      true,
      true,
      false,
    ]);
    // Steps that wait for nothing: no path to draw.
    expect(criticalPath({ waves: [], steps: [step("a", "x"), step("b", "y")] }).steps).toEqual([]);
    const f = planFlow(owner(), []);
    expect(f.edges.filter((e) => e.critical)).toHaveLength(6);
    const shortcut = planFlow(
      {
        plan: { id: "p", task: "t" },
        status: "approved",
        waves: [
          { wave: 1, steps: ["a"] },
          { wave: 2, steps: ["b"] },
          { wave: 3, steps: ["c", "d"] },
        ],
        steps: [step("a", "x"), step("b", "x", ["a"]), step("c", "y", ["b"]), step("d", "y", ["a"])],
      } as never,
      [],
    );
    // An arrow that skips a level (a → d) is not on the path, nor the task's arrow into it.
    expect(shortcut.edges.filter((e) => e.critical).map((e) => `${e.from}>${e.to}`)).toEqual([
      "@task>a",
      "a>b",
      "b>c",
    ]);
  });

  test("a step no wave names (a circle the lint reports) goes after the last wave", () => {
    const f = planFlow(
      {
        plan: { id: "p", task: "t" },
        status: "draft",
        waves: [],
        steps: [step("a", "x", ["b"]), step("b", "x", ["a"])],
      } as never,
      [],
    );
    expect(f.columns.map((c) => c.label)).toEqual(["not in a wave"]);
    expect(f.nodes.find((n) => n.id === "@task")?.state).toBe("pending");
  });
});

const issue = (id: string, status: Issue["status"], extra: Partial<Issue> = {}): Issue =>
  ({
    id,
    title: `Task ${id}`,
    body: "",
    status,
    priority: "normal",
    labels: [],
    refs: [],
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:00:00.000Z",
    ...extra,
  }) as Issue;

describe("the board", () => {
  const plan = owner({
    "api-model": { status: "running", run: "c1" },
    "api-endpoint": { status: "running", run: "c2" },
    "web-price-tag": { status: "running", run: "c3" },
  });
  const runs = [
    run("sys", {
      workflow: "mt-system-change",
      task: "Add a currency to prices",
      stage: "status",
      repo: "shop-api",
      children: ["c1", "c2", "c3"],
    }),
    run("c1", {
      parent: "sys",
      repo: "shop-api",
      phase: "planning",
      stage: "plan-approval",
      attention: "you",
    }),
    run("c2", { parent: "sys", repo: "shop-api", phase: "review", stage: "delivery" }),
    run("c3", {
      parent: "sys",
      repo: "shop-web",
      phase: "in-progress",
      stage: "build",
      status: "escalated",
      attention: "escalated",
    }),
    run("alone", { repo: "shop-web", phase: "done", status: "done", attention: "done", host: "claude" }),
    run("old", {
      repo: "shop-web",
      phase: "done",
      status: "aborted",
      attention: "aborted",
      updatedAt: "2026-11-16T10:00:00.000Z",
    }),
  ];
  const cards = boardCards({
    runs,
    issues: [
      { repo: "shop-web", issues: [issue("i001", "open"), issue("i002", "proposed"), issue("i003", "done")] },
    ],
    plans: [plan],
    now: NOW,
  });
  const byKey = (k: string) => cards.find((c) => c.key.endsWith(k));

  test("a run's column is the phase the daemon sent; tasks and steps not started are To do", () => {
    expect(cards.map((c) => [c.key, c.column])).toEqual([
      ["run:shop-api/sys", "in-progress"],
      ["run:shop-api/c1", "planning"],
      ["run:shop-api/c2", "review"],
      ["run:shop-web/c3", "in-progress"],
      ["run:shop-web/alone", "done"],
      ["run:shop-web/old", "done"],
      ["issue:shop-web/i001", "todo"],
      ["issue:shop-web/i002", "todo"],
      ["step:shop-api/add-currency/web-integration", "todo"],
    ]);
    // A run with no phase (an older daemon) is still placed, never lost.
    const [old] = boardCards({
      runs: [run("x", { phase: undefined as never })],
      issues: [],
      plans: [],
      now: NOW,
    });
    expect(old?.column).toBe("in-progress");
  });

  test("a card says what it is part of and where it stands; needs you and escalated are marked", () => {
    const c1 = byKey("/c1");
    expect([c1?.parent?.key, c1?.step, c1?.needsYou]).toEqual(["plan:add-currency", { at: 1, of: 4 }, true]);
    expect(partOfLine(c1 as never)).toBe("step 1 of 4 · of Add a currency to prices");
    // The system run is the whole task: how far its steps are, not "of" itself.
    expect(partOfLine(byKey("/sys") as never)).toBe("the whole task · 0 of 4 steps done");
    expect(cardLine(c1 as never)).toBe("shop-api · plan-approval · scenario");
    expect(c1?.title).toBe("api-model: do api-model");
    expect([byKey("/c3")?.escalated, byKey("/c3")?.state]).toEqual([true, "escalated"]);
    // The system run heads its own task: "only this task" keeps it.
    expect(byKey("/sys")?.parent?.key).toBe("plan:add-currency");
    const pending = byKey("/web-integration");
    expect([pending?.repo, pending?.step, pending?.waitsFor, pending?.systemRunId]).toEqual([
      "shop-web",
      { at: 4, of: 4 },
      ["api-model", "api-endpoint", "web-price-tag"],
      "sys",
    ]);
    expect(cardLine(pending as never)).toBe("shop-web · not started");
    // A proposal needs a person's Add.
    expect([byKey("/i002")?.kind, byKey("/i002")?.needsYou]).toEqual(["proposal", true]);
    expect(byKey("/i003")).toBeUndefined();
    expect(partOfLine(byKey("/i001") as never)).toBeUndefined();
  });

  test("filters: repositories, one parent task across repositories, states, host and words", () => {
    const keys = (f: Partial<typeof NO_FILTER>) =>
      filterCards(cards, { ...NO_FILTER, ...f }).map((c) => c.key);
    expect(keys({ repos: ["shop-api"] })).toEqual(["run:shop-api/sys", "run:shop-api/c1", "run:shop-api/c2"]);
    expect(keys({ parent: "plan:add-currency" })).toEqual([
      "run:shop-api/sys",
      "run:shop-api/c1",
      "run:shop-api/c2",
      "run:shop-web/c3",
      "step:shop-api/add-currency/web-integration",
    ]);
    expect(keys({ states: ["needs you", "escalated"] })).toEqual(["run:shop-api/c1", "run:shop-web/c3"]);
    expect(keys({ host: "claude" })).toEqual(["run:shop-web/alone"]);
    expect(keys({ text: "INTEGRATION" })).toEqual(["step:shop-api/add-currency/web-integration"]);
    expect(keys({ repos: ["shop-web"], parent: "plan:add-currency" })).toEqual([
      "run:shop-web/c3",
      "step:shop-api/add-currency/web-integration",
    ]);
    expect(parentOptions(cards)).toEqual([{ key: "plan:add-currency", label: "Add a currency to prices" }]);
  });

  test("a column puts what needs a person first; Done keeps the last day, the rest behind show more", () => {
    const todo = columnCards(cards, "todo", NOW);
    expect(todo.shown[0]?.key).toBe("issue:shop-web/i002");
    const done = columnCards(cards, "done", NOW);
    expect([done.shown.map((c) => c.key), done.older]).toEqual([["run:shop-web/alone"], 1]);
    expect(columnCards(cards, "done", NOW, true).shown).toHaveLength(2);
    expect(columnCounts(cards.filter((c) => c.column === "in-progress"))).toEqual({
      total: 2,
      needsYou: 0,
      escalated: 1,
    });
  });

  test("swimlanes: one per parent task, then the standalone work", () => {
    const lanes = swimlanes(cards);
    expect(lanes.map((l) => [l.label, l.cards.length])).toEqual([
      ["Add a currency to prices", 5],
      ["Standalone work", 4],
    ]);
    expect(swimlanes(cards.filter((c) => c.parent)).map((l) => l.key)).toEqual(["plan:add-currency"]);
  });

  test("a stored filter is read back; anything that does not fit is the default", () => {
    const f = {
      repos: ["shop-web"],
      parent: "plan:x",
      states: ["working"],
      host: "scenario",
      text: "a",
      grouped: true,
    };
    expect(filterFromStorage(JSON.stringify(f))).toEqual(f as never);
    expect(filterFromStorage(null)).toEqual(NO_FILTER);
    expect(filterFromStorage("{not json")).toEqual(NO_FILTER);
    expect(
      filterFromStorage(JSON.stringify({ repos: [1, "a"], states: ["bogus", "escalated"], grouped: "yes" })),
    ).toEqual({
      repos: ["a"],
      states: ["escalated"],
      text: "",
      grouped: false,
    });
  });

  test("the system run of a plan, and the plans the app reads in full", () => {
    expect(systemRunOf(plan, runs)?.runId).toBe("sys");
    expect(
      systemRunOf(owner(), [run("sys2", { workflow: "mt-system-change", task: "Add a currency to prices" })])
        ?.runId,
    ).toBe("sys2");
    const list = [
      { id: "a", status: "running", updatedAt: null },
      { id: "b", status: "done", updatedAt: "2026-11-18T01:00:00.000Z" },
      { id: "c", status: "done", updatedAt: "2026-11-16T01:00:00.000Z" },
      { id: "d", status: "done", updatedAt: null },
    ];
    expect(plansShown(list, NOW).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("bigflow fixes", () => {
  test("a gate's prompt reads as a sentence: the command in backticks is dropped", async () => {
    const { humanPrompt } = await import("../src/model.ts");
    expect(
      humanPrompt(
        "A person approves the system plan (`metator system plan approve`) and this gate: approve to continue",
      ),
    ).toBe("A person approves the system plan and this gate: approve to continue");
    expect(humanPrompt("Run `bun test` first")).toBe("Run bun test first");
    expect(humanPrompt("Which rounding?")).toBe("Which rounding?");
  });

  test("a run its conductor moves on: active, no gate, no question, nothing in the background, its conductor alive", async () => {
    const { conductorMoves } = await import("../src/model.ts");
    const r = run("c", {
      driving: false,
      stages: [{ id: "build", state: "current", hitl: false }],
      repo: "shop-api",
    } as Partial<Run>);
    const pane = { runId: "c", role: "conductor", live: { alive: true }, repo: "shop-api" } as never;
    expect(conductorMoves(r, [pane])).toBe(true);
    expect(conductorMoves(r, [])).toBe(false);
    expect(conductorMoves({ ...r, driving: true }, [pane])).toBe(false);
    expect(conductorMoves({ ...r, questions: [{}] as never }, [pane])).toBe(false);
    expect(
      conductorMoves({ ...r, stages: [{ id: "approval", state: "waiting", hitl: true }] } as never, [pane]),
    ).toBe(false);
    expect(conductorMoves({ ...r, status: "done" }, [pane])).toBe(false);
    expect(conductorMoves(r, [{ ...(pane as object), repo: "shop-web" } as never])).toBe(false);
    expect(conductorMoves(r, [{ ...(pane as object), live: { alive: false } } as never])).toBe(false);
  });
});

describe("the confirmation of an answer", () => {
  test("names the answer just given: a slower confirmation of an earlier answer never speaks over it", async () => {
    const { createConfirmer } = await import("../src/confirm.ts");
    const said: string[] = [];
    let wake: () => void = () => undefined;
    // The first answer's run stays where it was (a proposal moves no stage): it keeps looking.
    const states: Record<string, Run> = {
      a: run("a", { stage: "build" }),
      b: run("b", { stage: "delivery", status: "escalated" }),
    };
    const c = createConfirmer({
      read: async (id) => states[id],
      say: (t) => said.push(t),
      sleep: () =>
        new Promise<void>((done) => {
          wake = done;
        }),
    });
    const first = c.confirm(["Add to the backlog"], { runId: "a", stage: "build" });
    await Bun.sleep(0);
    const second = c.confirm(["Reject"], { runId: "b", stage: "delivery" });
    await second;
    wake();
    await first;
    expect(said).toEqual([
      "Rejected: the run escalated with your reason. It waits for a person to resume or close it.",
    ]);
  });

  test("alone, it waits for the run to move and says where it went", async () => {
    const { createConfirmer } = await import("../src/confirm.ts");
    const said: string[] = [];
    let n = 0;
    const c = createConfirmer({
      read: async () => (n++ === 0 ? run("a", { stage: "plan-approval" }) : run("a", { stage: "build" })),
      say: (t) => said.push(t),
      sleep: async () => undefined,
    });
    await c.confirm(["Approve"], { runId: "a", stage: "plan-approval" });
    expect([said, n]).toEqual([["Answered: Approve. The run goes on."], 2]);
  });
});
