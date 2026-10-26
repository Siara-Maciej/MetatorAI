import { describe, expect, test } from "bun:test";
import { RunStateMachine } from "../src/domain/run-machine.ts";
import type { RunState } from "../src/domain/run-record.ts";
import type { WorkflowSpecInput as WorkflowSpec } from "../src/domain/workflow-spec.ts";

const feature: WorkflowSpec = {
  id: "mt-feature",
  stages: [
    { id: "context" },
    { id: "plan" },
    { id: "plan-gate", onFail: { goto: "plan", loop: "plan" } },
    { id: "approval", hitl: true },
    { id: "build" },
    { id: "review", onFail: { goto: "plan", loop: "review" } },
  ],
  loops: { plan: 2, review: 1 },
};

const machine = () => RunStateMachine.create(feature)._unsafeUnwrap();

function drive(state: RunState, ...events: Parameters<RunStateMachine["send"]>[1][]): RunState {
  const m = machine();
  return events.reduce((s, e) => m.send(s, e)._unsafeUnwrap(), state);
}

describe("RunStateMachine (XState)", () => {
  test("starts at the first stage with empty context", () => {
    expect(machine().start()).toEqual({
      workflow: "mt-feature",
      stage: "context",
      status: "active",
      context: { loops: {}, history: [] },
    });
  });

  test("happy path: PASS through stages, APPROVE at the human gate, ends done", () => {
    const end = drive(
      machine().start(),
      { type: "PASS" },
      { type: "PASS" },
      { type: "PASS" },
      { type: "APPROVE", by: "maciej", choice: "1" },
      { type: "PASS" },
      { type: "PASS" },
    );
    expect(end.stage).toBe("done");
    expect(end.status).toBe("done");
    expect(end.context.history.map((h) => `${h.stage}:${h.event}`)).toEqual([
      "context:PASS",
      "plan:PASS",
      "plan-gate:PASS",
      "approval:APPROVE",
      "build:PASS",
      "review:PASS",
    ]);
    expect(end.context.history[3]).toEqual({ stage: "approval", event: "APPROVE", detail: "maciej" });
  });

  test("human gate rejects PASS: an agent cannot approve itself", () => {
    const atGate = drive(machine().start(), { type: "PASS" }, { type: "PASS" }, { type: "PASS" });
    expect(atGate.stage).toBe("approval");
    const denied = machine().send(atGate, { type: "PASS" })._unsafeUnwrapErr();
    expect(denied.code).toBe("TRANSITION_DENIED");
    expect(denied.hint).toContain("APPROVE");
  });

  test("FAIL loops back and counts against the loop limit", () => {
    const afterOneRetry = drive(
      machine().start(),
      { type: "PASS" },
      { type: "PASS" },
      { type: "FAIL", reason: "plan lint" },
    );
    expect(afterOneRetry.stage).toBe("plan");
    expect(afterOneRetry.context.loops).toEqual({ plan: 1 });
  });

  test("exhausted loop escalates instead of looping forever", () => {
    let state = drive(machine().start(), { type: "PASS" }, { type: "PASS" });
    for (let i = 0; i < 2; i++) state = drive(state, { type: "FAIL" }, { type: "PASS" });
    expect(state.context.loops.plan).toBe(2);
    const escalated = drive(state, { type: "FAIL", reason: "still failing" });
    expect(escalated.status).toBe("escalated");
    expect(escalated.context.history.at(-1)).toEqual({
      stage: "plan-gate",
      event: "FAIL",
      detail: "still failing",
    });
  });

  test("loops are counted per loop name", () => {
    const toReview = drive(
      machine().start(),
      { type: "PASS" },
      { type: "PASS" },
      { type: "PASS" },
      { type: "APPROVE", by: "u" },
      { type: "PASS" },
    );
    const back = drive(toReview, { type: "FAIL" });
    expect(back.stage).toBe("plan");
    expect(back.context.loops).toEqual({ review: 1 });
  });

  test("a stage without onFail escalates on FAIL", () => {
    expect(drive(machine().start(), { type: "FAIL" }).status).toBe("escalated");
  });

  test("ABORT works from any active stage", () => {
    const aborted = drive(
      machine().start(),
      { type: "PASS" },
      { type: "ABORT", reason: "requirements changed" },
    );
    expect(aborted.status).toBe("aborted");
  });

  test("terminal states accept nothing", () => {
    const aborted = drive(machine().start(), { type: "ABORT", reason: "x" });
    const error = machine().send(aborted, { type: "PASS" })._unsafeUnwrapErr();
    expect(error.code).toBe("TRANSITION_DENIED");
    expect(error.hint).toContain("aborted");
  });

  test("state survives a JSON round trip (state.json) and resumes in a new machine", () => {
    const midway = drive(machine().start(), { type: "PASS" }, { type: "PASS" }, { type: "FAIL" });
    const restored: RunState = JSON.parse(JSON.stringify(midway));
    const resumed = drive(restored, { type: "PASS" }, { type: "PASS" });
    expect(resumed.stage).toBe("approval");
    expect(resumed.context.loops).toEqual({ plan: 1 });
    expect(resumed.context.history).toHaveLength(5);
  });

  test("send is pure: the input state is never mutated", () => {
    const start = machine().start();
    const snapshot = JSON.stringify(start);
    machine().send(start, { type: "PASS" });
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  test("rejects a state from another workflow", () => {
    const other = { ...machine().start(), workflow: "mt-review" };
    expect(machine().send(other, { type: "PASS" })._unsafeUnwrapErr().code).toBe("TRANSITION_DENIED");
  });
});

describe("RunStateMachine spec validation", () => {
  const invalid = (spec: WorkflowSpec) => RunStateMachine.create(spec)._unsafeUnwrapErr();

  test("empty workflow", () => {
    expect(invalid({ id: "w", stages: [] }).code).toBe("INVALID_CONFIG");
  });

  test("duplicate stage ids", () => {
    expect(invalid({ id: "w", stages: [{ id: "a" }, { id: "a" }] }).message).toContain("Duplicate");
  });

  test("reserved terminal names", () => {
    expect(invalid({ id: "w", stages: [{ id: "done" }] }).message).toContain("reserved");
  });

  test("onFail to an unknown stage", () => {
    expect(
      invalid({ id: "w", stages: [{ id: "a", onFail: { goto: "zz", loop: "l" } }], loops: { l: 1 } }).message,
    ).toContain("unknown stage");
  });

  test("onFail with an undefined loop limit says how to fix it", () => {
    const error = invalid({ id: "w", stages: [{ id: "a", onFail: { goto: "a", loop: "retry" } }] });
    expect(error.message).toContain("add loops.retry");
    expect(error.hint).toContain("metator workflow schema");
  });
});

describe("RunStateMachine.skippable", () => {
  const gates = RunStateMachine.create({
    id: "g",
    stages: [
      { id: "a", hitl: true, skipAt: ["L1"] },
      { id: "b", hitl: true, skipAt: ["L1"], neverSkip: true },
      { id: "c", skipAt: ["L1"] },
    ],
  })._unsafeUnwrap();
  const at = (stage: string, status: RunState["status"] = "active"): RunState => ({
    workflow: "g",
    stage,
    status,
    context: { loops: {}, history: [] },
  });

  test("a human gate at a level it names; never a neverSkip gate, a working stage or a finished run", () => {
    expect([
      gates.skippable(at("a"), "L1"),
      gates.skippable(at("a"), "L0"),
      gates.skippable(at("a"), "L2"),
    ]).toEqual([true, false, false]);
    expect(gates.skippable(at("b"), "L1")).toBe(false);
    expect(gates.skippable(at("c"), "L1")).toBe(false);
    expect(gates.skippable(at("a", "aborted"), "L1")).toBe(false);
  });
});
