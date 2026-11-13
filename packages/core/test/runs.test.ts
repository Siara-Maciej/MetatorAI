import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import {
  RunRepository,
  type UnreadableRun,
  unreadableRunWarning,
} from "../src/application/run-repository.ts";
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
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

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
    approve: new ApproveRun(new AdvanceRun(catalog, repo, clock), repo, clock, catalog),
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
      schemaVersion: 7,
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

  test("inputs the workflow declares are kept on the record; an input it does not declare is refused", async () => {
    const w = world({
      ".github/metator/workflows/feature.yml": FEATURE.replace(
        "schemaVersion: 1",
        "schemaVersion: 2",
      ).replace("stages:", "input:\n  oneOf: [pr, base]\nstages:"),
    });
    const run = (
      await w.init.execute({ workflow: "feature", task: "t", inputs: { base: "main" } })
    )._unsafeUnwrap();
    expect((await w.repo.load(run.runId))._unsafeUnwrap().inputs).toEqual({ base: "main" });
    const error = (
      await w.init.execute({ workflow: "feature", task: "t", inputs: { bse: "main" } })
    )._unsafeUnwrapErr();
    expect([error.code, error.message, error.hint]).toEqual([
      "USAGE",
      "workflow feature has no input `bse`",
      "Its inputs: pr, base.",
    ]);
    // Without inputs the record has none.
    const plain = (await w.init.execute({ workflow: "feature", task: "u" }))._unsafeUnwrap();
    expect((await w.repo.load(plain.runId))._unsafeUnwrap().inputs).toBeUndefined();
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
    expect(error.hint).toBe('Expected "kind: RunRecord" and "schemaVersion: 7" at the top of the document.');
  });

  test("state.json from a newer MetatorAI is refused, not misread", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "t" }))._unsafeUnwrap();
    const saved = JSON.parse((await w.fs.read(run.files.state))._unsafeUnwrap());
    await w.fs.write(run.files.state, JSON.stringify({ ...saved, schemaVersion: 99 }));
    const error = (await w.status.execute({}))._unsafeUnwrapErr();
    expect(error.message).toContain("schemaVersion 99 is newer than supported (7)");
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
    const rows = (await w.list.execute())._unsafeUnwrap().runs;
    expect(rows.map((r) => r.runId)).toEqual(["20261025-feature-second", "20261025-feature-first"]);
  });

  test("one unreadable record never hides the other runs: it is left out and named with its file (R2)", async () => {
    const w = world();
    const first = (await w.init.execute({ workflow: "feature", task: "first" }))._unsafeUnwrap();
    w.clock.advance(1000);
    await w.init.execute({ workflow: "feature", task: "second" });
    const text = (await w.fs.read(first.files.state))._unsafeUnwrap();
    await w.fs.write(first.files.state, text.slice(0, 40));
    const listed = (await w.list.execute())._unsafeUnwrap();
    expect(listed.runs.map((r) => r.runId)).toEqual(["20261025-feature-second"]);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]).toMatchObject({ runId: first.runId, file: first.files.state });
    expect(unreadableRunWarning(listed.unreadable[0] as UnreadableRun)).toContain(
      `restore ${first.files.state} (from git or a backup), or delete the run's directory`,
    );
  });

  test("two approvals at the same time are both in the record; the log has both lines (R5)", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "first" }))._unsafeUnwrap();
    const [push, comment] = await Promise.all([
      w.approve.execute({ gate: "push", by: "maciej" }),
      w.approve.execute({ gate: "comment", by: "alice" }),
    ]);
    expect([push.isOk(), comment.isOk()]).toEqual([true, true]);
    const record = (await w.repo.load(run.runId))._unsafeUnwrap();
    expect(Object.keys(record.approvals).sort()).toEqual(["comment", "push"]);
    const log = (await w.fs.read(run.files.log))._unsafeUnwrap();
    expect(log).toContain("approved push · by maciej");
    expect(log).toContain("approved comment · by alice");
    expect(log.match(/^kind: RunLog$/gm)).toHaveLength(1);
  });

  test("the same event sent twice at once advances the run once: the second is told it moved on (R5)", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "first" }))._unsafeUnwrap();
    const both = await Promise.all([
      w.advance.execute({ event: { type: "PASS" } }),
      w.advance.execute({ event: { type: "PASS" } }),
    ]);
    expect(both.map((r) => r.isOk()).sort()).toEqual([false, true]);
    const refused = both.find((r) => r.isErr())?._unsafeUnwrapErr();
    expect(refused?.code).toBe("TRANSITION_DENIED");
    expect(refused?.message).toBe(
      `run ${run.runId} moved on meanwhile: it was at plan, now it is active at plan-gate`,
    );
    expect((await w.repo.load(run.runId))._unsafeUnwrap().state.stage).toBe("plan-gate");
  });

  test("update changes the record as it is now, and an error value from the change writes nothing", async () => {
    const w = world();
    const run = (await w.init.execute({ workflow: "feature", task: "first" }))._unsafeUnwrap();
    const before = (await w.fs.read(run.files.state))._unsafeUnwrap();
    const refused = await w.repo.update(run.runId, () => err(MetatorError.usage("no")));
    expect(refused._unsafeUnwrapErr().message).toBe("no");
    expect((await w.fs.read(run.files.state))._unsafeUnwrap()).toBe(before);
    const bumps = await Promise.all(
      ["a", "b", "c"].map((k) =>
        w.repo.update(run.runId, (r) => ok({ ...r, options: { ...(r.options ?? {}), [k]: true } })),
      ),
    );
    expect(bumps.every((b) => b.isOk())).toBe(true);
    expect((await w.repo.load(run.runId))._unsafeUnwrap().options).toEqual({ a: true, b: true, c: true });
    expect((await w.repo.update("nope", (r) => ok(r)))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
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
    const finished = (await w.approve.execute({ gate: "push", by: "m" }))._unsafeUnwrapErr();
    expect(finished.message).toContain("is aborted");
    // A run that is not active is the same refusal everywhere: TRANSITION_DENIED, not USAGE.
    expect(finished.code).toBe("TRANSITION_DENIED");
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
    const w = gated(GATED.replace("autonomy: [L0, L1]", "autonomy: [L0, L1, L2]"));
    const run = (await w.init.execute({ workflow: "gated", task: "t", autonomy: "L2" }))._unsafeUnwrap();
    expect([run.stage, run.autonomy]).toEqual(["approval", "L2"]);
    const approved = (
      await w.advance.execute({ event: { type: "APPROVE", by: "m", choice: "autopilot" } })
    )._unsafeUnwrap();
    expect(approved.autonomy).toBe("L2"); // autopilot only raises L0
  });

  test("init refuses an autonomy level the workflow does not list and starts no run", async () => {
    const w = gated();
    const e = (await w.init.execute({ workflow: "gated", task: "t", autonomy: "L2" }))._unsafeUnwrapErr();
    expect([e.code, e.message, e.hint]).toEqual([
      "USAGE",
      "workflow gated does not support autonomy L2",
      "Supported autonomy levels: L0, L1.",
    ]);
    expect(await w.repo.list()).toEqual([]);
    // A workflow without an autonomy list takes any level.
    const open = gated(GATED.replace("autonomy: [L0, L1]\n", ""));
    expect(
      (await open.init.execute({ workflow: "gated", task: "t", autonomy: "L2" }))._unsafeUnwrap().autonomy,
    ).toBe("L2");
  });

  test("without a level the run starts at L0 when the workflow lists it, else at its first level", async () => {
    const l0 = gated(GATED.replace("autonomy: [L0, L1]", "autonomy: [L0]"));
    expect((await l0.init.execute({ workflow: "gated", task: "t" }))._unsafeUnwrap().autonomy).toBe("L0");
    const both = gated(GATED.replace("autonomy: [L0, L1]", "autonomy: [L1, L0]"));
    expect((await both.init.execute({ workflow: "gated", task: "t" }))._unsafeUnwrap().autonomy).toBe("L0");
    const l1 = gated(GATED.replace("autonomy: [L0, L1]", "autonomy: [L1, L2]"));
    const run = (await l1.init.execute({ workflow: "gated", task: "t" }))._unsafeUnwrap();
    expect([run.autonomy, run.stage]).toEqual(["L1", "plan"]);
  });
});

describe("what the workflow declares holds: required inputs, external actions, optional stages", () => {
  const DECLARED = `
kind: Workflow
schemaVersion: 2
id: declared
input:
  oneOf: [task_ref, task_text]
  required: [scope, owner]
  optional: [base]
permissions: { edit: plan-scope, external: [comment] }
stages:
  - id: build
  - id: learn
    optional: true
  - id: wrap
`;
  const declared = (spec = DECLARED) => world({ ".github/metator/workflows/declared.yml": spec });

  test("init refuses a run without a required input and names every missing one", async () => {
    const w = declared();
    const e = (
      await w.init.execute({ workflow: "declared", task: "t", inputs: { base: "main" } })
    )._unsafeUnwrapErr();
    expect([e.code, e.message, e.hint]).toEqual([
      "USAGE",
      "workflow declared needs the input `scope`, `owner`",
      "Pass each with `--input <name>=<value>`, e.g. `--input scope=<value>`.",
    ]);
    expect(await w.repo.list()).toEqual([]);
    const one = (
      await w.init.execute({ workflow: "declared", task: "t", inputs: { scope: "packages/a" } })
    )._unsafeUnwrapErr();
    expect(one.message).toBe("workflow declared needs the input `owner`");
    const run = await w.init.execute({
      workflow: "declared",
      task: "t",
      inputs: { scope: "packages/a", owner: "m" },
    });
    expect(run._unsafeUnwrap().stage).toBe("build");
  });

  test("an external action the workflow does not permit is not approved", async () => {
    const w = declared();
    const run = (
      await w.init.execute({ workflow: "declared", task: "t", inputs: { scope: "a", owner: "m" } })
    )._unsafeUnwrap();
    const e = (await w.approve.execute({ gate: "push", by: "maciej" }))._unsafeUnwrapErr();
    expect([e.code, e.message, e.hint]).toEqual([
      "USAGE",
      "workflow declared does not permit push",
      "External actions it permits: comment.",
    ]);
    expect((await w.repo.load(run.runId))._unsafeUnwrap().approvals).toEqual({});
    expect((await w.approve.execute({ gate: "comment", by: "maciej" }))._unsafeUnwrap()).toMatchObject({
      approvals: { comment: { by: "maciej" } },
    });
    // A workflow that permits none says so.
    const none = declared(DECLARED.replace("external: [comment]", "external: []"));
    await none.init.execute({ workflow: "declared", task: "t", inputs: { scope: "a", owner: "m" } });
    expect((await none.approve.execute({ gate: "comment", by: "m" }))._unsafeUnwrapErr().hint).toBe(
      "It permits no external action.",
    );
  });

  test("a failed optional stage is skipped and the log says so", async () => {
    const w = declared();
    const run = (
      await w.init.execute({ workflow: "declared", task: "t", inputs: { scope: "a", owner: "m" } })
    )._unsafeUnwrap();
    await w.advance.execute({ event: { type: "PASS" } });
    const next = (await w.advance.execute({ event: { type: "FAIL", reason: "no lessons" } }))._unsafeUnwrap();
    expect([next.stage, next.status]).toEqual(["wrap", "active"]);
    expect((await w.repo.readLog(run.runId))._unsafeUnwrap()).toContain(
      "2026-10-25T09:00:00.000Z · learn · FAIL · no lessons → wrap (optional stage skipped)",
    );
    // A stage that is not optional escalates, and its log line says nothing of skipping.
    await w.advance.execute({ event: { type: "FAIL", reason: "broken" } });
    expect((await w.repo.readLog(run.runId))._unsafeUnwrap()).toContain(
      "2026-10-25T09:00:00.000Z · wrap · FAIL · broken → escalated",
    );
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

  test("a run is named by its id or by the start of it; a start two runs share is refused with both", async () => {
    const w = world();
    const first = (await w.init.execute({ workflow: "feature", task: "alpha one" }))._unsafeUnwrap().runId;
    const second = (await w.init.execute({ workflow: "feature", task: "beta two" }))._unsafeUnwrap().runId;
    const shared = first.slice(0, first.indexOf("feature") + "feature".length);
    expect(second.startsWith(shared)).toBe(true);
    const start = first.slice(0, shared.length + 3);
    expect([first.startsWith(start), second.startsWith(start)]).toEqual([true, false]);
    expect((await w.repo.resolveId(start))._unsafeUnwrap()).toBe(first);
    expect((await w.repo.resolveId(first))._unsafeUnwrap()).toBe(first);
    const both = (await w.repo.resolveId(shared))._unsafeUnwrapErr();
    expect([both.code, both.message, both.hint]).toEqual([
      "USAGE",
      `2 runs start with "${shared}"`,
      `Type more of the id: ${[first, second].sort().join(", ")}.`,
    ]);
    // A name no run starts with stays as typed: the caller says it was not found.
    expect((await w.repo.resolveId("nope"))._unsafeUnwrap()).toBe("nope");
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
  test("it goes on at the stage it escalated from with a fresh loop; history stays; the log says who", async () => {
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
    // What a person reads in `run status`: where and why, and the two commands out (R9).
    expect(escalated.escalated).toEqual({
      stage: "plan-gate",
      reason: "again",
      next: [
        `metator run resume --run ${runId} --by <name> --drive`,
        `metator run close --run ${runId} --aborted --reason <why>`,
      ],
    });
    expect((await resume.execute({ by: " " }))._unsafeUnwrapErr().message).toBe(
      "say who resumes: --by <name>",
    );
    const back = (await resume.execute({ by: "ala" }))._unsafeUnwrap();
    expect([back.stage, back.status, back.loops, back.escalated]).toEqual([
      "plan-gate",
      "active",
      { plan: 0 },
      undefined,
    ]);
    const log = (await w.fs.read(`.metator/runs/${runId}/log.md`))._unsafeUnwrap();
    expect(log).toContain("resumed at plan-gate · by ala");
    // A person said go on: the next failure sends the run back to be fixed, the one after escalates (F1).
    const again = (await w.advance.execute({ event: { type: "FAIL", reason: "still" } }))._unsafeUnwrap();
    expect([again.status, again.stage]).toEqual(["active", "plan"]);
    await w.advance.execute({ event: { type: "PASS" } });
    expect(
      (await w.advance.execute({ event: { type: "FAIL", reason: "third" } }))._unsafeUnwrap().status,
    ).toBe("escalated");
  });

  test("approving an escalated run is refused with the resume that comes first", async () => {
    const w = world();
    const runId = (await w.init.execute({ workflow: "feature", task: "stuck" }))._unsafeUnwrap().runId;
    await w.advance.execute({ event: { type: "PASS" } });
    await w.advance.execute({ event: { type: "FAIL" } });
    await w.advance.execute({ event: { type: "PASS" } });
    await w.advance.execute({ event: { type: "FAIL" } });
    const refused = (await w.approve.execute({ gate: "approval", by: "ala" }))._unsafeUnwrapErr();
    expect([refused.code, refused.hint]).toEqual([
      "TRANSITION_DENIED",
      `Resume it first: \`metator run resume --run ${runId} --by ala\`.`,
    ]);
  });
});

describe("a gate approved outside its question (R8)", () => {
  test("the gate's open question gets the approval as its answer, after the transition", async () => {
    const w = world();
    const journal = new RunJournal(w.fs, w.repo, w.clock);
    const advance = new AdvanceRun(w.catalog, w.repo, w.clock, journal);
    const runId = (await w.init.execute({ workflow: "feature", task: "gate" }))._unsafeUnwrap().runId;
    await advance.execute({ event: { type: "PASS" } });
    await advance.execute({ event: { type: "PASS" } }); // → approval
    const ask = (source: "gate" | "agent", stage: string, prompt: string) =>
      journal.ask(runId, { stage, source, prompt, options: [{ label: "Approve" }], multiSelect: false });
    const gate = (await ask("gate", "approval", "approve?"))._unsafeUnwrap();
    const other = (await ask("agent", "approval", "which?"))._unsafeUnwrap();
    const earlier = (await ask("gate", "plan", "old"))._unsafeUnwrap();
    const moved = (await advance.execute({ event: { type: "APPROVE", by: "ala" } }))._unsafeUnwrap();
    expect(moved.stage).toBe("build");
    const after = (await journal.questions(runId))._unsafeUnwrap();
    expect(after.find((q) => q.id === gate.id)?.answer).toEqual({
      choices: ["Approve"],
      by: "ala",
      at: "2026-10-25T09:00:00.000Z",
    });
    // Only the gate's own question of that stage: an agent's question and another stage's stay open.
    expect([other.id, earlier.id].map((id) => after.find((q) => q.id === id)?.answer)).toEqual([
      undefined,
      undefined,
    ]);
    const activity = (await journal.activity(runId))._unsafeUnwrap();
    expect(activity.at(-1)).toMatchObject({ type: "answer", text: `${gate.id}: Approve · ala` });
  });
});

describe("a run is refused where it cannot work (F3)", () => {
  const ready = (checks: { id: string; status: string; message: string; fix?: string }[]) => ({
    execute: async () => ok({ ready: true, place: ".", checks }) as never,
  });
  const initWith = (w: ReturnType<typeof world>, checks: Parameters<typeof ready>[0]) =>
    new InitRun(
      w.catalog,
      w.repo,
      w.clock,
      { execute: async () => err(MetatorError.notFound("wt")) } as never,
      ready(checks),
    );

  test("no git repository, or no commit for a worktree: refused with the command that fixes it; nothing is created", async () => {
    const w = world();
    for (const id of ["git", "commits"]) {
      const refused = (
        await initWith(w, [{ id, status: "fail", message: `no ${id}`, fix: "git init" }]).execute({
          workflow: "feature",
          task: "t",
          ...(id === "commits" ? { worktree: {} } : {}),
        })
      )._unsafeUnwrapErr();
      expect([refused.code, refused.message, refused.hint]).toEqual([
        "CHECK_FAILED",
        `a run cannot start here: no ${id}`,
        "Run `git init`, then start the run again.",
      ]);
    }
    expect(await w.repo.list()).toEqual([]);
    // Right after `git init` a run in the checkout still starts: only a worktree needs the commit.
    const fresh = initWith(w, [{ id: "commits", status: "fail", message: "no commit" }]);
    expect((await fresh.execute({ workflow: "feature", task: "t" })).isOk()).toBe(true);
  });

  test("uncommitted changes refuse a worktree run unless allowed; a run in the checkout starts", async () => {
    const w = world();
    const tree = [{ id: "tree", status: "warn", message: "1 tracked file(s) have uncommitted changes" }];
    const init = initWith(w, tree);
    const refused = (await init.execute({ workflow: "feature", task: "t", worktree: {} }))._unsafeUnwrapErr();
    expect([refused.code, refused.details]).toEqual(["CHECK_FAILED", { check: "tree" }]);
    expect(refused.hint).toContain("--allow-dirty");
    expect((await init.execute({ workflow: "feature", task: "t" })).isOk()).toBe(true);
    // Allowed: the refusal is gone, and the next thing asked is the worktree itself.
    const allowed = await init.execute({ workflow: "feature", task: "t", worktree: { allowDirty: true } });
    expect(allowed._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    // A failing check that is not git's (no host) does not refuse a run: a session may carry it.
    const other = initWith(w, [{ id: "host", status: "fail", message: "no host" }]);
    expect((await other.execute({ workflow: "feature", task: "t2" })).isOk()).toBe(true);
  });
});

describe("no workflow installed", () => {
  test("the missing workflow's hint names metator setup, not an empty list (F3)", async () => {
    const w = world({});
    const e = (await w.init.execute({ workflow: "mt-feature", task: "t" }))._unsafeUnwrapErr();
    expect(e.hint).toBe(
      "No workflow is installed here: run `metator setup` (it writes them to .github/metator/workflows/*.yml).",
    );
    const known = (await world().init.execute({ workflow: "nope", task: "t" }))._unsafeUnwrapErr();
    expect(known.hint).toBe("Known workflows: feature. Specs live in .github/metator/workflows/*.yml.");
  });
});
