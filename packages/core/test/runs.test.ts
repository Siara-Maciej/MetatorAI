import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import {
  AdvanceRun,
  ApproveRun,
  GetRunStatus,
  InitRun,
  ListRuns,
  ResumeRun,
  WriteRunArtifact,
} from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";

const FEATURE = `
kind: Workflow
schemaVersion: 1
id: feature
stages:
  - id: plan
  - id: plan-gate
    onFail: { goto: plan, loop: plan }
  - id: approval
    hitl: true
  - id: build
loops:
  plan: 1
`;

function world(files: Record<string, string> = { ".github/metator/workflows/feature.yml": FEATURE }) {
  const fs = new InMemoryFileSystem(files);
  const clock = new FixedClock(new Date("2026-10-25T09:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  return {
    fs,
    clock,
    catalog,
    repo,
    init: new InitRun(catalog, repo, clock),
    advance: new AdvanceRun(catalog, repo, clock),
    approve: new ApproveRun(new AdvanceRun(catalog, repo, clock), repo, clock),
    status: new GetRunStatus(catalog, repo),
    list: new ListRuns(repo),
  };
}

describe("WorkflowCatalog", () => {
  test("lists valid workflows and reports broken files without hiding the good ones", async () => {
    const { catalog } = world({
      ".github/metator/workflows/feature.yml": FEATURE,
      ".github/metator/workflows/broken.yml": "kind: Workflow\nschemaVersion: 1\nid: broken\nstages: []",
      ".github/metator/workflows/notes.md": "ignored",
    });
    const scan = await catalog.scan();
    expect(scan.workflows.map((w) => w.spec.id)).toEqual(["feature"]);
    expect(scan.problems.map((p) => p.source)).toEqual([".github/metator/workflows/broken.yml"]);
  });

  test("duplicate workflow ids are a problem; the first definition wins", async () => {
    const { catalog } = world({
      ".github/metator/workflows/a.yml": FEATURE,
      ".github/metator/workflows/b.yml": FEATURE,
    });
    const scan = await catalog.scan();
    expect(scan.workflows.map((w) => w.source)).toEqual([".github/metator/workflows/a.yml"]);
    expect(scan.problems[0]?.error.message).toContain("already defined");
  });

  test("unknown workflow lists the known ones in the hint", async () => {
    const error = (await world().catalog.get("nope"))._unsafeUnwrapErr();
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("feature");
  });
});

describe("run lifecycle", () => {
  test("init creates state.json, log.md and the latest pointer", async () => {
    const w = world();
    const run = (
      await w.init.execute({ workflow: "feature", task: "Dodaj rabat łączony do faktur" })
    )._unsafeUnwrap();
    expect(run.runId).toBe("20261025-feature-dodaj-rabat-laczony-do-faktur");
    expect(run).toMatchObject({
      stage: "plan",
      status: "active",
      autonomy: "L0",
      expects: ["PASS", "FAIL", "ABORT"],
    });
    const state = JSON.parse((await w.fs.read(run.files.state))._unsafeUnwrap());
    expect(state).toMatchObject({
      kind: "RunRecord",
      schemaVersion: 4,
      workflow: { id: "feature", revision: 1 },
      approvals: {},
      createdAt: "2026-10-25T09:00:00.000Z",
    });
    expect(JSON.parse((await w.fs.read(".metator/runs/latest.json"))._unsafeUnwrap())).toEqual({
      kind: "RunPointer",
      schemaVersion: 1,
      runId: run.runId,
    });
    expect((await w.fs.read(run.files.log))._unsafeUnwrap()).toContain("created · workflow feature@1 · L0");
  });

  test("same task on the same day gets a unique id", async () => {
    const w = world();
    const a = (await w.init.execute({ workflow: "feature", task: "Fix login" }))._unsafeUnwrap();
    const b = (await w.init.execute({ workflow: "feature", task: "Fix login" }))._unsafeUnwrap();
    expect([a.runId, b.runId]).toEqual(["20261025-feature-fix-login", "20261025-feature-fix-login-2"]);
  });

  test("advance persists every step; a fresh repository resumes from disk", async () => {
    const w = world();
    const { runId } = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    await w.advance.execute({ event: { type: "PASS" } });
    w.clock.advance(60_000);
    const failed = (
      await w.advance.execute({ runId, event: { type: "FAIL", reason: "plan lint: missing exemplar" } })
    )._unsafeUnwrap();
    expect(failed).toMatchObject({
      stage: "plan",
      loops: { plan: 1 },
      updatedAt: "2026-10-25T09:01:00.000Z",
    });

    const resumed = new GetRunStatus(
      new WorkflowCatalog(w.fs, DEFAULT_PATHS),
      new RunRepository(w.fs, DEFAULT_PATHS),
    );
    expect((await resumed.execute({}))._unsafeUnwrap()).toMatchObject({
      runId,
      stage: "plan",
      loops: { plan: 1 },
    });

    const log = (await w.fs.read(failed.files.log))._unsafeUnwrap();
    expect(log).toContain("plan · PASS → plan-gate");
    expect(log).toContain("plan-gate · FAIL · plan lint: missing exemplar → plan");
  });

  test("human gate: PASS is denied and state is unchanged; APPROVE records who decided", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    await w.advance.execute({ event: { type: "PASS" } });
    await w.advance.execute({ event: { type: "PASS" } });
    const denied = (await w.advance.execute({ event: { type: "PASS" } }))._unsafeUnwrapErr();
    expect(denied.code).toBe("TRANSITION_DENIED");
    expect((await w.status.execute({ runId: run.runId }))._unsafeUnwrap().stage).toBe("approval");

    const approved = (
      await w.advance.execute({ event: { type: "APPROVE", by: "maciej", choice: "1" } })
    )._unsafeUnwrap();
    expect(approved.stage).toBe("build");
    expect(approved.recent.at(-1)).toEqual({ stage: "approval", event: "APPROVE", detail: "maciej" });
  });

  test("corrupted state.json is reported, not trusted", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    await w.fs.write(
      run.files.state,
      JSON.stringify({ kind: "RunRecord", schemaVersion: 1, runId: run.runId, state: { stage: "build" } }),
    );
    const error = (await w.status.execute({}))._unsafeUnwrapErr();
    expect(error.code).toBe("INVALID_ARTIFACT");
    expect(error.hint).toContain("Do not edit state.json");
  });

  test("state.json without a version header is rejected with the expected header", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    const saved = JSON.parse((await w.fs.read(run.files.state))._unsafeUnwrap());
    const { kind: _kind, schemaVersion: _version, ...headerless } = saved;
    await w.fs.write(run.files.state, JSON.stringify(headerless));
    const error = (await w.status.execute({}))._unsafeUnwrapErr();
    expect(error.code).toBe("INVALID_ARTIFACT");
    expect(error.hint).toBe('Expected "kind: RunRecord" and "schemaVersion: 4" at the top of the document.');
  });

  test("state.json from a newer MetatorAI is refused, not misread", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    const saved = JSON.parse((await w.fs.read(run.files.state))._unsafeUnwrap());
    await w.fs.write(run.files.state, JSON.stringify({ ...saved, schemaVersion: 99 }));
    const error = (await w.status.execute({}))._unsafeUnwrapErr();
    expect(error.message).toContain("schemaVersion 99 is newer than supported (4)");
    expect(error.hint).toContain("Upgrade metator-ai");
  });

  test("log.md starts with a versioned front matter and is checked before appending", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    const log = (await w.fs.read(run.files.log))._unsafeUnwrap();
    expect(log.startsWith(`---\nkind: RunLog\nschemaVersion: 1\nrunId: ${run.runId}\n---\n`)).toBe(true);
    await w.fs.write(run.files.log, log.replace("schemaVersion: 1", "schemaVersion: 7"));
    const error = (await w.advance.execute({ event: { type: "PASS" } }))._unsafeUnwrapErr();
    expect(error.message).toContain("newer than supported");
    expect(JSON.parse((await w.fs.read(run.files.state))._unsafeUnwrap()).state.stage).toBe("plan");
  });

  test("status without any run says how to start one", async () => {
    const error = (await world().status.execute({}))._unsafeUnwrapErr();
    expect([error.code, error.hint]).toEqual(["NOT_FOUND", "Start one with `metator run init`."]);
  });

  test("unknown run id is NOT_FOUND with a hint", async () => {
    const error = (
      await world().advance.execute({ runId: "20990101-x-y", event: { type: "PASS" } })
    )._unsafeUnwrapErr();
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("metator run list");
  });

  test("list returns runs newest first", async () => {
    const w = world();
    await w.init.execute({ workflow: "feature", task: "first" });
    w.clock.advance(1000);
    await w.init.execute({ workflow: "feature", task: "second" });
    const rows = (await w.list.execute())._unsafeUnwrap();
    expect(rows.map((r) => r.runId)).toEqual(["20261025-feature-second", "20261025-feature-first"]);
  });

  test("task text that slugifies to nothing still gets a valid id", async () => {
    const run = (await world().init.execute({ workflow: "feature", task: "!!!" }))._unsafeUnwrap();
    expect(run.runId).toBe("20261025-feature-run");
  });
});

describe("run approvals (RunRecord v2)", () => {
  test("approving the HITL stage advances the run and records who chose what", async () => {
    const w = world();
    await w.init.execute({ workflow: "feature", task: "t" });
    await w.advance.execute({ event: { type: "PASS" } });
    await w.advance.execute({ event: { type: "PASS" } });
    const run = (await w.approve.execute({ gate: "approval", by: "maciej", choice: "1" }))._unsafeUnwrap();
    expect(run).toMatchObject({
      stage: "build",
      approvals: { approval: { by: "maciej", choice: "1", at: "2026-10-25T09:00:00.000Z" } },
    });
  });

  test("an external action is recorded without moving the run; other gates are refused", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    w.clock.advance(1000);
    expect((await w.approve.execute({ gate: "push", by: "maciej" }))._unsafeUnwrap()).toEqual({
      runId: run.runId,
      approvals: { push: { by: "maciej", at: "2026-10-25T09:00:01.000Z" } },
    });
    const status = (await w.status.execute({}))._unsafeUnwrap();
    expect([status.stage, status.approvals.push?.by]).toEqual(["plan", "maciej"]);
    expect((await w.fs.read(run.files.log))._unsafeUnwrap()).toContain("approved push · by maciej");

    const wrong = (await w.approve.execute({ gate: "approval", by: "maciej" }))._unsafeUnwrapErr();
    expect([wrong.code, wrong.message]).toEqual([
      "USAGE",
      '"approval" is neither the current stage (plan) nor an action (push, comment)',
    ]);
    // The state machine still decides at a stage: PASS-only stages refuse an approval.
    expect((await w.approve.execute({ gate: "plan", by: "maciej" }))._unsafeUnwrapErr().code).toBe(
      "TRANSITION_DENIED",
    );
  });

  test("a finished run approves nothing; an unknown run is NOT_FOUND", async () => {
    const w = world();
    await w.init.execute({ workflow: "feature", task: "t" });
    await w.advance.execute({ event: { type: "ABORT", reason: "stop" } });
    expect((await w.approve.execute({ gate: "push", by: "m" }))._unsafeUnwrapErr().message).toContain(
      "is aborted",
    );
    expect(
      (await w.approve.execute({ runId: "20990101-x-y", gate: "push", by: "m" }))._unsafeUnwrapErr().code,
    ).toBe("NOT_FOUND");
  });

  test("a v1 state.json migrates: earlier stage approvals come from the history", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    const saved = JSON.parse((await w.fs.read(run.files.state))._unsafeUnwrap());
    const { approvals: _a, ...v1 } = saved;
    v1.schemaVersion = 1;
    v1.state.context.history = [
      { stage: "plan-gate", event: "FAIL", detail: "no exemplar" },
      { stage: "approval", event: "APPROVE", detail: "maciej" },
    ];
    await w.fs.write(run.files.state, JSON.stringify(v1));
    const status = (await w.status.execute({}))._unsafeUnwrap();
    expect(status.approvals).toEqual({ approval: { by: "maciej", at: "2026-10-25T09:00:00.000Z" } });
  });
});

const GATED = `
kind: Workflow
schemaVersion: 2
id: gated
autonomy: [L0, L1]
stages:
  - id: approval
    hitl: true
    skipAt: [L1]
  - id: plan
  - id: plan-approval
    hitl: true
    skipAt: [L1]
  - id: build
  - id: delivery
    hitl: true
    neverSkip: true
`;

describe("autonomy: skipped gates and autopilot", () => {
  const gated = (spec = GATED) => world({ ".github/metator/workflows/gated.yml": spec });

  test("at L1 every gate with skipAt L1 is approved by the autonomy level and logged", async () => {
    const w = gated();
    const run = (await w.init.execute({ workflow: "gated", task: "t", autonomy: "L1" }))._unsafeUnwrap();
    expect([run.stage, run.approvals.approval?.by]).toEqual(["plan", "autonomy L1"]);
    const next = (await w.advance.execute({ event: { type: "PASS" } }))._unsafeUnwrap();
    expect(next.stage).toBe("build");
    const after = (await w.advance.execute({ event: { type: "PASS" } }))._unsafeUnwrap();
    // A gate marked neverSkip always waits for a human.
    expect([after.stage, after.expects]).toEqual(["delivery", ["APPROVE", "FAIL", "ABORT"]]);
    const log = (await w.repo.readLog(run.runId))._unsafeUnwrap();
    expect(log.filter((l) => l.includes("skipped at L1"))).toEqual([
      "2026-10-25T09:00:00.000Z · approval · skipped at L1 → plan",
      "2026-10-25T09:00:00.000Z · plan-approval · skipped at L1 → build",
    ]);
  });

  test("at L0 nothing is skipped; choosing autopilot at a gate switches the run to L1", async () => {
    const w = gated();
    const run = (await w.init.execute({ workflow: "gated", task: "t" }))._unsafeUnwrap();
    expect(run.stage).toBe("approval");
    const approved = (
      await w.advance.execute({ event: { type: "APPROVE", by: "maciej", choice: "autopilot" } })
    )._unsafeUnwrap();
    expect([approved.autonomy, approved.stage]).toEqual(["L1", "plan"]);
    expect((await w.advance.execute({ event: { type: "PASS" } }))._unsafeUnwrap().stage).toBe("build");
    const log = (await w.repo.readLog(run.runId))._unsafeUnwrap();
    expect(log).toContain("2026-10-25T09:00:00.000Z · autopilot · autonomy L1");
  });

  test("autopilot is refused when the workflow does not support L1; other choices change nothing", async () => {
    const w = gated(GATED.replace("autonomy: [L0, L1]", "autonomy: [L0]"));
    await w.init.execute({ workflow: "gated", task: "t" });
    const e = (
      await w.advance.execute({ event: { type: "APPROVE", by: "m", choice: "autopilot" } })
    )._unsafeUnwrapErr();
    expect([e.code, e.message]).toEqual(["USAGE", "workflow gated does not support autopilot (L1)"]);
    const plain = (
      await w.advance.execute({ event: { type: "APPROVE", by: "m", choice: "1" } })
    )._unsafeUnwrap();
    expect([plain.autonomy, plain.stage]).toEqual(["L0", "plan"]);
  });

  test("a workflow without an autonomy list accepts autopilot", async () => {
    const w = gated(GATED.replace("autonomy: [L0, L1]\n", ""));
    await w.init.execute({ workflow: "gated", task: "t" });
    const r = await w.advance.execute({ event: { type: "APPROVE", by: "m", choice: "autopilot" } });
    expect(r._unsafeUnwrap().autonomy).toBe("L1");
  });

  test("an L2 run does not use gates skipped only at L1", async () => {
    const w = gated();
    const run = (await w.init.execute({ workflow: "gated", task: "t", autonomy: "L2" }))._unsafeUnwrap();
    expect([run.stage, run.autonomy]).toEqual(["approval", "L2"]);
    const approved = (
      await w.advance.execute({ event: { type: "APPROVE", by: "m", choice: "autopilot" } })
    )._unsafeUnwrap();
    expect(approved.autonomy).toBe("L2"); // autopilot only raises L0
  });
});

describe("the current run and its artifacts", () => {
  test("in a run's worktree, no run named means that run, not the latest; latest still means latest", async () => {
    const w = world();
    const first = (await w.init.execute({ workflow: "feature", task: "first" }))._unsafeUnwrap().runId;
    const second = (await w.init.execute({ workflow: "feature", task: "second" }))._unsafeUnwrap().runId;
    const mine = new RunRepository(w.fs, DEFAULT_PATHS, first);
    expect((await mine.resolveId(undefined))._unsafeUnwrap()).toBe(first);
    expect((await mine.resolveId("latest"))._unsafeUnwrap()).toBe(second);
    // A current run that does not exist (a worktree of something else) falls back to the latest.
    expect((await new RunRepository(w.fs, DEFAULT_PATHS, "gone").resolveId(undefined))._unsafeUnwrap()).toBe(
      second,
    );
  });

  test("run write: only what the current stage produces, never empty", async () => {
    const w = world({
      ".github/metator/workflows/feature.yml":
        "kind: Workflow\nschemaVersion: 2\nid: feature\nstages:\n  - id: plan\n    owner: mt-planner\n    produces: [plan.json]\n  - id: build\n    owner: mt-implementer\n",
    });
    const id = (await w.init.execute({ workflow: "feature", task: "write" }))._unsafeUnwrap().runId;
    const write = new WriteRunArtifact(w.catalog, w.repo, w.fs);
    const done = (await write.execute({ artifact: "plan.json", content: '{"steps":[]}' }))._unsafeUnwrap();
    expect(done).toEqual({ runId: id, file: `.metator/runs/${id}/plan.json`, bytes: 12 });
    expect((await w.fs.read(done.file))._unsafeUnwrap()).toBe('{"steps":[]}\n');
    const other = (await write.execute({ artifact: "../../x.md", content: "x" }))._unsafeUnwrapErr();
    expect([other.code, other.message, other.hint]).toEqual([
      "USAGE",
      "stage plan does not produce ../../x.md",
      "It produces: plan.json.",
    ]);
    expect((await write.execute({ artifact: "plan.json", content: "  \n" }))._unsafeUnwrapErr().message).toBe(
      "plan.json is empty",
    );
    await w.advance.execute({ event: { type: "PASS" } });
    expect((await write.execute({ artifact: "plan.json", content: "x" }))._unsafeUnwrapErr().hint).toBe(
      "This stage produces no artifact; its workers write theirs.",
    );
  });
});

describe("resuming an escalated run", () => {
  test("it goes on at the stage it escalated from; history and loops stay; the log says who", async () => {
    const w = world();
    const runId = (await w.init.execute({ workflow: "feature", task: "resume me" }))._unsafeUnwrap().runId;
    const resume = new ResumeRun(w.catalog, w.repo, w.clock);
    expect((await resume.execute({ by: "ala" }))._unsafeUnwrapErr().message).toBe(
      "the run is active; only an escalated run resumes",
    );
    await w.advance.execute({ event: { type: "PASS" } }); // plan → plan-gate
    await w.advance.execute({ event: { type: "FAIL", reason: "x" } }); // loop back to plan (1 of 1)
    await w.advance.execute({ event: { type: "PASS" } });
    const escalated = (await w.advance.execute({ event: { type: "FAIL", reason: "again" } }))._unsafeUnwrap();
    expect(escalated.status).toBe("escalated");
    const back = (await resume.execute({ by: "ala" }))._unsafeUnwrap();
    expect([back.stage, back.status, back.loops]).toEqual(["plan-gate", "active", { plan: 1 }]);
    const log = (await w.fs.read(`.metator/runs/${runId}/log.md`))._unsafeUnwrap();
    expect(log).toContain("resumed at plan-gate · by ala");
    // The loop is spent: the next failure escalates again.
    expect(
      (await w.advance.execute({ event: { type: "FAIL", reason: "still" } }))._unsafeUnwrap().status,
    ).toBe("escalated");
  });
});
