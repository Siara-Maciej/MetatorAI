import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, GetRunStatus, InitRun, ListRuns } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";

const FEATURE = `
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
    status: new GetRunStatus(catalog, repo),
    list: new ListRuns(repo),
  };
}

describe("WorkflowCatalog", () => {
  test("lists valid workflows and reports broken files without hiding the good ones", async () => {
    const { catalog } = world({
      ".github/metator/workflows/feature.yml": FEATURE,
      ".github/metator/workflows/broken.yml": "id: broken\nstages: []",
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
      schemaVersion: 1,
      workflow: { id: "feature", version: 1 },
      createdAt: "2026-10-25T09:00:00.000Z",
    });
    expect((await w.fs.read(".metator/runs/latest"))._unsafeUnwrap().trim()).toBe(run.runId);
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
      JSON.stringify({ schemaVersion: 1, runId: run.runId, state: { stage: "build" } }),
    );
    const error = (await w.status.execute({}))._unsafeUnwrapErr();
    expect(error.code).toBe("INVALID_ARTIFACT");
    expect(error.hint).toContain("Do not edit state.json");
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
