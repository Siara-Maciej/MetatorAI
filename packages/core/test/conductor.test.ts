import { describe, expect, test } from "bun:test";
import {
  Conductor,
  DEFAULT_PATHS,
  InitRun,
  LayoutStore,
  Panes,
  PtyBroker,
  RunJournal,
  RunRepository,
  WorkflowCatalog,
} from "@metator/core";
import {
  FakeInteractiveHost,
  FakeTerminal,
  FixedClock,
  InMemoryFileSystem,
  InstantTimer,
} from "@metator/testing";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
limits: { parallel: 2 }
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json]
  - id: plan-gate
    hitl: true
  - id: build
    owner: [mt-test-author, mt-implementer]
    parallel: [mt-implementer]
`;

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-09T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const timers: { fn: () => void }[] = [];
  const broker = new PtyBroker({
    repo,
    journal,
    idleMs: 1000,
    after: (_ms, fn) => {
      const t = { fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  const copilot = new FakeInteractiveHost("copilot");
  const panes = new Panes({
    layout: new LayoutStore(fs),
    broker,
    hosts: new Map([["copilot", copilot]]),
    terminal: new FakeTerminal(),
    repo,
    journal,
    clock,
    timer: new InstantTimer(),
    root: "/repo",
    token: () => "tok",
  });
  const conductor = new Conductor({
    panes,
    repo,
    journal,
    catalog,
    fs,
    clock,
    timer: new InstantTimer(),
    root: "/repo",
  });
  const init = (task: string) => new InitRun(catalog, repo, clock).execute({ workflow: "demo", task });
  return { fs, repo, journal, broker, copilot, panes, conductor, timers, init };
}

describe("Conductor", () => {
  test("start opens the run as a conductor pane with the orchestrator and the workflow in its prompt", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const pane = (await w.conductor.start({ runId: r.runId }))._unsafeUnwrap();
    expect(pane).toMatchObject({
      role: "conductor",
      process: { kind: "host", host: "copilot", agent: "mt-orchestrator" },
    });
    const task = w.copilot.started[0]?.task;
    expect(task?.agent).toBe("mt-orchestrator");
    expect(task?.prompt).toContain(`conductor of run ${r.runId} (workflow demo)`);
    expect(task?.prompt).toContain("- build: mt-test-author, mt-implementer");
    expect(task?.env?.METATOR_ROLE).toBe("conductor");
  });

  test("delegate opens a worker pane for the current stage's agent with its card; the rules of the stage hold", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.conductor.start({ runId: r.runId });
    const d = (
      await w.conductor.delegate({
        runId: r.runId,
        agent: "mt-planner",
        card: "Plan the change in src/invoice.ts",
      })
    )._unsafeUnwrap();
    expect(d).toEqual({ worker: "mt-planner-1", paneId: "w1:p2", stage: "plan" });
    const worker = w.copilot.started[1];
    expect(worker?.task.agent).toBe("mt-planner");
    expect(worker?.task.prompt).toContain("Plan the change in src/invoice.ts");
    expect(worker?.task.prompt).toContain("metator run result --worker mt-planner-1 --status done");
    expect(worker?.task.env).toMatchObject({ METATOR_ROLE: "worker", METATOR_PANE_ID: "w1:p2" });
    expect((await w.fs.read(`.metator/runs/${r.runId}/work/mt-planner-1.md`))._unsafeUnwrap()).toBe(
      "Plan the change in src/invoice.ts\n",
    );
    const wrong = await w.conductor.delegate({ runId: r.runId, agent: "mt-implementer", card: "x" });
    expect(wrong._unsafeUnwrapErr().message).toBe("stage plan does not list mt-implementer");
    expect(wrong._unsafeUnwrapErr().hint).toBe("Its agents: mt-planner.");
    const other = await w.conductor.delegate({
      runId: r.runId,
      stage: "build",
      agent: "mt-implementer",
      card: "x",
    });
    expect(other._unsafeUnwrapErr().message).toBe("the run is at stage plan, not build");
    expect(
      (await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "  " }))._unsafeUnwrapErr()
        .message,
    ).toContain("needs a card");
    const workers = (await w.conductor.workers(r.runId))._unsafeUnwrap();
    expect(workers).toEqual([
      { name: "mt-planner-1", stage: "plan", agent: "mt-planner", paneId: "w1:p2", alive: true, idle: false },
    ]);
  });

  test("the workflow's parallel limit holds; a second worker of the same agent gets the next number", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.conductor.start({ runId: r.runId });
    expect(
      (await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "a" }))._unsafeUnwrap().worker,
    ).toBe("mt-planner-1");
    expect(
      (await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "b" }))._unsafeUnwrap().worker,
    ).toBe("mt-planner-2");
    const third = await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "c" });
    expect(third._unsafeUnwrapErr().message).toBe(
      "stage plan allows 2 worker(s) at a time; mt-planner-1, mt-planner-2 still work",
    );
    expect(
      (
        await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "c", name: "mt-planner-1" })
      )._unsafeUnwrapErr().message,
    ).toContain("allows 2");
  });

  test("a worker reports; wait sees it; collect returns it and closes the pane; blocked asks the person", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.conductor.start({ runId: r.runId });
    const d = (
      await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "plan it" })
    )._unsafeUnwrap();
    expect(
      (await w.conductor.wait({ runId: r.runId, worker: d.worker, timeoutMs: 0 }))._unsafeUnwrap(),
    ).toEqual({ state: "timeout" });
    expect((await w.conductor.collect({ runId: r.runId, worker: d.worker }))._unsafeUnwrapErr().message).toBe(
      "worker mt-planner-1 has not reported yet",
    );
    const reported = (
      await w.conductor.report({
        runId: r.runId,
        worker: d.worker,
        status: "done",
        summary: "plan.json written\n3 steps",
        artifacts: ["plan.json"],
      })
    )._unsafeUnwrap();
    expect(reported).toMatchObject({
      worker: "mt-planner-1",
      stage: "plan",
      agent: "mt-planner",
      status: "done",
      artifacts: ["plan.json"],
    });
    expect(
      (await w.conductor.wait({ runId: r.runId, worker: d.worker, timeoutMs: 1000 }))._unsafeUnwrap(),
    ).toEqual({ state: "result", result: reported });
    const collected = (await w.conductor.collect({ runId: r.runId, worker: d.worker }))._unsafeUnwrap();
    expect([collected.status, collected.paneClosed, w.copilot.started[1]?.pty.killed]).toEqual([
      "done",
      true,
      true,
    ]);
    expect((await w.conductor.workers(r.runId))._unsafeUnwrap()).toEqual([]);
    // A blocked worker: its question reaches the person as a MetatorAI question.
    const d2 = (
      await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "plan again" })
    )._unsafeUnwrap();
    expect(
      (
        await w.conductor.report({
          runId: r.runId,
          worker: d2.worker,
          status: "blocked",
          summary: "two ways",
        })
      )._unsafeUnwrapErr().message,
    ).toContain("--question");
    await w.conductor.report({
      runId: r.runId,
      worker: d2.worker,
      status: "blocked",
      summary: "two ways",
      question: "Round half up?",
    });
    const questions = (await w.journal.questions(r.runId))._unsafeUnwrap();
    expect(questions.map((q) => [q.source, q.agent, q.prompt])).toEqual([
      ["agent", "mt-planner", "mt-planner-2: Round half up?"],
    ]);
    const texts = (await w.journal.activity(r.runId))._unsafeUnwrap().map((a) => a.text);
    expect(texts).toContain("delegated plan to worker mt-planner-1 in pane w1:p2");
    expect(texts).toContain("worker mt-planner-1 reported done: plan.json written");
    expect(texts).toContain("collected worker mt-planner-1: done, plan.json written");
  });

  test("wait tells an ended or idle worker pane apart from a report; unknown workers are errors", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.conductor.start({ runId: r.runId });
    const d = (
      await w.conductor.delegate({ runId: r.runId, agent: "mt-planner", card: "plan it" })
    )._unsafeUnwrap();
    w.timers.at(-1)?.fn();
    await Bun.sleep(5);
    expect(
      (await w.conductor.wait({ runId: r.runId, worker: d.worker, timeoutMs: 1000 }))._unsafeUnwrap(),
    ).toEqual({ state: "idle" });
    w.copilot.started[1]?.pty.exit(1);
    expect(
      (await w.conductor.wait({ runId: r.runId, worker: d.worker, timeoutMs: 1000 }))._unsafeUnwrap(),
    ).toEqual({ state: "exited", exitCode: 1 });
    expect(
      (await w.conductor.wait({ runId: r.runId, worker: "ghost", timeoutMs: 1 }))._unsafeUnwrapErr().code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await w.conductor.report({ runId: r.runId, worker: "ghost", status: "done", summary: "x" })
      )._unsafeUnwrapErr().code,
    ).toBe("NOT_FOUND");
  });
});
