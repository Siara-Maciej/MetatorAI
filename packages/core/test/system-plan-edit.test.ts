import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { SystemCatalog } from "../src/application/system.ts";
import { SystemPlans } from "../src/application/system-plan-edit.ts";
import { ApproveSystemPlan, LintSystemPlan, SystemPlanStore } from "../src/application/system-plans.ts";
import { LocalSystemLocation } from "../src/application/system-sources.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { documentDigest, PlanRevisionDocument, previousOf } from "../src/domain/plan-edit.ts";
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
import { serializeJsonDocument } from "../src/domain/versioned.ts";

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

  test("approve: lint must be clean, and the approval is the person's", async () => {
    const w = await world();
    const approved = (await w.plans.approve("rename-refunds", "ana"))._unsafeUnwrap();
    expect([approved.status, approved.approval?.by, approved.approval?.stale]).toEqual([
      "approved",
      "ana",
      false,
    ]);
  });
  test("a done plan is read-only", async () => {
    const w = await world();
    await w.store.save({ ...w.draft, status: "done" });
    const view = (await w.plans.view("rename-refunds"))._unsafeUnwrap();
    expect([view.editable, view.readOnlyBecause]).toEqual([false, "the plan is done: every step's run is"]);
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

describe("a system plan's previous version (its planner revised it)", () => {
  test("the view shows the version kept when the run went back, and what changed by step", async () => {
    const w = await world();
    expect((await w.plans.view(w.draft.id))._unsafeUnwrap().previous).toBeUndefined();
    await w.fs.write(
      previousOf(w.store.file(w.draft.id)),
      serializeJsonDocument(
        PlanRevisionDocument.stamp({
          at: "2026-11-18T12:00:00.000Z",
          digest: documentDigest(w.draft),
          plan: w.draft as unknown as Record<string, unknown>,
        }),
      ),
    );
    const [first, ...rest] = w.draft.steps;
    const revised = {
      ...w.draft,
      steps: [
        { ...(first as (typeof w.draft.steps)[number]), summary: "Cents everywhere" },
        ...rest.slice(1),
      ],
    };
    (await w.store.save(revised))._unsafeUnwrap();
    const view = (await w.plans.view(w.draft.id))._unsafeUnwrap();
    expect([view.previous?.digest, view.previous?.at]).toEqual([
      documentDigest(w.draft),
      "2026-11-18T12:00:00.000Z",
    ]);
    expect(view.changes).toEqual([
      ...(rest.length > 0 ? [`step removed: ${rest[0]?.id}`] : []),
      `step ${first?.id} changed: summary`,
    ]);
  });
});
