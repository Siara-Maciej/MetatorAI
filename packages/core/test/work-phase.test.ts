import { describe, expect, test } from "bun:test";
import { WORK_PHASES, workPhase } from "../src/domain/work-phase.ts";

// The stages of the shipped workflows, as their files declare them.
const FEATURE = [
  { id: "setup" },
  { id: "intake" },
  { id: "context" },
  { id: "plan" },
  { id: "plan-gate" },
  { id: "plan-approval", hitl: true },
  { id: "build" },
  { id: "gates" },
  { id: "review" },
  { id: "delivery", hitl: true },
  { id: "publish" },
  { id: "learn" },
];
const SYSTEM = [
  { id: "analyze" },
  { id: "plan" },
  { id: "plan-gate" },
  { id: "plan-approval", hitl: true },
  { id: "children" },
  { id: "status" },
  { id: "delivery", hitl: true },
];
const phases = (stages: readonly { id: string; hitl?: boolean }[]) =>
  stages.map((s) => [s.id, workPhase(stages, s.id, "active")]);

describe("the phase of a run on the board", () => {
  test("mt-feature: understanding and planning, the work, then everything that looks at it", () => {
    expect(phases(FEATURE)).toEqual([
      ["setup", "planning"],
      ["intake", "planning"],
      ["context", "planning"],
      ["plan", "planning"],
      ["plan-gate", "planning"],
      ["plan-approval", "planning"],
      ["build", "in-progress"],
      ["gates", "review"],
      ["review", "review"],
      ["delivery", "review"],
      ["publish", "review"],
      ["learn", "review"],
    ]);
  });

  test("a system run is in progress while its children work and waits for them", () => {
    expect(phases(SYSTEM)).toEqual([
      ["analyze", "planning"],
      ["plan", "planning"],
      ["plan-gate", "planning"],
      ["plan-approval", "planning"],
      ["children", "in-progress"],
      ["status", "in-progress"],
      ["delivery", "review"],
    ]);
  });

  test("a bare approval closes the phase of the stage before it", () => {
    const afterPlan = [{ id: "triage" }, { id: "plan" }, { id: "approval", hitl: true }, { id: "build" }];
    expect(workPhase(afterPlan, "approval", "active")).toBe("planning");
    const afterWork = [{ id: "build" }, { id: "approval", hitl: true }];
    expect(workPhase(afterWork, "approval", "active")).toBe("review");
    // An approval first, or after another approval, is a look at something: review.
    expect(workPhase([{ id: "approval", hitl: true }], "approval", "active")).toBe("review");
    const twoGates = [{ id: "build" }, { id: "sign-off", hitl: true }, { id: "approval", hitl: true }];
    expect(workPhase(twoGates, "approval", "active")).toBe("review");
  });

  test("a finished run is done, whatever stage it stopped at; an escalated one keeps its stage's phase", () => {
    expect(workPhase(FEATURE, "done", "done")).toBe("done");
    expect(workPhase(FEATURE, "plan-approval", "aborted")).toBe("done");
    expect(workPhase(FEATURE, "build", "escalated")).toBe("in-progress");
    expect(workPhase(FEATURE, "gates", "escalated")).toBe("review");
  });

  test("a stage the workflow does not declare is read from its words, else it is in progress", () => {
    expect(workPhase(FEATURE, "plan-review", "active")).toBe("planning");
    expect(workPhase(FEATURE, "checks", "active")).toBe("review");
    expect(workPhase(FEATURE, "implement", "active")).toBe("in-progress");
    // A word inside another word is not that word.
    expect(workPhase([{ id: "explanation" }], "explanation", "active")).toBe("in-progress");
    expect(workPhase([{ id: "refinding" }], "refinding", "active")).toBe("in-progress");
  });

  test("the board's columns, in order", () => {
    expect(WORK_PHASES).toEqual(["todo", "planning", "in-progress", "review", "done"]);
  });
});
