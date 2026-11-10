import { describe, expect, test } from "bun:test";
import {
  type BoardWorker,
  type Plan,
  type PlanBoardInput,
  planBoardOf,
  type Question,
  type RunActivity,
  type WorkerResult,
  withLiveWorker,
} from "@metator/core";

const T = (m: number) => `2026-11-09T22:${String(m).padStart(2, "0")}:00.000Z`;
const plan: Plan = {
  task: "Add a discount",
  scope: ["src/**"],
  steps: [
    {
      id: "S1",
      action: "create",
      path: "src/invoice.test.ts",
      intent: "tests",
      rules: ["MT-TEST-001"],
      testsFirst: [],
      dependsOn: [],
    },
    {
      id: "S2",
      action: "modify",
      path: "src/invoice.ts",
      intent: "discount()",
      rules: ["MT-CODE-002"],
      testsFirst: ["src/invoice.test.ts"],
      dependsOn: ["S1"],
      patternSource: { pattern: "money", exemplar: "packages/money/src/money.ts:1", reason: "same shape" },
    },
    {
      id: "S3",
      action: "modify",
      path: "src/pdf/export.ts",
      intent: "cents",
      rules: [],
      testsFirst: [],
      dependsOn: ["S2"],
    },
    {
      id: "S4",
      action: "modify",
      path: "site/guide/pricing.md",
      intent: "docs",
      rules: [],
      testsFirst: [],
      dependsOn: [],
    },
  ],
};
const result = (
  worker: string,
  status: WorkerResult["status"],
  summary: string,
  artifacts: string[] = [],
): WorkerResult => ({
  worker,
  stage: "build",
  agent: worker.replace(/-\d+$/, ""),
  status,
  summary,
  artifacts,
  at: T(36),
});
const worker = (name: string, over: Partial<BoardWorker> = {}): BoardWorker => ({
  name,
  stage: "build",
  agent: name.replace(/-\d+$/, ""),
  paneId: "w1:p2",
  alive: true,
  state: "working",
  ...over,
});
const act = (
  m: number,
  type: RunActivity["type"],
  text: string,
  extra: Partial<RunActivity> = {},
): RunActivity => ({
  at: T(m),
  type,
  text,
  stage: "build",
  ...extra,
});
const question: Question = {
  id: "q001",
  runId: "r",
  stage: "build",
  source: "permission",
  prompt: "Allow bun test?",
  options: [{ label: "Allow" }, { label: "Deny" }],
  multiSelect: false,
  askedAt: T(40),
};
const base: PlanBoardInput = {
  runId: "r",
  task: "Add a discount",
  workflow: "mt-feature",
  status: "active",
  stage: "build",
  history: [
    { stage: "plan", event: "PASS" },
    { stage: "approval", event: "APPROVE", detail: "maciej" },
  ],
  stages: [
    { id: "intake", owners: ["script:task"], produces: ["task.md"] },
    { id: "plan", owners: ["mt-planner"], produces: ["plan.json"] },
    { id: "approval", hitl: true, owners: [], produces: [] },
    { id: "build", owners: ["mt-test-author", "mt-implementer"], produces: ["build-log.md"] },
    { id: "review", owners: ["mt-pr-review"], produces: ["verdict.json"] },
  ],
  plan,
  results: [result("mt-test-author-1", "done", "3 tests, red for the right reason", ["src/invoice.test.ts"])],
  workers: [
    worker("mt-test-author-1", { alive: false, state: "exited", paneId: "w1:p3" }),
    worker("mt-implementer-1"),
  ],
  questions: [question],
  activity: [
    act(31, "stage", "plan", { stage: "plan", agent: "mt-planner" }),
    act(33, "stage", "build"),
    act(33, "agent", "delegated build → mt-implementer-1", { agent: "mt-orchestrator" }),
    act(38, "tool", "Edit src/invoice.ts", { agent: "mt-implementer", origin: "hook" }),
    act(40, "question", "Allow bun test?"),
  ],
  files: ["task.md", "plan.json", "state.json", "results/mt-test-author-1.json", "activity.jsonl"],
  gates: [
    {
      gate: "quick",
      files: null,
      startedAt: T(37),
      passed: true,
      steps: [
        { id: "lint", status: "pass", durationMs: 10 },
        { id: "rules", status: "skipped", durationMs: 0 },
      ],
    },
  ],
};

describe("planBoardOf", () => {
  test("stages carry who worked them, when, and the gate's verdict; the next stages name their owners", () => {
    const b = planBoardOf(base);
    expect(b.stages.map((s) => [s.id, s.state, s.verdict ?? null])).toEqual([
      ["intake", "done", null],
      ["plan", "done", "PASS"],
      ["approval", "done", "APPROVE"],
      ["build", "waiting", null],
      ["review", "next", null],
    ]);
    expect(b.stages[1]).toMatchObject({
      owners: ["mt-planner"],
      workedBy: ["mt-planner"],
      startedAt: T(31),
      endedAt: T(33),
    });
    expect(b.stages[3]).toMatchObject({ workedBy: ["mt-orchestrator", "mt-implementer"], startedAt: T(33) });
    expect(b.stages[3]?.endedAt).toBeUndefined();
    expect(b.next).toEqual([{ id: "review", owners: ["mt-pr-review"] }]);
    expect(b.waiting.map((q) => q.id)).toEqual(["q001"]);
    expect(b.gates).toEqual([
      {
        gate: "quick",
        passed: true,
        at: T(37),
        steps: [
          { id: "lint", ok: true },
          { id: "rules", ok: true },
        ],
      },
    ]);
    expect(b.timeline).toHaveLength(5);
    expect(planBoardOf({ ...base, timelineLength: 2 }).timeline.map((a) => a.at)).toEqual([T(38), T(40)]);
  });

  test("a step is done by a worker's result, in progress by an edit, todo otherwise; artifacts say which are present", () => {
    const b = planBoardOf(base);
    expect(b.plan?.steps.map((s) => [s.id, s.state])).toEqual([
      ["S1", "done"],
      ["S2", "in-progress"],
      ["S3", "todo"],
      ["S4", "todo"],
    ]);
    expect(b.plan?.steps[0]).toMatchObject({
      worker: { name: "mt-test-author-1", paneId: "w1:p3" },
      evidence: "mt-test-author-1: 3 tests, red for the right reason",
    });
    expect(b.plan?.steps[1]).toMatchObject({
      worker: { name: "mt-implementer-1", paneId: "w1:p2" },
      evidence: "Edit src/invoice.ts",
      exemplar: "packages/money/src/money.ts:1",
    });
    expect(b.plan?.done).toBe(1);
    const present = Object.fromEntries(b.artifacts.map((a) => [a.name, a.present]));
    expect(present).toMatchObject({
      "task.md": true,
      "plan.json": true,
      "plan-review.md": false,
      "build-log.md": false,
      "verdict.json": false,
    });
    expect(b.artifacts.find((a) => a.name === "build-log.md")?.stage).toBe("build");
    expect(b.artifacts.some((a) => a.name === "state.json")).toBe(false);
  });

  test("a blocked result blocks its step; a live worker without evidence takes the first todo step; no plan is no steps", () => {
    const blocked = planBoardOf({
      ...base,
      results: [
        ...base.results,
        { ...result("mt-implementer-1", "blocked", "two readings"), question: "Round S3 how?" },
      ],
      activity: base.activity.filter((a) => a.type !== "tool"),
    });
    expect(blocked.plan?.steps.map((s) => s.state)).toEqual(["done", "todo", "blocked", "todo"]);
    expect(blocked.plan?.steps[2]?.evidence).toBe("mt-implementer-1: Round S3 how?");
    const quiet = withLiveWorker(
      planBoardOf({ ...base, activity: base.activity.filter((a) => a.type !== "tool") }),
    );
    expect(quiet.plan?.steps.map((s) => s.state)).toEqual(["done", "in-progress", "todo", "todo"]);
    expect(quiet.plan?.steps[1]?.evidence).toBe("mt-implementer-1 works in w1:p2");
    // Evidence beats the guess: with an edit on S2 the live worker changes nothing.
    expect(withLiveWorker(planBoardOf(base)).plan?.steps[1]?.evidence).toBe("Edit src/invoice.ts");
    expect(planBoardOf({ ...base, plan: undefined }).plan).toBeUndefined();
    const done = planBoardOf({ ...base, status: "done", stage: "review" });
    expect(done.stages.every((s) => s.state === "done")).toBe(true);
    expect(done.next).toEqual([]);
  });
});
