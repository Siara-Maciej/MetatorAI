import { describe, expect, test } from "bun:test";
import { planCut, planFromState, stopAtPlan } from "../src/domain/plan-cut.ts";
import type { RunState } from "../src/domain/run-record.ts";

const FEATURE = [
  { id: "setup" },
  { id: "intake" },
  { id: "context", produces: ["analysis.json"] },
  { id: "plan", produces: ["plan.json", "plan-scope.json"] },
  { id: "plan-gate" },
  { id: "plan-approval", hitl: true },
  { id: "build" },
  { id: "gates" },
  { id: "delivery", hitl: true },
];

describe("where a plan ends in a workflow (ADR-0096)", () => {
  test("mt-feature: the plan stage, its review (the stage after it) and the first stage past planning", () => {
    expect(planCut({ stages: FEATURE })).toEqual({ plan: "plan", review: "plan-gate", build: "build" });
  });

  test("the plan stage is the one that produces plan.json, whatever its name", () => {
    const stages = [
      { id: "design", produces: ["plan.json"] },
      { id: "approval", hitl: true },
      { id: "code" },
    ];
    expect(planCut({ stages })).toEqual({ plan: "design", review: "approval", build: "code" });
  });

  test("no plan stage, or nothing after the plan: no cut (a workflow that cannot stop at its plan)", () => {
    expect(planCut({ stages: [{ id: "build" }, { id: "check" }] })).toBeUndefined();
    expect(planCut({ stages: [{ id: "plan" }, { id: "plan-approval", hitl: true }] })).toBeUndefined();
  });

  test("a run --until plan stops where building would start: planned, with its history kept", () => {
    const cut = { plan: "plan", review: "plan-gate", build: "build" };
    const at = (stage: string): RunState => ({
      workflow: "mt-feature",
      stage,
      status: "active",
      context: { loops: { plan: 1 }, history: [{ stage: "plan-approval", event: "APPROVE", detail: "ana" }] },
    });
    expect(stopAtPlan(at("build"), cut)).toEqual({
      ...at("build"),
      stage: "planned",
      status: "planned",
    });
    // Before the plan is approved it goes on; an ended run is left as it is.
    expect(stopAtPlan(at("plan-approval"), cut)).toEqual(at("plan-approval"));
    expect(stopAtPlan({ ...at("build"), status: "aborted", stage: "aborted" }, cut).status).toBe("aborted");
  });

  test("a run from an approved plan starts at build, or at the plan's review; the stages before are skipped", () => {
    const cut = planCut({ stages: FEATURE }) as NonNullable<ReturnType<typeof planCut>>;
    const build = planFromState("mt-feature", FEATURE, cut, "build", "20261122-mt-feature-x");
    expect(build.stage).toBe("build");
    expect(build.status).toBe("active");
    expect(build.context.history).toEqual(
      ["setup", "intake", "context", "plan", "plan-gate", "plan-approval"].map((stage) => ({
        stage,
        event: "PASS",
        detail: "plan from 20261122-mt-feature-x",
      })),
    );
    const review = planFromState("mt-feature", FEATURE, cut, "review", "r1");
    expect([review.stage, review.context.history.map((h) => h.stage)]).toEqual([
      "plan-gate",
      ["setup", "intake", "context", "plan"],
    ]);
  });
});

describe("a planned run in the overview", () => {
  test("its planning stages are done, nothing after; nobody has to act; its phase is done", async () => {
    const { attentionOf, stageProgress } = await import("../src/domain/overview.ts");
    const { workPhase } = await import("../src/domain/work-phase.ts");
    expect(stageProgress(FEATURE, "planned", "planned", 0).map((s) => [s.id, s.state])).toEqual([
      ["setup", "done"],
      ["intake", "done"],
      ["context", "done"],
      ["plan", "done"],
      ["plan-gate", "done"],
      ["plan-approval", "done"],
      ["build", "next"],
      ["gates", "next"],
      ["delivery", "next"],
    ]);
    expect(attentionOf("planned", 0, false, false)).toBe("done");
    expect(workPhase(FEATURE, "planned", "planned")).toBe("done");
  });
});
