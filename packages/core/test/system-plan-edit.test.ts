import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { SystemCatalog } from "../src/application/system.ts";
import { SystemPlans } from "../src/application/system-plan-edit.ts";
import { ApproveSystemPlan, LintSystemPlan, SystemPlanStore } from "../src/application/system-plans.ts";
import { LocalSystemLocation } from "../src/application/system-sources.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { documentDigest, editLogOf, PlanEditDocument } from "../src/domain/plan-edit.ts";
import { err, ok } from "../src/domain/result.ts";
import type { RunRecord } from "../src/domain/run-record.ts";
import { SystemMapDocument } from "../src/domain/system-map.ts";
import {
  draftSystemPlan,
  type SystemAnalysis,
  type SystemPlan,
  SystemPlanDocument,
  systemPlanDigest,
} from "../src/domain/system-plan.ts";

const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
  - { id: billing, source: { path: apps/billing } }
  - { id: web, source: { repo: ../web }, consumes: [billing-api] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
`;

const ANALYSIS: SystemAnalysis = {
  task: "Rename refunds",
  map: "docs/metator/system.yml",
  base: null,
  contracts: [{ id: "billing-api", owner: "billing", change: "compatible", consumers: [{ app: "web" }] }],
  applications: [
    { id: "billing", roles: ["changed", "provider"], owners: [], files: [] },
    { id: "web", roles: ["consumer"], owners: [], files: [] },
  ],
};

const PLANS = "metator/system/plans";

async function world() {
  const fs = new InMemoryFileSystem({ "docs/metator/system.yml": MAP });
  const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
  const store = new SystemPlanStore(fs, PLANS);
  const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/src/billing");
  const lint = new LintSystemPlan(location, store);
  const map = SystemMapDocument.parse(Bun.YAML.parse(MAP), "map")._unsafeUnwrap();
  const draft = draftSystemPlan({ id: "rename-refunds", analysis: ANALYSIS, map, by: "mt-system-planner" });
  await store.save(draft);
  await store.saveAnalysis(draft.id, { ...ANALYSIS });
  const runs = new Map<string, Partial<RunRecord>>([
    [
      "r1",
      {
        state: { status: "active", stage: "build", context: { loops: {}, history: [] } },
      } as unknown as Partial<RunRecord>,
    ],
  ]);
  const plans = new SystemPlans({
    fs,
    store,
    lint,
    approve: new ApproveSystemPlan(lint, store, clock),
    sources: {
      location,
      locate: async (app) =>
        ok(
          app.id === "billing"
            ? { app: app.id, root: "/src/billing", dir: "apps/billing", via: "here" as const }
            : undefined,
        ),
    },
    at: () => ({
      runs: {
        load: async (id: string) =>
          runs.has(id) ? ok(runs.get(id) as RunRecord) : err(MetatorError.notFound(`run ${id}`)),
      },
    }),
    clock,
  });
  return { fs, store, plans, draft };
}

const log = async (fs: InMemoryFileSystem) =>
  (await fs.read(editLogOf(`${PLANS}/rename-refunds.yml`)))
    ._unsafeUnwrap()
    .trim()
    .split("\n")
    .map((l) => PlanEditDocument.parse(JSON.parse(l), "log")._unsafeUnwrap());

describe("system plans in the app", () => {
  test("the list and the view: lint, waves, steps per repository, editable", async () => {
    const w = await world();
    const list = (await w.plans.list())._unsafeUnwrap();
    expect(list).toEqual([
      {
        id: "rename-refunds",
        task: "Rename refunds",
        status: "draft",
        steps: w.draft.steps.length,
        done: 0,
        updatedAt: null,
      },
    ]);
    const view = (await w.plans.view("rename-refunds"))._unsafeUnwrap();
    expect(view.digest).toBe(documentDigest(w.draft));
    expect(view.lint.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(view.waves.map((x) => x.wave)).toEqual(view.waves.map((_, i) => i + 1));
    expect(view.waves.flatMap((x) => x.steps).sort()).toEqual(w.draft.steps.map((s) => s.id).sort());
    // A checkout found here is the step's repository; else what the map says.
    expect(view.steps.find((s) => s.app === "billing")?.repo).toBe("/src/billing");
    const withWeb: SystemPlan = {
      ...w.draft,
      steps: [
        ...w.draft.steps,
        { id: "web-show", app: "web", summary: "Show it", contracts: [], dependsOn: [], status: "pending" },
      ],
    };
    await w.store.save(withWeb);
    expect((await w.plans.view("rename-refunds"))._unsafeUnwrap().steps.at(-1)).toMatchObject({
      app: "web",
      repo: "../web",
      task: "Show it",
    });
    await w.store.save(w.draft);
    expect([view.editable, view.file]).toEqual([true, `${PLANS}/rename-refunds.yml`]);
    expect((await w.plans.view("nope"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("approve: lint must be clean; then an edit of an approved plan sends it back to draft and logs who and what", async () => {
    const w = await world();
    const approved = (await w.plans.approve("rename-refunds", "ana"))._unsafeUnwrap();
    expect([approved.status, approved.approval?.by, approved.approval?.stale]).toEqual([
      "approved",
      "ana",
      false,
    ]);
    const plan = approved.plan;
    const edited: SystemPlan = {
      ...plan,
      steps: [
        ...plan.steps.map((s, i) => (i === 0 ? { ...s, summary: `${s.summary}, carefully` } : s)),
        {
          id: "web-docs",
          app: "web",
          summary: "Document it",
          contracts: [],
          dependsOn: [],
          status: "done",
          run: "forged",
        },
      ],
    };
    const saved = (
      await w.plans.save("rename-refunds", { plan: edited, digest: approved.digest, by: "bob" })
    )._unsafeUnwrap();
    expect([saved.status, saved.approval]).toEqual(["draft", undefined]);
    // Progress is never typed: a new step is pending without a run.
    expect(saved.plan.steps.at(-1)).toMatchObject({ id: "web-docs", status: "pending" });
    expect(saved.plan.steps.at(-1)?.run).toBeUndefined();
    const [edit] = await log(w.fs);
    expect(edit).toMatchObject({
      by: "bob",
      target: "system-plan",
      id: "rename-refunds",
      before: approved.digest,
      after: saved.digest,
      unapproved: { by: "ana" },
    });
    expect(edit?.changes).toEqual([
      "step added: web-docs",
      `step ${plan.steps[0]?.id} changed: summary`,
      "approval by ana dropped: the plan is a draft again",
    ]);
    const list = (await w.plans.list())._unsafeUnwrap();
    expect(list[0]?.updatedAt).toBe("2026-11-15T10:00:00.000Z");
  });

  test("an edit that leaves what the approval covers keeps the approval", async () => {
    const w = await world();
    const approved = (await w.plans.approve("rename-refunds", "ana"))._unsafeUnwrap();
    const same = { ...approved.plan, createdBy: "someone else", status: "draft", approval: undefined };
    const saved = (
      await w.plans.save("rename-refunds", { plan: same, digest: approved.digest, by: "bob" })
    )._unsafeUnwrap();
    expect([saved.status, saved.approval?.by, saved.approval?.stale]).toEqual(["approved", "ana", false]);
  });

  test("a step with a run cannot be changed or removed; new steps may be added", async () => {
    const w = await world();
    const first = w.draft.steps[0] as SystemPlan["steps"][number];
    const running: SystemPlan = {
      ...w.draft,
      status: "running",
      steps: w.draft.steps.map((s) => (s.id === first.id ? { ...s, status: "running", run: "r1" } : s)),
    };
    await w.store.save(running);
    const view = (await w.plans.view("rename-refunds"))._unsafeUnwrap();
    expect(view.steps.find((s) => s.id === first.id)).toMatchObject({
      run: "r1",
      runState: "active",
      runStage: "build",
    });
    const changed = {
      ...running,
      steps: running.steps.map((s) => (s.id === first.id ? { ...s, summary: "else" } : s)),
    };
    const refused = await w.plans.save("rename-refunds", { plan: changed, digest: view.digest, by: "bob" });
    expect(refused._unsafeUnwrapErr()).toMatchObject({
      code: "TRANSITION_DENIED",
      details: { step: first.id },
    });
    const removed = { ...running, steps: running.steps.filter((s) => s.id !== first.id) };
    expect(
      (
        await w.plans.save("rename-refunds", { plan: removed, digest: view.digest, by: "bob" })
      )._unsafeUnwrapErr().message,
    ).toContain("cannot be removed");
    // The editor sends the step as it read it, status and run included: that is no change.
    const added = {
      ...running,
      steps: [...running.steps, { id: "extra", app: "web", summary: "More", contracts: [], dependsOn: [] }],
    };
    const ok1 = (
      await w.plans.save("rename-refunds", { plan: added, digest: view.digest, by: "bob" })
    )._unsafeUnwrap();
    expect(ok1.plan.steps.find((s) => s.id === first.id)).toMatchObject({ status: "running", run: "r1" });
  });

  test("a stale digest is CONFLICT with the current view; an invalid plan is USAGE by field; nothing is written", async () => {
    const w = await world();
    const stale = (
      await w.plans.save("rename-refunds", { plan: w.draft, digest: "x", by: "bob" })
    )._unsafeUnwrapErr();
    expect(stale.code).toBe("CONFLICT");
    expect((stale.details as { current: { digest: string } }).current.digest).toBe(documentDigest(w.draft));
    const digest = documentDigest(w.draft);
    const invalid = { ...w.draft, steps: [{ id: "BAD ID", app: "web", summary: "x" }] };
    const usage = (
      await w.plans.save("rename-refunds", { plan: invalid, digest, by: "bob" })
    )._unsafeUnwrapErr();
    expect(usage.code).toBe("USAGE");
    expect((usage.details as { problems: { field: string }[] }).problems[0]?.field).toBe("steps.0.id");
    const other = (
      await w.plans.save("rename-refunds", { plan: { ...w.draft, id: "other" }, digest, by: "bob" })
    )._unsafeUnwrapErr();
    expect(other.code).toBe("USAGE");
    expect((await w.store.load("rename-refunds"))._unsafeUnwrap()).toEqual(w.draft);
    expect(await w.fs.exists(editLogOf(`${PLANS}/rename-refunds.yml`))).toBe(false);
  });

  test("a done plan is read-only", async () => {
    const w = await world();
    await w.store.save({ ...w.draft, status: "done" });
    const view = (await w.plans.view("rename-refunds"))._unsafeUnwrap();
    expect([view.editable, view.readOnlyBecause]).toEqual([false, "the plan is done: every step's run is"]);
    const r = await w.plans.save("rename-refunds", { plan: view.plan, digest: view.digest, by: "bob" });
    expect(r._unsafeUnwrapErr().code).toBe("TRANSITION_DENIED");
  });

  test("lint without writing; approve refuses lint errors and names no one", async () => {
    const w = await world();
    const cycle = {
      ...w.draft,
      steps: w.draft.steps.map((s, i, all) => ({ ...s, dependsOn: [all[(i + 1) % all.length]?.id ?? s.id] })),
    };
    const linted = (await w.plans.lint("rename-refunds", cycle))._unsafeUnwrap();
    expect(linted.problems.some((p) => p.severity === "error")).toBe(true);
    expect((await w.plans.lint("rename-refunds", { id: 3 }))._unsafeUnwrap().problems[0]?.field).toBe("id");
    expect(
      (await w.plans.lint("rename-refunds", { ...w.draft, id: "zz" }))._unsafeUnwrap().problems[0]?.field,
    ).toBe("id");
    expect((await w.plans.approve("rename-refunds", " ")).isErr()).toBe(true);
    await w.store.save(cycle);
    expect((await w.plans.approve("rename-refunds", "ana"))._unsafeUnwrapErr().code).toBe("CHECK_FAILED");
    expect((await w.plans.view("rename-refunds"))._unsafeUnwrap().waves).toEqual([]);
  });

  test("an approval that no longer covers the plan is shown stale", async () => {
    const w = await world();
    const stale: SystemPlan = {
      ...w.draft,
      status: "approved",
      approval: { by: "ana", at: "t", digest: "old" },
    };
    await w.store.save(stale);
    expect((await w.plans.view("rename-refunds"))._unsafeUnwrap().approval?.stale).toBe(true);
    const holds = { ...stale, approval: { by: "ana", at: "t", digest: systemPlanDigest(stale) } };
    await w.store.save(holds);
    expect((await w.plans.list())._unsafeUnwrap()[0]?.approval).toEqual({ by: "ana", at: "t", stale: false });
    expect(SystemPlanDocument.kind).toBe("SystemPlan");
  });
});
