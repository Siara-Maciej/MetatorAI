import { describe, expect, test } from "bun:test";
import type { RunOverview } from "../src/api.ts";
import {
  groupStepText,
  hostPromptOf,
  optionClosed,
  parseRoute,
  planOrder,
  questionKind,
  type Run,
  rootsProblems,
  routeHash,
  runLine,
  runStateOf,
  shortRunId,
  sidebarRuns,
  stepOf,
  stepPlace,
  systemRunSummary,
} from "../src/model.ts";

const run = (runId: string, extra: Partial<Run> = {}): Run =>
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
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    elapsedMs: 0,
    services: [],
    ...extra,
  }) as Run;

type Step = {
  id: string;
  app: string;
  repo: string;
  task: string;
  dependsOn: string[];
  status: string;
  run?: string;
};
const step = (id: string, extra: Partial<Step> = {}): Step => ({
  id,
  app: id,
  repo: id,
  task: id,
  dependsOn: [],
  status: "pending",
  ...extra,
});
const plan = (steps: Step[], waves: { wave: number; steps: string[] }[]) =>
  ({ plan: { id: "add-currency", task: "Add currency" }, steps, waves }) as unknown as Parameters<
    typeof systemRunSummary
  >[0];

describe("a finished run says how it ended (round 4, item 1)", () => {
  test("an aborted run reads aborted, a done run done; the line shows the end, not the stage it stopped at", () => {
    const aborted = run("x", {
      status: "aborted",
      attention: "aborted",
      stage: "plan-approval",
      host: "scenario",
    });
    expect(runStateOf(aborted)).toBe("aborted");
    expect(runLine(aborted)).toBe("aborted · scenario · 0s");
    expect(runLine(run("y", { status: "done", attention: "done", stage: "done", host: "scenario" }))).toBe(
      "done · scenario · 0s",
    );
    // An open run still shows its stage, and that it asks on its terminal.
    expect(runLine(run("z", { stage: "plan", host: "scenario", terminalAsk: "w1:p2" }))).toBe(
      "asks in its terminal · plan · scenario · 0s",
    );
  });
});

describe("a step is numbered by its place in the system plan (round 4, item 2)", () => {
  const p = plan(
    [step("web", { run: "w", dependsOn: ["api"] }), step("api", { run: "a" })],
    [
      { wave: 1, steps: ["api"] },
      { wave: 2, steps: ["web"] },
    ],
  );
  test("the deploy order is wave by wave, then any step no wave names", () => {
    expect(planOrder(p)).toEqual(["api", "web"]);
    expect(planOrder(plan([step("a"), step("b")], []))).toEqual(["a", "b"]);
  });
  test("the second step is step 2 of 2 whatever started first; a run of no plan has no place", () => {
    expect(stepPlace([p], "w")).toEqual({ at: 2, of: 2 });
    expect(stepPlace([p], "a")).toEqual({ at: 1, of: 2 });
    expect(stepPlace([p], "other")).toBeUndefined();
  });
  test("the sidebar and the card say the same", () => {
    const place = stepPlace([p], "w");
    // Alone under its parent (the first step lives in a finished list), it is still step 2.
    expect(stepOf(run("w"), [run("w")], run("sys"), 2, place)).toBe("step 2/2");
    expect(groupStepText({ step: 1, of: 2 }, 2, false, place)).toBe("step 2 of 2");
    const sys = run("sys", { repo: "api" });
    const w = run("w", { parent: "sys", repo: "web" });
    const rows = sidebarRuns(
      [sys],
      [sys, w],
      () => 2,
      (r) => stepPlace([p], r.runId),
    );
    expect(rows.map((r) => r.step)).toEqual([undefined, "step 2/2"]);
  });
});

describe("a run named in another thing (round 4, item 4)", () => {
  test("its id loses the date and is cut to fit a line", () => {
    expect(shortRunId("20261117-mt-feature-show-a-strike-through-old-price-next-to")).toBe(
      "mt-feature-show-a-strike-throug…",
    );
    expect(shortRunId("20261117-planned-round")).toBe("planned-round");
    expect(shortRunId("my-run")).toBe("my-run");
  });
});

describe("a worker's question on its terminal (round 4, item 5)", () => {
  const prompt =
    "mt-planner-1 waits for your answer in pane w1:p2: │ Which currency does a product without one get? [PLN / EUR]";
  test("the daemon's line is read into who asks, where, the question and its answers", () => {
    expect(hostPromptOf(prompt)).toEqual({
      asker: "mt-planner-1",
      pane: "w1:p2",
      text: "Which currency does a product without one get?",
      options: ["PLN", "EUR"],
    });
    expect(hostPromptOf("claude waits for your answer in pane w1:p1: Allow Bash(rm -rf dist)?")).toEqual({
      asker: "claude",
      pane: "w1:p1",
      text: "Allow Bash(rm -rf dist)?",
      options: [],
    });
    expect(hostPromptOf("Which rounding?")).toBeUndefined();
  });
  test("a question is TERMINAL, a request to allow something PERMISSION; a kind the daemon sends wins", () => {
    expect(questionKind({ source: "permission", prompt })).toBe("TERMINAL");
    expect(
      questionKind({
        source: "permission",
        prompt: "claude waits for your answer in pane w1:p1: Allow Bash(ls)?",
      }),
    ).toBe("PERMISSION");
    expect(questionKind({ source: "permission" })).toBe("PERMISSION");
    expect(questionKind({ source: "gate" })).toBe("APPROVAL");
    expect(questionKind({ source: "agent" })).toBe("QUESTION");
    expect(questionKind({ source: "permission", kind: "permission", prompt } as never)).toBe("PERMISSION");
  });
});

describe("a closed answer on a plan's card (round 4, item 6)", () => {
  const lint = (severity: "error" | "warning") => ({
    problems: [{ severity, message: "src/prices.ts does not exist", rule: "x" }],
  });
  test("the daemon's disabledBecause wins; else a plan with lint errors closes Approve", () => {
    expect(optionClosed({ label: "Approve", disabled: true, disabledBecause: "fix S2" } as never)).toBe(
      "fix S2",
    );
    expect(optionClosed({ label: "Approve" }, lint("error") as never)).toBe(
      "the plan has 1 error: src/prices.ts does not exist",
    );
    expect(optionClosed({ label: "Approve" }, lint("warning") as never)).toBeUndefined();
    expect(optionClosed({ label: "Reject" }, lint("error") as never)).toBeUndefined();
    expect(optionClosed({ label: "Approve" })).toBeUndefined();
  });
  test("Fix the plan opens the Plan tab in its edit mode", () => {
    const hash = routeHash({ screen: "run", runId: "r1", tab: "plan", edit: true });
    expect(hash).toBe("#/run/r1/plan/edit");
    expect(parseRoute(hash)).toEqual({ screen: "run", runId: "r1", tab: "plan", edit: true });
    expect(parseRoute("#/run/r1/terminal/edit")).toEqual({
      screen: "run",
      runId: "r1",
      tab: "terminal",
      pane: "edit",
    });
  });
});

describe("the system roots as a list (round 4, item 7)", () => {
  test("every path must be absolute and listed once; nothing is wrong with a good list", () => {
    expect(rootsProblems(["/home/ana/code", "~/work", "C:\\code"])).toEqual([]);
    expect(rootsProblems(["", "code", "/a/", "/a"])).toEqual([
      "path 1 is empty",
      "path 2 (code) is not absolute: start it with / or ~/",
      "path 4 (/a) is listed twice",
    ]);
  });
});

describe("a system run's page says how far its plan is (round 4, item 8)", () => {
  const p = plan(
    [
      step("api", { run: "a", status: "done" }),
      step("web", { run: "w", status: "running", dependsOn: ["api"] }),
    ],
    [
      { wave: 1, steps: ["api"] },
      { wave: 2, steps: ["web"] },
    ],
  );
  test("blocked by the child that needs a person, with its link", () => {
    const runs = [
      run("a", { status: "done", attention: "done" }),
      run("w", { attention: "you", repo: "web" }),
    ];
    expect(systemRunSummary(p, run("sys"), runs)).toEqual({
      planId: "add-currency",
      done: 1,
      total: 2,
      blocker: { runId: "w", repo: "web", task: "w", state: "needs you" },
    });
  });
  test("an escalated child blocks too; with none, the gate's own words", () => {
    const esc = [run("w", { status: "escalated", attention: "escalated" })];
    expect(systemRunSummary(p, run("sys"), esc).blocker?.state).toBe("escalated");
    const sys = run("sys", {
      last: {
        at: "2026-11-17T10:00:00.000Z",
        type: "gate",
        text: "gate: waiting on children: web working at build",
      },
    } as Partial<Run>);
    expect(systemRunSummary(p, sys, [run("w")])).toEqual({
      planId: "add-currency",
      done: 1,
      total: 2,
      waiting: "waiting on children: web working at build",
    });
    // Something else the run did last is not what it waits for.
    const other = run("sys", { last: { at: "x", type: "note", text: "a note" } } as unknown as Partial<Run>);
    expect(systemRunSummary(p, other, []).waiting).toBeUndefined();
  });
});

// The type stays tied to the daemon's: a run is a RunOverview with its repository.
const _typed: RunOverview = run("t");
void _typed;

describe("states roll up with aborted among them", () => {
  test("an aborted run alone reads aborted; any other state is stronger", async () => {
    const { rollUp, runWithPanes } = await import("../src/model.ts");
    expect(rollUp(["aborted"])).toBe("aborted");
    expect(rollUp(["aborted", "done"])).toBe("done");
    expect(rollUp(["aborted", "idle"])).toBe("idle");
    expect(rollUp([])).toBe("idle");
    expect(runWithPanes(run("x", { status: "aborted", attention: "aborted" }), ["working"])).toBe("aborted");
  });
});

describe("which needs open the pane and which open their card", () => {
  test("a run asking on its terminal opens the pane; a question read from a terminal has its card", async () => {
    const { isTerminalAsk } = await import("../src/model.ts");
    expect(isTerminalAsk({ key: "terminal:shop:r1" })).toBe(true);
    expect(isTerminalAsk({ key: "r1/q001" })).toBe(false);
  });
});

describe("a question the daemon read from a terminal, as the agent's (round 4, item 5)", () => {
  const ATTACH = { label: "Attach and answer in the pane" };
  test("an agent's question with the way into its pane is TERMINAL; Attach goes to the pane from any card", async () => {
    const { goesToPane, isTerminalQuestion } = await import("../src/model.ts");
    const q = { source: "agent" as const, options: [{ label: "PLN" }, { label: "EUR" }, ATTACH] };
    expect(isTerminalQuestion(q)).toBe(true);
    expect(questionKind({ ...q, prompt: "Which currency?" })).toBe("TERMINAL");
    expect(questionKind({ source: "agent", options: [{ label: "PLN" }] })).toBe("QUESTION");
    expect(goesToPane(q, ATTACH.label)).toBe(true);
    expect(goesToPane(q, "PLN")).toBe(false);
  });
  test("the pane is the one the prompt names, else the asking worker's or conductor's in the run", async () => {
    const { paneOfQuestion } = await import("../src/model.ts");
    const panes = [
      {
        id: "w1:p1",
        runId: "r",
        role: "conductor",
        label: "c",
        process: { kind: "host", agent: "mt-orchestrator" },
      },
      {
        id: "w1:p2",
        runId: "r",
        role: "worker",
        label: "w",
        worker: { name: "mt-planner-1" },
        process: { kind: "host" },
      },
      {
        id: "w2:p2",
        runId: "other",
        role: "worker",
        label: "w",
        worker: { name: "mt-planner-1" },
        process: { kind: "host" },
      },
    ] as never;
    expect(paneOfQuestion({ prompt: "x waits for your answer in pane w9:p9: y", runId: "r" }, panes)).toBe(
      "w9:p9",
    );
    expect(paneOfQuestion({ prompt: "Which?", agent: "mt-planner-1", runId: "r" }, panes)).toBe("w1:p2");
    expect(paneOfQuestion({ prompt: "Which?", agent: "mt-orchestrator", runId: "r" }, panes)).toBe("w1:p1");
    expect(paneOfQuestion({ prompt: "Which?", agent: "nobody", runId: "r" }, panes)).toBeUndefined();
    expect(paneOfQuestion({ prompt: "Which?", runId: "r" }, panes)).toBeUndefined();
  });
});
