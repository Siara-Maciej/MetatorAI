import { describe, expect, test } from "bun:test";
import {
  allowedWorkers,
  conductorPrompt,
  WORKER_RUN_CONTROL,
  WorkerResultDocument,
  workerName,
  workerPrompt,
} from "../src/domain/conductor.ts";
import { preToolPolicy } from "../src/domain/hook.ts";

describe("conductor domain", () => {
  test("a stage's workers are its agent owners and parallel agents, not skills or scripts", () => {
    expect(allowedWorkers({ owner: "mt-planner" })).toEqual(["mt-planner"]);
    expect(
      allowedWorkers({
        owner: ["mt-test-author", "mt-implementer"],
        parallel: ["mt-implementer", "skill:x", "script:bun test"],
      }),
    ).toEqual(["mt-test-author", "mt-implementer"]);
    expect(allowedWorkers({})).toEqual([]);
  });

  test("a worker's name counts up past the taken ones", () => {
    expect(workerName("mt-implementer", [])).toBe("mt-implementer-1");
    expect(workerName("mt-implementer", ["mt-implementer-1", "mt-implementer-2", "mt-planner-1"])).toBe(
      "mt-implementer-3",
    );
  });

  test("the conductor's prompt names the run, each stage's agents or gate, and the five commands", () => {
    const text = conductorPrompt({
      runId: "20261109-demo-x",
      task: "Add the discount",
      workflow: "demo",
      stages: [
        { id: "plan", owner: "mt-planner", produces: ["plan.json"] },
        { id: "plan-gate", hitl: true },
        { id: "build", owner: ["mt-test-author", "mt-implementer"] },
        { id: "intake" },
      ],
      runDir: "/repo/.metator/runs/20261109-demo-x",
    });
    expect(text).toContain("conductor of run 20261109-demo-x (workflow demo)");
    expect(text).toContain("- plan: mt-planner → plan.json");
    expect(text).toContain("- plan-gate: a person (gate)");
    expect(text).toContain("- build: mt-test-author, mt-implementer");
    expect(text).toContain("- intake: you");
    for (const c of ["run delegate", "run wait", "run collect", "run advance", "run workers"])
      expect(text).toContain(c);
    expect(text).toContain("never type into another pane");
  });

  test("a worker's prompt carries its card and the one way to report", () => {
    const text = workerPrompt({
      runId: "r",
      worker: "mt-implementer-1",
      stage: "build",
      agent: "mt-implementer",
      card: "Implement step 1",
      runDir: "/r/.metator/runs/r",
    });
    expect(text).toContain('worker mt-implementer-1 of stage "build"');
    expect(text).toContain("Implement step 1");
    expect(text).toContain("metator run result --worker mt-implementer-1 --status done");
    expect(text).toContain("--status blocked --question");
  });

  test("a result document round-trips; a blocked one may carry a question", () => {
    const doc = WorkerResultDocument.stamp({
      worker: "mt-implementer-1",
      stage: "build",
      agent: "mt-implementer",
      status: "blocked",
      summary: "tests red",
      artifacts: ["build-log.md"],
      question: "Keep the old API?",
      at: "2026-11-09T10:00:00.000Z",
    });
    expect(WorkerResultDocument.parse(doc, "x")._unsafeUnwrap().question).toBe("Keep the old API?");
  });

  test("a worker may report and write, never steer the run", () => {
    const ctx = { root: "/repo", coordinator: false, worker: true, run: { id: "r", approvals: {} } };
    const run = (command: string) =>
      preToolPolicy({ tool: "Bash", input: { command }, stopActive: false }, ctx);
    expect(run("metator run advance pass")).toEqual({
      decision: "deny",
      reason: WORKER_RUN_CONTROL("metator run advance"),
    });
    expect(run("metator run delegate build --agent x --card y").decision).toBe("deny");
    expect(run("metator run collect w").decision).toBe("deny");
    expect(run("metator run approve plan-gate --by me").decision).toBe("deny");
    expect(run("metator run result --worker w --status done --summary ok").decision).toBe("allow");
    expect(run("metator run status").decision).toBe("allow");
    // The conductor (no worker flag) keeps steering when no drive carries the run.
    expect(
      preToolPolicy(
        { tool: "Bash", input: { command: "metator run advance pass" }, stopActive: false },
        { ...ctx, worker: false },
      ).decision,
    ).toBe("allow");
  });
});
