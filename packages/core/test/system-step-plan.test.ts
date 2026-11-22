/** "Plan this step" and a step started on its own (ADR-0096): one step of a system plan as a child run. */
import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { SystemCatalog } from "../src/application/system.ts";
import { SystemPlanStore } from "../src/application/system-plans.ts";
import { type RepositoryRuns, RunSystemPlan, StartSystemStep } from "../src/application/system-runs.ts";
import { CloneCache, LocalSystemLocation, SystemSources } from "../src/application/system-sources.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { ok } from "../src/domain/result.ts";
import { type SystemPlan, systemPlanDigest } from "../src/domain/system-plan.ts";

const FEATURE = `kind: Workflow
schemaVersion: 3
id: mt-feature
stages:
  - id: plan
    produces: [plan.json]
  - id: plan-approval
    hitl: true
  - id: build
`;
const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - { id: billing, source: { path: apps/billing } }
  - { id: web, source: { repo: ../web }, consumes: [billing-api] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
`;

const step = (id: string, app: string, dependsOn: string[] = []) => ({
  id,
  app,
  summary: `Do ${id}`,
  contracts: [],
  dependsOn,
  status: "pending" as const,
});

function repository(root: string, fs: InMemoryFileSystem) {
  const paths = {
    ...DEFAULT_PATHS,
    runs: `${root}/.metator/runs`,
    workflows: `${root}/.github/metator/workflows`,
  };
  const clock = new FixedClock(new Date("2026-11-22T09:00:00.000Z"));
  const runs = new RunRepository(fs, paths);
  const catalog = new WorkflowCatalog(fs, paths);
  const init = new InitRun(catalog, runs, clock);
  const asked: Record<string, unknown>[] = [];
  return {
    runs,
    asked,
    clock,
    advance: new AdvanceRun(catalog, runs, clock),
    start: {
      execute: async (input: Parameters<RepositoryRuns["start"]["execute"]>[0]) => {
        asked.push(input as unknown as Record<string, unknown>);
        const { worktree: _w, session: _s, drive: _d, ...rest } = input;
        return (await init.execute(rest as Parameters<InitRun["execute"]>[0])).map((run) => ({
          run,
          warnings: [],
          ...(input.session ? { session: { paneId: "w2:p1", host: input.session.host ?? "claude" } } : {}),
        }));
      },
    },
  };
}

async function world(approved = true) {
  const fs = new InMemoryFileSystem({
    "docs/metator/system.yml": MAP,
    "platform/.github/metator/workflows/mt-feature.yml": FEATURE,
    "web/.github/metator/workflows/mt-feature.yml": FEATURE,
  });
  const store = new SystemPlanStore(fs, "metator/system/plans");
  const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/src/platform");
  const sources = new SystemSources(
    { roots: { web: "../web" } },
    "/src/platform",
    location,
    new CloneCache({ resolve: async () => ok("a"), checkout: async () => ok(undefined) }, "/c"),
    { isDirectory: async (p: string) => p === "/src/web", read: async () => ok(undefined) },
    { remoteUrl: async () => ok(undefined) },
  );
  const repos = new Map([
    ["/src/platform", repository("platform", fs)],
    ["/src/web", repository("web", fs)],
  ]);
  const at = (root: string): RepositoryRuns => repos.get(root) as unknown as RepositoryRuns;
  const platform = repos.get("/src/platform") as ReturnType<typeof repository>;
  const web = repos.get("/src/web") as ReturnType<typeof repository>;
  const p: SystemPlan = {
    id: "rename-refunds",
    task: "Rename refunds",
    status: approved ? "approved" : "draft",
    strategies: [],
    steps: [step("billing-change", "billing"), step("web-change", "web", ["billing-change"])],
  };
  (
    await store.save(approved ? { ...p, approval: { by: "ana", at: "t", digest: systemPlanDigest(p) } } : p)
  )._unsafeUnwrap();
  const system = (
    await new InitRun(
      new WorkflowCatalog(fs, { ...DEFAULT_PATHS, workflows: "platform/.github/metator/workflows" }),
      platform.runs,
      platform.clock,
    ).execute({
      workflow: "mt-feature",
      task: "Rename refunds",
    })
  )._unsafeUnwrap();
  return {
    fs,
    store,
    platform,
    web,
    system: system.runId,
    steps: new StartSystemStep(store, sources, at, platform.clock, platform.runs),
    run: new RunSystemPlan(store, sources, at, platform.clock, platform.runs),
  };
}

describe("StartSystemStep", () => {
  test("Plan this step: a child run in its app's repository that stops at its plan; the step keeps it", async () => {
    const w = await world(false);
    const planned = (
      await w.steps.execute({ id: "rename-refunds", step: "web-change", plan: true })
    )._unsafeUnwrap();
    expect([planned.root, planned.session]).toEqual(["/src/web", { paneId: "w2:p1", host: "claude" }]);
    const child = (await w.web.runs.load(planned.run))._unsafeUnwrap();
    expect([child.until, child.parent, child.system]).toEqual([
      "plan",
      w.system,
      { plan: "rename-refunds", step: "web-change", app: "web" },
    ]);
    const saved = (await w.store.load("rename-refunds"))._unsafeUnwrap();
    expect(saved.steps.map((s) => [s.id, s.status, s.planRunId ?? null, s.run ?? null])).toEqual([
      ["billing-change", "pending", null, null],
      ["web-change", "pending", planned.run, null],
    ]);
    expect((await w.platform.runs.load(w.system))._unsafeUnwrap().children).toEqual([planned.run]);
    // While its plan is made, asking again is refused.
    expect(
      (await w.steps.execute({ id: "rename-refunds", step: "web-change", plan: true }))._unsafeUnwrapErr()
        .message,
    ).toBe(`step web-change is being planned already: run ${planned.run}`);
  });

  test("its own run waits for its dependencies (the shared rule) and takes the step's approved plan", async () => {
    const w = await world();
    const planned = (
      await w.steps.execute({ id: "rename-refunds", step: "web-change", plan: true })
    )._unsafeUnwrap();
    expect(
      (await w.steps.execute({ id: "rename-refunds", step: "web-change" }))._unsafeUnwrapErr().message,
    ).toBe("step web-change waits for billing-change: it starts when they are done");
    // The plan run makes its plan and a person approves it.
    await w.fs.write(`web/.metator/runs/${planned.run}/plan.json`, "{}");
    (await w.web.advance.execute({ runId: planned.run, event: { type: "PASS" } }))._unsafeUnwrap();
    (
      await w.web.advance.execute({ runId: planned.run, event: { type: "APPROVE", by: "ana" } })
    )._unsafeUnwrap();
    const plan = (await w.store.load("rename-refunds"))._unsafeUnwrap();
    (
      await w.store.save({
        ...plan,
        steps: plan.steps.map((s) => (s.id === "billing-change" ? { ...s, status: "done" as const } : s)),
      })
    )._unsafeUnwrap();
    const started = (await w.steps.execute({ id: "rename-refunds", step: "web-change" }))._unsafeUnwrap();
    const run = (await w.web.runs.load(started.run))._unsafeUnwrap();
    expect([run.planFrom, run.state.stage]).toEqual([{ run: planned.run, from: "build" }, "build"]);
    expect(started.plan.steps[1]).toMatchObject({
      status: "running",
      run: started.run,
      planRunId: planned.run,
    });
  });

  test("a step whose plan is not approved yet runs without it", async () => {
    const w = await world();
    const planned = (
      await w.steps.execute({ id: "rename-refunds", step: "billing-change", plan: true })
    )._unsafeUnwrap();
    const started = (await w.steps.execute({ id: "rename-refunds", step: "billing-change" }))._unsafeUnwrap();
    const run = (await w.platform.runs.load(started.run))._unsafeUnwrap();
    expect([run.planFrom, run.state.stage]).toEqual([undefined, "plan"]);
    expect(started.plan.steps[0]).toMatchObject({ planRunId: planned.run, run: started.run });
  });

  test("system plan run takes a step's plan too", async () => {
    const w = await world();
    const planned = (
      await w.steps.execute({ id: "rename-refunds", step: "billing-change", plan: true })
    )._unsafeUnwrap();
    await w.fs.write(`platform/.metator/runs/${planned.run}/plan.json`, "{}");
    (await w.platform.advance.execute({ runId: planned.run, event: { type: "PASS" } }))._unsafeUnwrap();
    (
      await w.platform.advance.execute({ runId: planned.run, event: { type: "APPROVE", by: "ana" } })
    )._unsafeUnwrap();
    const wave = (await w.run.execute({ id: "rename-refunds", parent: w.system }))._unsafeUnwrap();
    expect(w.platform.asked.at(-1)?.planFrom).toEqual({ run: planned.run, from: "build" });
    expect(wave.started.map((s) => s.step)).toEqual(["billing-change"]);
  });
});
