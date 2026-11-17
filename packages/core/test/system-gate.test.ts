import { describe, expect, test } from "bun:test";
import { attemptsOf, driveHostOf, stopOf } from "../src/domain/drive.ts";
import { progressOf } from "../src/domain/plan-progress.ts";
import { systemGate } from "../src/domain/system-gate.ts";

const step = (id: string, app: string, status: string, run?: { status: string; stage: string }) => ({
  id,
  app,
  status: status as "pending",
  ...(run ? { run: `r-${id}`, runStatus: run.status, stage: run.stage } : {}),
});
const HOUR = 3_600_000;

describe("the gate of a system run that waits on its children (systemGate)", () => {
  test("every step done: it passes", () => {
    expect(
      systemGate({ steps: [step("a", "shop-api", "done")], ready: [], waitedMs: 0, timeoutMs: HOUR }),
    ).toEqual({
      kind: "pass",
      message: "every step is done",
    });
  });

  test("children still working or not started: it waits, and says which", () => {
    const g = systemGate({
      steps: [
        step("a", "shop-api", "running", { status: "active", stage: "build" }),
        step("b", "shop-web", "pending"),
      ],
      ready: [],
      waitedMs: 1000,
      timeoutMs: HOUR,
    });
    expect(g).toEqual({
      kind: "waiting",
      message: "waiting on children: shop-api working at build, shop-web not started",
    });
  });

  test("a step that can start now sends the run back to start it: a new wave", () => {
    const g = systemGate({
      steps: [step("a", "shop-api", "done"), step("b", "shop-web", "pending")],
      ready: ["b"],
      waitedMs: 0,
      timeoutMs: HOUR,
    });
    expect(g).toEqual({ kind: "wave", message: "a step can start: b" });
  });

  test("a child escalated: the system run waits, blocked by that child, whose card the person acts on", () => {
    const g = systemGate({
      steps: [
        step("a", "shop-api", "blocked", { status: "escalated", stage: "build" }),
        step("b", "shop-web", "running", { status: "active", stage: "plan" }),
      ],
      ready: [],
      waitedMs: 0,
      timeoutMs: HOUR,
    });
    expect(g).toEqual({
      kind: "waiting",
      message: "blocked by r-a (shop-api, at build): needs you; shop-web working at plan",
    });
  });

  test("a child closed as aborted: blocked at once, naming the run and what to do", () => {
    const g = systemGate({
      steps: [step("a", "shop-api", "blocked", { status: "aborted", stage: "build" })],
      ready: [],
      waitedMs: 0,
      timeoutMs: HOUR,
    });
    expect(g).toEqual({
      kind: "blocked",
      message: "step a is blocked: its run r-a in shop-api aborted at build",
      hint: "Its step cannot finish: change the system plan or close this run.",
    });
  });

  test("waiting longer than the timeout: blocked, with how long it waited", () => {
    const g = systemGate({
      steps: [step("a", "shop-api", "running", { status: "active", stage: "build" })],
      ready: [],
      waitedMs: 7 * HOUR,
      timeoutMs: 6 * HOUR,
    });
    expect(g.kind).toBe("blocked");
    expect(g.message).toBe("waited 7 h for the children, longer than 6 h: shop-api working at build");
  });
});

describe("the host a drive takes when nobody names one (driveHostOf)", () => {
  const known = ["copilot", "claude", "scenario"];
  test("METATOR_HOST, else the first of supervisor.hostOrder that can start here, else the first target", () => {
    const pick = (o: Partial<Parameters<typeof driveHostOf>[0]>) =>
      driveHostOf({ order: [], targets: [], known, ...o });
    expect(pick({ chosen: "scenario", order: ["claude"] })).toBe("scenario");
    expect(pick({ order: ["scenario", "claude"], targets: ["claude"] })).toBe("scenario");
    // A host of the order that cannot start here (its program is not installed) is passed over.
    expect(
      pick({ order: ["copilot", "claude"], problem: (h) => (h === "copilot" ? "not installed" : undefined) }),
    ).toBe("claude");
    // One the runtime does not drive agents with is passed over too; then the targets, then the first known.
    expect(pick({ order: ["opencode"], targets: ["claude"] })).toBe("claude");
    expect(pick({ chosen: "nope", order: [], targets: [] })).toBe("copilot");
  });
});

describe("how often an escalated run tried its stage (attemptsOf)", () => {
  const stages = [
    { id: "plan" },
    { id: "plan-gate", onFail: { goto: "plan", loop: "plan" } },
    { id: "status", onFail: { goto: "plan", loop: "waves" } },
    { id: "check" },
  ];
  const limits = { plan: 2, waves: 12 };
  test("tries are the first one and the loops spent, of the first one and the loops allowed", () => {
    expect(attemptsOf(stages, "plan-gate", { plan: 2 }, limits)).toEqual({ tried: 3, of: 3 });
    // Stopped at once (a child escalated): one try of the thirteen it could have had.
    expect(attemptsOf(stages, "status", {}, limits)).toEqual({ tried: 1, of: 13 });
    // A stage without a loop has one try.
    expect(attemptsOf(stages, "check", {}, limits)).toEqual({ tried: 1, of: 1 });
    expect(attemptsOf(stages, "nowhere", {}, limits)).toBeUndefined();
  });
});

describe("stopOf: why an escalated run stopped", () => {
  const stages = [
    { id: "plan" },
    { id: "plan-approval", hitl: true, onFail: { loop: "plan" } },
    { id: "build", onFail: { loop: "build" } },
    { id: "status" },
  ];
  const limits = { plan: 2, build: 2 };

  test("a person's Reject reads as their decision, with their reason; never as spent tries", () => {
    const rejected = stopOf({
      stages,
      stage: "plan-approval",
      reason: "the plan skips the fallback",
      loops: { plan: 2 },
      limits,
      questions: [
        { stage: "plan-approval", source: "gate", answer: { choices: ["Approve"], by: "bob", at: "t" } },
        { stage: "plan-approval", source: "gate", answer: { choices: ["Reject"], by: "ana", at: "t" } },
      ],
    });
    expect(rejected).toEqual({
      kind: "rejected",
      text: "stopped: ana rejected plan-approval: the plan skips the fallback",
      by: "ana",
    });
    // No words: the default reason names the person.
    expect(
      stopOf({ stages, stage: "plan-approval", reason: "rejected by ola", loops: {}, limits }).text,
    ).toBe("stopped: ola rejected plan-approval");
  });

  test("the tries wording only when the loop's tries are spent, with N of M; else where and why it stopped", () => {
    expect(stopOf({ stages, stage: "build", reason: "tests fail", loops: { build: 2 }, limits })).toEqual({
      kind: "exhausted",
      text: "tried build 3 of 3 times: tests fail",
      tried: 3,
      of: 3,
    });
    expect(stopOf({ stages, stage: "build", reason: "blocked", loops: { build: 0 }, limits })).toEqual({
      kind: "stopped",
      text: "stopped at build: blocked",
      tried: 1,
      of: 3,
    });
    expect(stopOf({ stages, stage: "status", reason: "a child escalated", loops: {}, limits }).text).toBe(
      "stopped at status: a child escalated",
    );
  });
});

describe("a step's progress from its run (progressOf)", () => {
  test("done, blocked while its run escalated or aborted, running again once the run is resumed", () => {
    expect(progressOf("done", "running")).toBe("done");
    expect(progressOf("escalated", "running")).toBe("blocked");
    expect(progressOf("active", "pending")).toBe("running");
    expect(progressOf("active", "blocked")).toBe("running");
  });
});
