/**
 * A run that stops once its plan is approved (`--until plan`, status `planned`) and a run that
 * takes such a plan (`--plan-from`, ADR-0096).
 */
import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";

const FEATURE = `
kind: Workflow
schemaVersion: 3
id: feature
stages:
  - id: intake
    produces: [task.md]
  - id: plan
    produces: [plan.json]
  - id: plan-gate
    onFail: { goto: plan, loop: plan }
  - id: plan-approval
    hitl: true
    skipAt: [L1]
  - id: build
  - id: delivery
    hitl: true
autonomy: [L0, L1]
loops:
  plan: 1
`;
const NO_PLAN = "kind: Workflow\nschemaVersion: 1\nid: tiny\nstages:\n  - id: build\n";

function world() {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/feature.yml": FEATURE,
    ".github/metator/workflows/tiny.yml": NO_PLAN,
  });
  const clock = new FixedClock(new Date("2026-11-22T09:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  return { fs, repo, init: new InitRun(catalog, repo, clock), advance: new AdvanceRun(catalog, repo, clock) };
}

async function planned(w: ReturnType<typeof world>, autonomy?: "L1") {
  const run = (
    await w.init.execute({
      workflow: "feature",
      task: "Round prices",
      until: "plan",
      ...(autonomy ? { autonomy } : {}),
    })
  )._unsafeUnwrap();
  await w.fs.write(`${w.repo.runDir(run.runId)}/task.md`, "# Round prices\n");
  await w.fs.write(`${w.repo.runDir(run.runId)}/plan.json`, '{"kind":"Plan"}');
  for (const _ of ["intake", "plan", "plan-gate"])
    (await w.advance.execute({ runId: run.runId, event: { type: "PASS" } }))._unsafeUnwrap();
  return run.runId;
}

describe("a run --until plan", () => {
  test("stops as planned once a person approves the plan: finished, nothing more expected", async () => {
    const w = world();
    const id = await planned(w);
    const approved = (
      await w.advance.execute({ runId: id, event: { type: "APPROVE", by: "ana" } })
    )._unsafeUnwrap();
    expect([approved.status, approved.stage, approved.expects]).toEqual(["planned", "planned", []]);
    const record = (await w.repo.load(id))._unsafeUnwrap();
    expect(record.until).toBe("plan");
    expect(record.approvals["plan-approval"]?.by).toBe("ana");
    expect((await w.repo.readLog(id))._unsafeUnwrap().at(-1)).toContain(
      "planned · the plan is approved; the run stops here (--until plan)",
    );
  });

  test("the Backlog is told once, when it stops planned", async () => {
    const w = world();
    const told: string[] = [];
    const catalog = new WorkflowCatalog(w.fs, DEFAULT_PATHS);
    const clock = new FixedClock(new Date("2026-11-22T09:00:00.000Z"));
    const advance = new AdvanceRun(catalog, w.repo, clock, undefined, undefined, undefined, {
      planned: async (runId) => {
        told.push(runId);
        return { isErr: () => false } as never;
      },
    });
    const id = await planned(w);
    expect(told).toEqual([]);
    (await advance.execute({ runId: id, event: { type: "APPROVE", by: "ana" } }))._unsafeUnwrap();
    expect(told).toEqual([id]);
  });

  test("at L1 the skipped approval stops it as planned too", async () => {
    const w = world();
    const id = await planned(w, "L1");
    expect((await w.repo.load(id))._unsafeUnwrap().state.status).toBe("planned");
  });

  test("a workflow without a plan stage cannot stop at its plan", async () => {
    const w = world();
    const refused = await w.init.execute({ workflow: "tiny", task: "x", until: "plan" });
    expect(refused._unsafeUnwrapErr().message).toBe(
      "workflow tiny has no plan stage to stop at (no stage writes plan.json)",
    );
  });
});

describe("a run --plan-from an approved plan", () => {
  test("starts at build with the plan's files and its approval; the stages before are passed as plan from <run>", async () => {
    const w = world();
    const from = await planned(w);
    (await w.advance.execute({ runId: from, event: { type: "APPROVE", by: "ana" } }))._unsafeUnwrap();
    const run = (
      await w.init.execute({
        workflow: "feature",
        task: "Round prices",
        planFrom: { run: from, from: "build" },
      })
    )._unsafeUnwrap();
    expect([run.stage, run.status]).toEqual(["build", "active"]);
    const record = (await w.repo.load(run.runId))._unsafeUnwrap();
    expect(record.planFrom).toEqual({ run: from, from: "build" });
    expect(record.state.context.history.map((h) => [h.stage, h.detail])).toEqual(
      ["intake", "plan", "plan-gate", "plan-approval"].map((s) => [s, `plan from ${from}`]),
    );
    expect(record.approvals["plan-approval"]?.by).toBe("ana");
    expect((await w.fs.read(`${w.repo.runDir(run.runId)}/plan.json`))._unsafeUnwrap()).toBe(
      '{"kind":"Plan"}',
    );
    expect((await w.fs.read(`${w.repo.runDir(run.runId)}/task.md`))._unsafeUnwrap()).toBe("# Round prices\n");
  });

  test("a stale plan starts at its review: the plan's gate, then the person's approval", async () => {
    const w = world();
    const from = await planned(w);
    (await w.advance.execute({ runId: from, event: { type: "APPROVE", by: "ana" } }))._unsafeUnwrap();
    const run = (
      await w.init.execute({
        workflow: "feature",
        task: "Round prices",
        planFrom: { run: from, from: "review" },
      })
    )._unsafeUnwrap();
    expect(run.stage).toBe("plan-gate");
    const record = (await w.repo.load(run.runId))._unsafeUnwrap();
    expect(record.approvals["plan-approval"]).toBeUndefined();
    expect(await w.fs.exists(`${w.repo.runDir(run.runId)}/plan.json`)).toBe(true);
  });

  test("refused from a run whose plan was not approved, or that left no plan", async () => {
    const w = world();
    const from = await planned(w);
    const early = await w.init.execute({
      workflow: "feature",
      task: "x",
      planFrom: { run: from, from: "build" },
    });
    expect(early._unsafeUnwrapErr().message).toBe(
      `run ${from} has no approved plan yet: it is active at plan-approval`,
    );
    (await w.advance.execute({ runId: from, event: { type: "APPROVE", by: "ana" } }))._unsafeUnwrap();
    await w.fs.remove(`${w.repo.runDir(from)}/plan.json`);
    const gone = await w.init.execute({
      workflow: "feature",
      task: "x",
      planFrom: { run: from, from: "build" },
    });
    expect(gone._unsafeUnwrapErr().message).toBe(`run ${from} left no plan.json to start from`);
    const both = await w.init.execute({
      workflow: "feature",
      task: "x",
      until: "plan",
      planFrom: { run: from, from: "build" },
    });
    expect(both._unsafeUnwrapErr().code).toBe("USAGE");
  });
});
