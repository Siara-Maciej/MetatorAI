import { describe, expect, test } from "bun:test";
import {
  FakeAgentHost,
  type FakeAgentTurn,
  FakeBackgroundProcess,
  FixedClock,
  InMemoryFileSystem,
  InstantTimer,
  ScriptedProcessRunner,
} from "@metator/testing";
import { DriveRun, OTHER, RunJournal } from "../src/application/drive.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { CloseRun } from "../src/application/run-close.ts";
import { RunDrivers } from "../src/application/run-drivers.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, ApproveRun, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import {
  gatePrompt,
  nextQuestionId,
  parseCriticVerdict,
  parseStatus,
  type Question,
  stagePrompt,
  stageWork,
} from "../src/domain/drive.ts";
import type { StageSpec } from "../src/domain/workflow-spec.ts";

describe("drive domain", () => {
  test("a stage's work: agents in order, skills offered, scripts, parallel workers", () => {
    const stage = {
      id: "build",
      owner: [
        "mt-test-author",
        "mt-implementer",
        "skill:mt-create-from-pattern",
        "script:metator index build",
      ],
      parallel: ["mt-scout", "skill:mt-grill"],
    } as StageSpec;
    expect(stageWork(stage)).toEqual({
      agents: ["mt-test-author", "mt-implementer"],
      skills: ["mt-create-from-pattern", "mt-grill"],
      scripts: ["metator index build"],
      parallel: ["mt-scout"],
    });
    expect(stageWork({ id: "x" } as StageSpec)).toEqual({
      agents: [],
      skills: [],
      scripts: [],
      parallel: [],
    });
  });

  test("the last STATUS line decides; blocked carries the question", () => {
    expect(parseStatus("working\nSTATUS: done")).toEqual({ kind: "done" });
    expect(parseStatus("STATUS: done\nSTATUS: blocked: which currency?")).toEqual({
      kind: "blocked",
      question: "which currency?",
    });
    expect(parseStatus("no marker at all")).toBeUndefined();
  });

  test("a critic passes only with VERDICT: PASS; anything else is a FAIL with a reason", () => {
    expect(parseCriticVerdict("ok\nVERDICT: PASS")).toEqual({ pass: true });
    expect(parseCriticVerdict("VERDICT: FAIL: step 3 has no test")).toEqual({
      pass: false,
      reason: "step 3 has no test",
    });
    expect(parseCriticVerdict("looks good to me")).toEqual({
      pass: false,
      reason: "the critic gave no VERDICT line",
    });
  });

  test("prompts name the stage, the artifacts, the run directory and how to report", () => {
    const stage = { id: "plan", description: "Steps", produces: ["plan.json"] } as StageSpec;
    const p = stagePrompt({
      runId: "r",
      task: "Add discount",
      stage,
      agent: "mt-planner",
      skills: ["mt-grill"],
      runDir: "/repo/.metator/runs/r",
      answer: "EUR",
      retry: "step 2 has no exemplar",
    });
    for (const part of [
      'stage "plan"',
      "Task: Add discount",
      "Write these artifacts into /repo/.metator/runs/r: plan.json.",
      "Skills you may use: mt-grill.",
      "failed its gate: step 2 has no exemplar",
      "A person answered your question: EUR",
      "STATUS: blocked: <the question>",
    ])
      expect(p).toContain(part);
    expect(gatePrompt({ runId: "r", task: "t", stage, agent: "mt-plan-critic", runDir: "/d" })).toContain(
      "VERDICT: FAIL: <the reason>",
    );
    // Workers of one stage in parallel: each writes only its own artifact.
    const parallel = { id: "context", produces: ["a.json", "b.json"], parallel: ["x", "y"] } as StageSpec;
    const mine = stagePrompt({
      runId: "r",
      task: "t",
      stage: parallel,
      agent: "x",
      skills: [],
      runDir: "/d",
    });
    expect(mine).toContain("Write only the artifact your own instructions name");
    expect(mine).not.toContain("Write these artifacts into");
    expect(p).toContain("Write an artifact with your Write tool at /repo/.metator/runs/r/<artifact>");
  });

  test("question ids count up per run", () => {
    expect([nextQuestionId([]), nextQuestionId(["q001", "q009"])]).toEqual(["q001", "q010"]);
  });
});

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: setup
    owner: "script:metator index build"
  - id: plan
    owner: mt-planner
    produces: [plan.md]
  - id: approval
    hitl: true
  - id: build
    owner: [mt-implementer, skill:mt-create-from-pattern]
    parallel: [mt-scout]
  - id: check
    gate: { script: "test -f {runDir}/plan.md", llm: mt-plan-critic }
    onFail: { goto: plan, loop: plan }
loops:
  plan: 1
`;

type Person = (q: Question) => { choices: string[]; text?: string } | undefined;

function world(
  turns: Record<string, FakeAgentTurn[]>,
  person: Person,
  scripts = new ScriptedProcessRunner(),
) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-10-27T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const advance = new AdvanceRun(catalog, repo, clock);
  const host = new FakeAgentHost(turns);
  let runId = "";
  const asked: Question[] = [];
  // The "person": answers each open question while the drive waits.
  const timer = new InstantTimer(async () => {
    for (const q of (await journal.questions(runId))._unsafeUnwrap()) {
      if (q.answer || asked.some((a) => a.id === q.id)) continue;
      asked.push(q);
      const a = person(q);
      if (a) await journal.answer(runId, q.id, { ...a, by: "maciej" });
    }
  });
  const drive = new DriveRun({
    catalog,
    repo,
    journal,
    advance,
    approve: new ApproveRun(advance, repo, clock),
    close: new CloseRun(advance, repo, fs, clock),
    hosts: new Map([["fake", host]]),
    process: scripts,
    fs,
    timer,
    root: "/repo",
    metatorCommand: "bun run metator",
  });
  const start = async () => {
    const view = (
      await new InitRun(catalog, repo, clock).execute({ workflow: "demo", task: "Add discount" })
    )._unsafeUnwrap();
    runId = view.runId;
    return view.runId;
  };
  return { fs, repo, journal, host, drive, start, asked, scripts };
}

const okScripts = () =>
  new ScriptedProcessRunner([
    { argvPrefix: ["bun", "run", "metator", "index", "build"], result: { exitCode: 0 } },
    { argvPrefix: ["test", "-f"], result: { exitCode: 0 } },
  ]);
const writesPlan: FakeAgentTurn = {
  effect: async () => {
    await w0?.fs.write(".metator/runs/20261027-demo-add-discount/plan.md", "# Plan\n");
  },
};
let w0: ReturnType<typeof world> | undefined;

describe("DriveRun", () => {
  test("a whole run: script, agent, human gate, agent with a question, gate script and critic", async () => {
    const w = world(
      {
        "mt-planner": [writesPlan],
        "mt-implementer": [
          { ask: { source: "agent", prompt: "Half up?", options: [{ label: "yes" }], multiSelect: false } },
        ],
        "mt-plan-critic": [{ text: "VERDICT: PASS" }],
      },
      (q) => (q.source === "gate" ? { choices: ["Approve"] } : { choices: ["yes"] }),
      okScripts(),
    );
    w0 = w;
    const runId = await w.start();
    const report = (await w.drive.execute({ runId, host: "fake" }))._unsafeUnwrap();
    expect([report.status, report.stage]).toEqual(["done", "done"]);
    expect(w.host.tasks.map((t) => t.agent)).toEqual([
      "mt-planner",
      "mt-implementer",
      "mt-scout",
      "mt-plan-critic",
    ]);
    expect(w.host.tasks[0]).toMatchObject({
      cwd: "/repo",
      projectRoot: "/repo",
      runDir: `/repo/.metator/runs/${runId}`,
    });
    expect(w.host.tasks[1]?.prompt).toContain("Skills you may use: mt-create-from-pattern.");
    // Scripts run through hosts.metatorCommand, with {runDir} filled (repository-relative, so it is
    // the same path in a run's worktree) and the run in the environment.
    expect(w.scripts.calls.map((c) => c.argv)).toEqual([
      ["bun", "run", "metator", "index", "build"],
      ["test", "-f", `.metator/runs/${runId}/plan.md`],
    ]);
    expect(w.scripts.calls[0]?.env).toEqual({
      METATOR_RUN: runId,
      METATOR_RUN_DIR: `/repo/.metator/runs/${runId}`,
    });
    expect(w.asked.map((q) => [q.id, q.source, q.options.map((o) => o.label)])).toEqual([
      ["q001", "gate", ["Approve", "Reject", OTHER]],
      ["q002", "agent", ["yes", OTHER]],
    ]);
    const record = (await w.repo.load(runId))._unsafeUnwrap();
    expect([record.approvals.approval?.by, record.host, record.hostSession]).toEqual([
      "maciej",
      "fake",
      "mt-plan-critic-1",
    ]);
    expect(await w.fs.exists(`.metator/runs/${runId}/summary.json`)).toBe(true);
    const types = (await w.journal.activity(runId))._unsafeUnwrap().map((a) => a.type);
    expect([types[0], types.at(-1), types.filter((t) => t === "advance").length]).toEqual([
      "drive",
      "drive",
      5,
    ]);
  });

  test("a failing critic sends the run back with its reason, then the loop limit escalates", async () => {
    const w = world(
      { "mt-planner": [writesPlan], "mt-plan-critic": [{ text: "VERDICT: FAIL: no tests" }] },
      () => ({ choices: ["Approve"] }),
      okScripts(),
    );
    w0 = w;
    const runId = await w.start();
    const report = (await w.drive.execute({ runId, host: "fake" }))._unsafeUnwrap();
    expect(report.status).toBe("escalated");
    const failures = (await w.journal.activity(runId))
      ._unsafeUnwrap()
      .filter((a) => a.type === "advance" && a.text.startsWith("FAIL"))
      .map((a) => [a.stage, a.text]);
    expect(failures).toEqual([
      ["check", "FAIL: mt-plan-critic: no tests"],
      ["check", "FAIL: mt-plan-critic: no tests"],
    ]);
    // The second plan attempt is told why the gate failed.
    const plans = w.host.tasks.filter((t) => t.agent === "mt-planner");
    expect([
      plans.length,
      plans.at(-1)?.prompt.includes("failed its gate: mt-plan-critic: no tests"),
    ]).toEqual([2, true]);
  });

  test("a rejected gate is a FAIL with the person's reason", async () => {
    const w = world(
      { "mt-planner": [writesPlan] },
      () => ({ choices: ["Reject"], text: "split step 2" }),
      okScripts(),
    );
    w0 = w;
    const runId = await w.start();
    expect((await w.drive.execute({ runId, host: "fake" }))._unsafeUnwrap().status).toBe("escalated");
    const history = (await w.repo.load(runId))._unsafeUnwrap().state.context.history;
    expect(history.at(-1)).toEqual({ stage: "approval", event: "FAIL", detail: "split step 2" });
  });

  test("a blocked agent asks a person and resumes its session with the answer", async () => {
    const w = world(
      {
        "mt-planner": [writesPlan],
        "mt-implementer": [{ text: "STATUS: blocked: which currency?" }, { text: "STATUS: done" }],
        "mt-plan-critic": [{ text: "VERDICT: PASS" }],
      },
      (q) => (q.source === "gate" ? { choices: ["Approve"] } : { choices: [OTHER], text: "EUR" }),
      okScripts(),
    );
    w0 = w;
    const runId = await w.start();
    expect((await w.drive.execute({ runId, host: "fake" }))._unsafeUnwrap().status).toBe("done");
    const impl = w.host.tasks.filter((t) => t.agent === "mt-implementer");
    expect([
      impl.length,
      impl[1]?.resume,
      impl[1]?.prompt.includes("A person answered your question: EUR"),
    ]).toEqual([2, "mt-implementer-1", true]);
    expect(w.asked.find((q) => q.source === "agent")?.prompt).toBe("which currency?");
  });

  test("the third answer still reaches the agent; a fourth question fails the stage", async () => {
    const blocked = (n: number) => ({ text: `STATUS: blocked: question ${n}?` });
    const answers = (q: { source: string }) =>
      q.source === "gate" ? { choices: ["Approve"] } : { choices: [OTHER], text: "go on" };
    const w = world(
      {
        "mt-planner": [writesPlan],
        "mt-implementer": [blocked(1), blocked(2), blocked(3), { text: "STATUS: done" }],
        "mt-plan-critic": [{ text: "VERDICT: PASS" }],
      },
      answers,
      okScripts(),
    );
    w0 = w;
    const runId = await w.start();
    expect((await w.drive.execute({ runId, host: "fake" }))._unsafeUnwrap().status).toBe("done");
    expect(w.host.tasks.filter((t) => t.agent === "mt-implementer")).toHaveLength(4);

    const stuck = world(
      {
        "mt-planner": [writesPlan],
        "mt-implementer": [blocked(1), blocked(2), blocked(3), blocked(4)],
        "mt-plan-critic": [{ text: "VERDICT: PASS" }],
      },
      answers,
      okScripts(),
    );
    w0 = stuck;
    const id = await stuck.start();
    expect((await stuck.drive.execute({ runId: id, host: "fake" }))._unsafeUnwrap().status).toBe("escalated");
    const fail = (await stuck.journal.activity(id))
      ._unsafeUnwrap()
      .find((a) => a.type === "advance" && a.text.startsWith("FAIL"));
    expect(fail?.text).toBe("FAIL: mt-implementer stayed blocked after 3 answers");
    expect(stuck.asked.filter((q) => q.source === "agent")).toHaveLength(3);
  });

  test("a failing script and a failing agent are FAILs with their output, not exceptions", async () => {
    const failing = new ScriptedProcessRunner([
      { argvPrefix: ["bun"], result: { exitCode: 2, stderr: "index: parse error in a.ts" } },
    ]);
    const w = world({}, () => undefined, failing);
    const runId = await w.start();
    const r = (await w.drive.execute({ runId, host: "fake", maxSteps: 1 }))._unsafeUnwrap();
    const fail = (await w.journal.activity(runId))._unsafeUnwrap().find((a) => a.type === "advance");
    expect([r.status, fail?.text]).toEqual([
      "escalated",
      "FAIL: `metator index build` failed: index: parse error in a.ts",
    ]);

    const w2 = world(
      { "mt-planner": [{ ok: false, text: "model overloaded" }] },
      () => undefined,
      okScripts(),
    );
    const id2 = await w2.start();
    await w2.drive.execute({ runId: id2, host: "fake", maxSteps: 2 });
    const f2 = (await w2.journal.activity(id2))
      ._unsafeUnwrap()
      .filter((a) => a.type === "advance")
      .at(-1);
    expect(f2?.text).toBe("FAIL: mt-planner failed: model overloaded");

    // A worker that reports done without writing its artifact fails the stage.
    const w3 = world({ "mt-planner": [{ text: "STATUS: done" }] }, () => undefined, okScripts());
    const id3 = await w3.start();
    await w3.drive.execute({ runId: id3, host: "fake", maxSteps: 2 });
    const f3 = (await w3.journal.activity(id3))
      ._unsafeUnwrap()
      .filter((a) => a.type === "advance")
      .at(-1);
    expect(f3?.text).toBe("FAIL: missing artifacts: plan.md");
  });

  test("unknown host and max steps", async () => {
    const w = world({}, () => undefined, okScripts());
    const runId = await w.start();
    expect((await w.drive.execute({ runId, host: "nope" }))._unsafeUnwrapErr().code).toBe("USAGE");
    const r = (await w.drive.execute({ runId, host: "fake", maxSteps: 1 }))._unsafeUnwrap();
    expect([r.status, r.stage, r.steps]).toEqual(["active", "plan", 1]);
  });
});

describe("RunJournal answers", () => {
  test("choices must be listed options; Other needs text; one choice unless multi-select", async () => {
    const fs = new InMemoryFileSystem();
    const repo = new RunRepository(fs, DEFAULT_PATHS);
    const j = new RunJournal(fs, repo, new FixedClock());
    const q = (
      await j.ask("r1", {
        stage: "s",
        source: "agent",
        prompt: "Which?",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      })
    )._unsafeUnwrap();
    const answer = (choices: string[], text?: string) =>
      j.answer("r1", q.id, { choices, by: "m", ...(text ? { text } : {}) });
    expect((await answer(["C"]))._unsafeUnwrapErr().message).toBe("choose from: A, B, Other");
    expect((await answer(["A", "B"]))._unsafeUnwrapErr().message).toBe("this question takes one choice");
    expect((await answer([OTHER]))._unsafeUnwrapErr().message).toBe("Other needs --text");
    expect((await answer([], "C please"))._unsafeUnwrap().answer?.choices).toEqual([OTHER]);
    expect((await answer(["A"]))._unsafeUnwrapErr().message).toBe("question q001 is already answered");
    expect((await j.answer("r1", "q099", { choices: ["A"], by: "m" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });

  test("an answer given after the run last changed still stands; an older one was acted on", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-10-27T10:00:00.000Z"));
    const j = new RunJournal(fs, new RunRepository(fs, DEFAULT_PATHS), clock);
    const q = {
      stage: "approval",
      source: "gate" as const,
      prompt: "Approve?",
      options: [{ label: "Approve" }],
      multiSelect: false,
    };
    const first = (await j.ask("r1", q))._unsafeUnwrap();
    clock.advance(1000);
    await j.answer("r1", first.id, { choices: ["Approve"], by: "m" }); // answered at 10:00:01
    expect((await j.ask("r1", q, "2026-10-27T10:00:00.500Z"))._unsafeUnwrap().id).toBe(first.id);
    expect((await j.ask("r1", q, "2026-10-27T10:00:02.000Z"))._unsafeUnwrap().id).toBe("q002");
  });

  test("asking the same open question again (a restarted drive) returns the one already asked", async () => {
    const fs = new InMemoryFileSystem();
    const j = new RunJournal(fs, new RunRepository(fs, DEFAULT_PATHS), new FixedClock());
    const ask = () =>
      j.ask("r1", {
        stage: "s",
        source: "gate",
        prompt: "Approve?",
        options: [{ label: "Approve" }],
        multiSelect: false,
      });
    const first = (await ask())._unsafeUnwrap();
    expect((await ask())._unsafeUnwrap().id).toBe(first.id);
    await j.answer("r1", first.id, { choices: ["Approve"], by: "m" });
    expect((await ask())._unsafeUnwrap().id).toBe("q002");
  });
});

describe("RunDrivers", () => {
  const drivers = () => {
    const fs = new InMemoryFileSystem();
    const repo = new RunRepository(fs, DEFAULT_PATHS);
    const clock = new FixedClock();
    const processes = new FakeBackgroundProcess();
    return { processes, d: new RunDrivers(fs, repo, processes, new RunJournal(fs, repo, clock), clock) };
  };

  test("one live driver per run; a dead one does not block; stop ends it", async () => {
    const { d, processes } = drivers();
    const started = (
      await d.start({ runId: "r", host: "claude", argv: ["metator"], cwd: "/", logFile: "/tmp/l" })
    )._unsafeUnwrap();
    expect((await d.claim("r", 9999, "claude"))._unsafeUnwrapErr().message).toContain(
      `process ${started.pid}`,
    );
    expect(
      (await d.start({ runId: "r", host: "claude", argv: [], cwd: "/", logFile: "/tmp/l" })).isErr(),
    ).toBe(true);
    processes.alive.delete(started.pid); // the process died
    expect((await d.status("r"))._unsafeUnwrap()?.alive).toBe(false);
    expect((await d.claim("r", 9999, "claude")).isOk()).toBe(true);
    expect((await d.stop("r"))._unsafeUnwrap()).toEqual({ stopped: null });
    expect((await d.status("r"))._unsafeUnwrap()).toBeNull();
  });

  test("release frees only its own claim", async () => {
    const { d } = drivers();
    await d.claim("r", 1, "copilot");
    await d.release("r", 2);
    expect((await d.status("r"))._unsafeUnwrap()?.pid).toBe(1);
    await d.release("r", 1);
    expect((await d.status("r"))._unsafeUnwrap()).toBeNull();
  });
});
