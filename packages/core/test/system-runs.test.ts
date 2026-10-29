import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { SystemCatalog } from "../src/application/system.ts";
import { SystemPlanStore } from "../src/application/system-plans.ts";
import { type RepositoryRuns, RunSystemPlan, SystemPlanStatus } from "../src/application/system-runs.ts";
import { CloneCache, LocalSystemLocation, SystemSources } from "../src/application/system-sources.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { ok } from "../src/domain/result.ts";
import { readySteps, type SystemPlan, stepTask, systemPlanDigest } from "../src/domain/system-plan.ts";

const TINY = "kind: Workflow\nschemaVersion: 2\nid: mt-feature\nstages:\n  - id: build\n";
const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - { id: billing, source: { path: apps/billing } }
  - { id: web, source: { repo: ../web }, consumes: [billing-api] }
  - { id: mail, source: { repo: git@x:mail.git }, consumes: [billing-api] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
`;

const step = (id: string, app: string, dependsOn: string[] = [], status: "pending" | "done" = "pending") => ({
  id,
  app,
  summary: `Do ${id}`,
  contracts: [{ id: "billing-api", role: id.endsWith("bump") ? ("bump" as const) : ("migrate" as const) }],
  dependsOn,
  status,
});
const plan = (steps: SystemPlan["steps"]): SystemPlan => {
  const p: SystemPlan = { id: "rename", task: "Rename refunds", status: "approved", strategies: [], steps };
  return { ...p, approval: { by: "ana", at: "t", digest: systemPlanDigest(p) } };
};

describe("linked runs domain", () => {
  test("ready steps: pending with every dependency done", () => {
    const p = plan([
      step("billing-bump", "billing", [], "done"),
      step("web-migrate", "web", ["billing-bump"]),
      step("mail-migrate", "mail", ["web-migrate"]),
    ]);
    expect(readySteps(p).map((s) => s.id)).toEqual(["web-migrate"]);
    expect(readySteps(plan([step("a", "billing", ["b"]), step("b", "web")])).map((s) => s.id)).toEqual(["b"]);
  });

  test("a step's task says what, where and how it fits the plan", () => {
    const p = plan([step("billing-bump", "billing")]);
    const s = {
      ...step("web-migrate", "web", ["billing-bump"]),
      deploy: { flag: "new-refunds", rollback: "turn the flag off" },
    };
    expect(stepTask(p, s, "apps/web")).toBe(
      "Do web-migrate (system plan rename, step web-migrate in web at apps/web; contracts: migrate billing-api; after billing-bump; behind flag new-refunds; rollback: turn the flag off. Task: Rename refunds)",
    );
    expect(stepTask(p, step("billing-bump", "billing"), ".")).toBe(
      "Do billing-bump (system plan rename, step billing-bump in billing; contracts: bump billing-api. Task: Rename refunds)",
    );
  });
});

/** One repository on the in-memory file system: its runs, catalog and clock. */
function repository(root: string, shared: InMemoryFileSystem) {
  const fs = shared;
  const paths = {
    ...DEFAULT_PATHS,
    runs: `${root}/.metator/runs`,
    workflows: `${root}/.github/metator/workflows`,
  };
  const clock = new FixedClock(new Date("2026-10-29T09:00:00.000Z"));
  const runs = new RunRepository(fs, paths);
  const catalog = new WorkflowCatalog(fs, paths);
  return {
    runs,
    init: new InitRun(catalog, runs, clock),
    advance: new AdvanceRun(catalog, runs, clock),
    clock,
  };
}

function world(steps: SystemPlan["steps"], roots: Record<string, string> = { web: "../web" }) {
  const fs = new InMemoryFileSystem({
    "docs/metator/system.yml": MAP,
    "platform/.github/metator/workflows/mt-feature.yml": TINY,
    "web/.github/metator/workflows/mt-feature.yml": TINY,
  });
  const store = new SystemPlanStore(fs, "metator/system/plans");
  const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/src/platform");
  const dirs = ["/src/web"];
  const sources = new SystemSources(
    { roots },
    "/src/platform",
    location,
    new CloneCache({ resolve: async () => ok("a"), checkout: async () => ok(undefined) }, "/c"),
    { isDirectory: async (p: string) => dirs.includes(p) },
    { remoteUrl: async () => ok(undefined) },
  );
  const repos = new Map([
    ["/src/platform", repository("platform", fs)],
    ["/src/web", repository("web", fs)],
  ]);
  const at = (root: string): RepositoryRuns => repos.get(root) as RepositoryRuns;
  const platform = repos.get("/src/platform") as ReturnType<typeof repository>;
  return {
    fs,
    store,
    repos,
    platform,
    run: new RunSystemPlan(store, sources, at, platform.clock, platform.runs),
    status: new SystemPlanStatus(store, sources, at),
    save: () => store.save(plan(steps)),
  };
}

describe("RunSystemPlan and SystemPlanStatus", () => {
  test("the ready steps start in their repositories, linked to the parent; status reads them back", async () => {
    const w = world([step("billing-bump", "billing"), step("web-migrate", "web", ["billing-bump"])]);
    await w.save();
    const parent = (
      await w.platform.init.execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    const first = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect(first.started.map((s) => [s.step, s.root])).toEqual([["billing-bump", "/src/platform"]]);
    const child = (await w.platform.runs.load(first.started[0]?.run as string))._unsafeUnwrap();
    expect([child.parent, child.system]).toEqual([
      parent.runId,
      { plan: "rename", step: "billing-bump", app: "billing" },
    ]);
    expect((await w.platform.runs.load(parent.runId))._unsafeUnwrap().children).toEqual([
      first.started[0]?.run as string,
    ]);
    expect((await w.platform.runs.readLog(parent.runId))._unsafeUnwrap().at(-1)).toContain("· child · ");
    expect(first.plan.steps.map((s) => [s.id, s.status])).toEqual([
      ["billing-bump", "running"],
      ["web-migrate", "pending"],
    ]);
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrap().started).toEqual([]);

    const running = (await w.status.execute("rename"))._unsafeUnwrap();
    expect(running.steps.map((s) => [s.id, s.status, s.runStatus ?? null])).toEqual([
      ["billing-bump", "running", "active"],
      ["web-migrate", "pending", null],
    ]);
    await w.platform.advance.execute({ runId: first.started[0]?.run as string, event: { type: "PASS" } });
    expect((await w.status.execute("rename"))._unsafeUnwrap().steps[0]?.status).toBe("done");
    const second = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect(second.started.map((s) => [s.step, s.root])).toEqual([["web-migrate", "/src/web"]]);
    const web = w.repos.get("/src/web") as ReturnType<typeof repository>;
    await web.advance.execute({
      runId: second.started[0]?.run as string,
      event: { type: "ABORT", reason: "no" },
    });
    const blocked = (await w.status.execute("rename"))._unsafeUnwrap();
    expect([blocked.steps[1]?.status, blocked.plan.status]).toEqual(["blocked", "running"]);
    expect((await w.platform.runs.load(parent.runId))._unsafeUnwrap().children).toHaveLength(2);
  });

  test("every step done finishes the plan", async () => {
    const w = world([step("billing-bump", "billing")]);
    await w.save();
    const r = (await w.run.execute({ id: "rename", workflow: "mt-feature" }))._unsafeUnwrap();
    await w.platform.advance.execute({ runId: r.started[0]?.run as string, event: { type: "PASS" } });
    expect((await w.status.execute("rename"))._unsafeUnwrap().plan.status).toBe("done");
  });

  test("a draft, a changed plan or an application without a checkout does not start", async () => {
    const w = world([step("mail-migrate", "mail")]);
    await w.store.save({ ...plan([step("mail-migrate", "mail")]), status: "draft" });
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe("rename is not approved");
    await w.store.save({ ...plan([step("mail-migrate", "mail")]), steps: [step("other", "mail")] });
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "the steps of rename changed after ana approved them",
    );
    await w.save();
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "no checkout of mail to run step mail-migrate in",
    );
    const ghost = world([step("ghost-x", "ghost")]);
    await ghost.save();
    expect((await ghost.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "step ghost-x: application ghost is not in the map",
    );
  });

  test("a wave starts whole or not at all: a step without a checkout stops it before anything starts", async () => {
    const w = world([step("billing-bump", "billing"), step("mail-migrate", "mail")]);
    await w.save();
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "no checkout of mail to run step mail-migrate in",
    );
    expect((await w.store.load("rename"))._unsafeUnwrap().steps.map((s) => s.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(await w.platform.runs.list()).toEqual([]);
  });
});
