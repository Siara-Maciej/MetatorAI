import { describe, expect, test } from "bun:test";
import {
  allowedWorkers,
  conductorHost,
  conductorPrompt,
  mayStartConductor,
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

  test("a conductor's host: the one asked for when installed, else the first installed in order; none installed, none", () => {
    const hosts = [
      { id: "copilot", command: "copilot", installed: false },
      { id: "claude", command: "claude", installed: true },
      { id: "opencode", command: "opencode", installed: true },
    ];
    expect(conductorHost(undefined, hosts)).toBe("claude");
    expect(conductorHost("opencode", hosts)).toBe("opencode");
    // Asked for one that is not installed (or not interactive at all): the order decides.
    expect(conductorHost("copilot", hosts)).toBe("claude");
    expect(conductorHost("scenario-only-agent", hosts)).toBe("claude");
    expect(
      conductorHost(
        "claude",
        hosts.map((h) => ({ ...h, installed: false })),
      ),
    ).toBeUndefined();
    expect(conductorHost(undefined, [])).toBeUndefined();
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
    expect(text).toContain("Never end your turn with a question or options in prose and wait");
    // The conductor moves its run itself: nothing tells it to start a background drive of it.
    expect(text).not.toContain("drive --detach");
    expect(text).toContain("never start `metator run drive`");
  });

  test("a stage with parallel agents: the prompt says how many workers may work at once, and to start them before waiting", () => {
    const text = conductorPrompt({
      runId: "r",
      task: "t",
      workflow: "demo",
      stages: [
        { id: "context", parallel: ["mt-scout", "mt-pattern-miner"] },
        { id: "setup", owner: "script:metator index build" },
      ],
      parallel: 2,
      runDir: "/repo/.metator/runs/r",
    });
    expect(text).toContain("- context: mt-scout, mt-pattern-miner (in parallel, up to 2 workers at once)");
    expect(text).toContain("- setup: you run `metator index build`, then advance");
    expect(text).toContain("delegate each of them before you wait");
  });

  test("a stage's gate script is in its row: the conductor runs it before it advances, and exit 4 means not yet", () => {
    const text = conductorPrompt({
      runId: "r",
      task: "t",
      workflow: "mt-quick",
      stages: [
        { id: "build", owner: "mt-implementer", gate: { script: "metator gate full" } },
        { id: "fit", owner: "script:metator quick check --diff", gate: { script: "metator quick fit" } },
        { id: "plain", owner: "mt-planner" },
      ],
      runDir: "/repo/.metator/runs/r",
    });
    expect(text).toContain("- build: mt-implementer · gate `metator gate full`");
    expect(text).toContain(
      "- fit: you run `metator quick check --diff`, then advance · gate `metator quick fit`",
    );
    expect(text).toContain("- plain: mt-planner\n");
    expect(text).toContain(
      "A stage with a gate: run the gate after the stage's work and advance pass only when it exits 0. Exit 4 means not yet (it waits for a person or for other work): run it again; `metator quick fit` and `metator quick ready` take `--wait`, which returns when the person answered.",
    );
    // No stage has a gate: the line is not there.
    expect(
      conductorPrompt({ runId: "r", task: "t", workflow: "w", stages: [{ id: "a" }], runDir: "/r" }),
    ).not.toContain("A stage with a gate");
  });

  test("who may open a run's conductor session from a pane: the chat with no run of its own, or the run's conductor", () => {
    expect(mayStartConductor({ role: "apps" }, "r1")).toBe(true);
    expect(mayStartConductor({ role: "conductor", runId: "r1" }, "r1")).toBe(true);
    // Another run's conductor, a worker, a shell, and an entry pane that belongs to a run: never.
    expect(mayStartConductor({ role: "conductor", runId: "r2" }, "r1")).toBe(false);
    expect(mayStartConductor({ role: "worker", runId: "r1" }, "r1")).toBe(false);
    expect(mayStartConductor({ role: "shell" }, "r1")).toBe(false);
    expect(mayStartConductor({ role: "apps", runId: "r2" }, "r1")).toBe(false);
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
    expect(text).toContain("Never ask the person in prose and wait");
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
