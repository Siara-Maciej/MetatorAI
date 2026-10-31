import { describe, expect, test } from "bun:test";
import { FakeAgentHost, InMemoryFileSystem } from "@metator/testing";
import { SystemCatalog } from "../src/application/system.ts";
import {
  AnalyzeSystem,
  ApproveSystemPlan,
  CreateSystemPlan,
  LintSystemPlan,
  PlannedBreakingChanges,
  ProposeSystemPlan,
  SystemPlanStore,
} from "../src/application/system-plans.ts";
import { LocalSystemLocation } from "../src/application/system-sources.ts";
import { ok } from "../src/domain/result.ts";
import { type SystemMap, SystemMapSchema } from "../src/domain/system-map.ts";
import {
  analysisFrom,
  breakingAllowance,
  draftSystemPlan,
  lintSystemPlan,
  type SystemAnalysis,
  type SystemPlan,
  systemPlanDigest,
  systemPlanWaves,
} from "../src/domain/system-plan.ts";

const map = (breaking: "expand-contract" | "versioned" | "forbidden" = "expand-contract"): SystemMap =>
  SystemMapSchema.parse({
    system: "shop",
    applications: [
      { id: "billing", source: { path: "apps/billing" }, owners: ["@b"] },
      { id: "web", source: { repo: "../web" }, owners: ["@w"], consumes: ["billing-api@^1", "prices"] },
      { id: "mail", source: { repo: "../mail" }, owners: ["@m"], consumes: ["billing-api"] },
      { id: "pricing", source: { repo: "../pricing" }, owners: ["@p"] },
    ],
    contracts: [
      { id: "billing-api", kind: "openapi", owner: "billing", spec: { path: "openapi.yaml" } },
      { id: "prices", kind: "openapi", owner: "pricing", spec: { path: "p.yaml" } },
      {
        id: "legacy",
        kind: "openapi",
        owner: "billing",
        spec: { path: "legacy.yaml" },
        compatibility: "none",
      },
    ],
    policies: { breaking },
  });

const analysis = (
  change: "breaking" | "compatible" = "breaking",
  extra: Partial<SystemAnalysis> = {},
): SystemAnalysis => ({
  task: "Rename refunds",
  map: "docs/metator/system.yml",
  base: null,
  contracts: [
    {
      id: "billing-api",
      owner: "billing",
      change,
      consumers: [{ app: "web", version: "^1" }, { app: "mail" }],
    },
  ],
  applications: [
    { id: "billing", roles: ["changed", "provider"], owners: ["@b"], files: [] },
    { id: "web", roles: ["consumer"], owners: ["@w"], files: [] },
    { id: "mail", roles: ["consumer"], owners: ["@m"], files: [] },
  ],
  ...extra,
});

const shape = (p: SystemPlan) => p.steps.map((s) => [s.id, s.contracts.map((c) => c.role), s.dependsOn]);
const errors = (p: SystemPlan, m: SystemMap, a?: SystemAnalysis) =>
  lintSystemPlan(p, m, a)
    .filter((x) => x.severity === "error")
    .map((x) => x.message);

describe("system plan domain", () => {
  test("the analysis from an impact: marked breaking, diffed, unknown; roles per application", () => {
    const a = analysisFrom({
      task: "t",
      map: "m",
      base: "main",
      impact: {
        applications: [
          {
            id: "billing",
            changed: true,
            reasons: ["its files changed (a.ts)", "provides billing-api"],
            owners: ["@b"],
            source: { path: "." },
          },
          {
            id: "web",
            changed: false,
            reasons: ["consumes billing-api@^1 (spec)"],
            owners: [],
            source: { path: "w" },
          },
          { id: "pricing", changed: false, reasons: ["provides prices"], owners: [], source: { path: "p" } },
        ],
        contracts: [
          { id: "billing-api", owner: "billing", change: "spec", consumers: [{ app: "web", version: "^1" }] },
          { id: "prices", owner: "pricing", change: "named", consumers: [] },
          { id: "events", owner: "billing", change: "implementation", consumers: [] },
        ],
        unmapped: [],
      },
      diffs: new Map([
        ["billing-api", "removed"],
        ["events", "compatible"],
      ]),
      breaking: new Set(["prices"]),
    });
    expect(a.contracts.map((c) => [c.id, c.change, c.why])).toEqual([
      ["billing-api", "breaking", "contract diff: removed"],
      ["prices", "breaking", "marked breaking for the task"],
      ["events", "compatible", "contract diff: compatible"],
    ]);
    expect(a.applications.map((x) => [x.id, x.roles])).toEqual([
      ["billing", ["changed", "provider"]],
      ["web", ["consumer"]],
      ["pricing", ["provider"]],
    ]);
    const unknown = analysisFrom({
      task: "t",
      map: "m",
      base: null,
      impact: {
        applications: [],
        contracts: [{ id: "x", owner: "o", change: "named", consumers: [] }],
        unmapped: [],
      },
      diffs: new Map([["x", "unclassified"]]),
      breaking: new Set(),
    });
    expect(unknown.contracts[0]?.change).toBe("unknown");
  });

  test("expand-contract drafts expand → migrate each consumer → contract, and lint accepts it", () => {
    const plan = draftSystemPlan({ id: "rename", analysis: analysis(), map: map(), by: "ana" });
    expect(shape(plan)).toEqual([
      ["billing-expand", ["expand"], []],
      ["web-migrate", ["migrate"], ["billing-expand"]],
      ["mail-migrate", ["migrate"], ["billing-expand"]],
      ["billing-contract", ["contract"], ["web-migrate", "mail-migrate"]],
    ]);
    expect([plan.strategies, plan.createdBy]).toEqual([
      [{ contract: "billing-api", strategy: "expand-contract" }],
      "ana",
    ]);
    expect(lintSystemPlan(plan, map(), analysis())).toEqual([]);
    expect(systemPlanWaves(plan)).toEqual([
      ["billing-expand"],
      ["web-migrate", "mail-migrate"],
      ["billing-contract"],
    ]);
  });

  test("versioned drafts bump → migrate; forbidden and compatibility none draft one change step", () => {
    const versioned = draftSystemPlan({ id: "v", analysis: analysis(), map: map("versioned") });
    expect(shape(versioned)).toEqual([
      ["billing-bump", ["bump"], []],
      ["web-migrate", ["migrate"], ["billing-bump"]],
      ["mail-migrate", ["migrate"], ["billing-bump"]],
    ]);
    expect(lintSystemPlan(versioned, map("versioned"), analysis())).toEqual([]);
    const forbidden = draftSystemPlan({ id: "f", analysis: analysis(), map: map("forbidden") });
    expect(shape(forbidden)).toEqual([["billing-change", ["change"], []]]);
    expect(errors(forbidden, map("forbidden"), analysis())).toEqual([
      "billing-api has a breaking change, and the map forbids breaking changes",
    ]);
    const none = analysis("breaking", {
      contracts: [{ id: "legacy", owner: "billing", change: "breaking", consumers: [] }],
    });
    expect(shape(draftSystemPlan({ id: "n", analysis: none, map: map() }))).toEqual([
      ["billing-change", ["change"], []],
    ]);
    expect(errors(draftSystemPlan({ id: "n", analysis: none, map: map() }), map(), none)).toEqual([]);
  });

  test("a compatible change: consumers that change too run after the provider (providers first)", () => {
    const a = analysis("compatible", {
      applications: [
        { id: "billing", roles: ["changed", "provider"], owners: [], files: [] },
        { id: "web", roles: ["changed", "consumer"], owners: [], files: [] },
      ],
    });
    const plan = draftSystemPlan({ id: "c", analysis: a, map: map() });
    expect(shape(plan)).toEqual([
      ["billing-change", ["change"], []],
      ["web-change", [], ["billing-change"]],
    ]);
    expect(lintSystemPlan(plan, map(), a)).toEqual([]);
    const reversed = { ...plan, steps: plan.steps.map((s) => ({ ...s, dependsOn: [] })) };
    expect(errors(reversed, map(), a)).toEqual([
      "web-change consumes billing-api and must run after billing-change (providers first)",
    ]);
    const unordered = { ...map(), policies: { ...map().policies, deployOrder: "none" as const } };
    expect(errors(reversed, unordered, a)).toEqual([]);
  });

  test("lint: a missing migration, order, strategy, unknown apps and steps, cycles, a changed approval", () => {
    const good = draftSystemPlan({ id: "rename", analysis: analysis(), map: map() });
    const without = (id: string) => ({
      ...good,
      steps: good.steps
        .filter((s) => s.id !== id)
        .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) })),
    });
    expect(errors(without("mail-migrate"), map(), analysis())).toEqual([
      "consumer mail of billing-api has no step that migrates it",
    ]);
    expect(errors(without("billing-expand"), map(), analysis())).toEqual([
      "billing-api needs a expand step in billing",
    ]);
    expect(
      lintSystemPlan(without("billing-contract"), map(), analysis()).map((p) => [p.severity, p.message]),
    ).toEqual([["warning", "billing-api: no contract step removes the old shape yet"]]);
    const early = {
      ...good,
      steps: good.steps.map((s) =>
        s.id === "web-migrate" || s.id === "billing-contract" ? { ...s, dependsOn: [] } : s,
      ),
    };
    expect(errors(early, map(), analysis())).toEqual([
      "web-migrate must run after billing-expand",
      "billing-contract must run after web-migrate: consumers move first",
      "billing-contract must run after mail-migrate: consumers move first",
    ]);
    // Order counts through other steps: web migrates after a flag step that follows the expand step.
    const flagged = {
      ...good,
      steps: [
        ...good.steps.map((s) => (s.id === "web-migrate" ? { ...s, dependsOn: ["billing-flag"] } : s)),
        {
          ...(good.steps[0] as SystemPlan["steps"][number]),
          id: "billing-flag",
          contracts: [],
          dependsOn: ["billing-expand"],
        },
      ],
    };
    expect(errors(flagged, map(), analysis())).toEqual([]);
    expect(errors({ ...good, strategies: [] }, map(), analysis())).toEqual([
      "the breaking change to billing-api needs a strategy (policy: expand-contract)",
    ]);
    expect(
      errors(
        { ...good, strategies: [{ contract: "billing-api", strategy: "versioned" }] },
        map(),
        analysis(),
      ),
    ).toContain("billing-api: strategy versioned, but the map's policy is expand-contract");
    const step = good.steps[0] as SystemPlan["steps"][number];
    expect(
      errors(
        {
          ...good,
          steps: [
            ...good.steps,
            {
              ...step,
              id: "ghost",
              app: "ghost",
              dependsOn: ["nope"],
              contracts: [{ id: "x", role: "change" }],
            },
            { ...step },
          ],
        },
        map(),
        analysis(),
      ),
    ).toEqual([
      "two steps are named billing-expand",
      "application ghost is not in the map",
      "depends on nope, which is not a step",
      "contract x is not in the map",
    ]);
    const cyclic = {
      ...good,
      steps: good.steps.map((s) =>
        s.id === "billing-expand" ? { ...s, dependsOn: ["billing-contract"] } : s,
      ),
    };
    expect(errors(cyclic, map(), analysis())).toEqual(["the steps depend on each other in a cycle"]);
    expect(systemPlanWaves(cyclic)).toBeUndefined();
    expect(errors({ ...good, steps: [] }, map(), analysis())).toEqual(["the plan has no steps"]);
    const approved = { ...good, approval: { by: "ana", at: "t", digest: systemPlanDigest(good) } };
    expect(errors(approved, map(), analysis())).toEqual([]);
    expect(errors({ ...approved, steps: approved.steps.slice(0, 3) }, map(), analysis())).toContain(
      "the steps changed after ana approved them; approve the plan again",
    );
    // Progress is not what an approval covers.
    const progressed = { ...approved, steps: approved.steps.map((s) => ({ ...s, status: "done" as const })) };
    expect(systemPlanDigest(progressed)).toBe(systemPlanDigest(good));
  });

  test("lint warnings: owners missing, an unneeded strategy, a changed application without a step", () => {
    const owners = SystemMapSchema.parse({
      ...map(),
      applications: map().applications.map((a) => (a.id === "web" ? { ...a, owners: [] } : a)),
    });
    const good = draftSystemPlan({ id: "rename", analysis: analysis(), map: owners });
    expect(lintSystemPlan(good, owners, analysis()).map((p) => p.message)).toEqual([
      "web has no owners in the map: nobody to review its step",
    ]);
    const compatible = analysis("compatible", {
      applications: [
        ...analysis().applications,
        { id: "pricing", roles: ["changed"], owners: [], files: [] },
      ],
    });
    expect(lintSystemPlan(good, map(), compatible).map((p) => p.message)).toEqual([
      "a strategy for billing-api, which the analysis does not call breaking",
      "pricing changes according to the analysis, but no step runs in it",
    ]);
  });
});

const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - { id: billing, source: { path: apps/billing }, owners: ["@b"] }
  - { id: web, source: { repo: ../web }, owners: ["@w"], consumes: [billing-api@^1] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
`;

function world() {
  const fs = new InMemoryFileSystem({ "docs/metator/system.yml": MAP });
  const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/src/shop");
  const store = new SystemPlanStore(fs, "metator/system/plans");
  const impact = {
    calls: [] as unknown[],
    execute: async (input: unknown) => {
      impact.calls.push(input);
      return ok({
        map: "docs/metator/system.yml",
        self: ["billing"],
        base: "HEAD",
        applications: [
          {
            id: "billing",
            changed: false,
            reasons: ["provides billing-api"],
            owners: ["@b"],
            source: { path: "apps/billing" },
          },
          {
            id: "web",
            changed: false,
            reasons: ["consumes billing-api@^1 (named)"],
            owners: ["@w"],
            source: { repo: "../web" },
          },
        ],
        contracts: [
          {
            id: "billing-api",
            owner: "billing",
            change: "named" as const,
            consumers: [{ app: "web", version: "^1" }],
          },
        ],
        unmapped: [],
      });
    },
  };
  const diff = {
    execute: async () => ok({ map: "m", base: "HEAD", contracts: [], failing: [], notCompared: [] }),
  };
  const analyze = new AnalyzeSystem(impact, diff, store);
  const create = new CreateSystemPlan(analyze, location, store);
  const lint = new LintSystemPlan(location, store);
  const clock = { now: () => new Date("2026-10-29T10:00:00Z") };
  return { fs, store, impact, analyze, create, lint, approve: new ApproveSystemPlan(lint, store, clock) };
}

describe("loopholes the review found", () => {
  test("an analysis that drops a consumer hides nothing: consumers come from the map", () => {
    const plan = draftSystemPlan({ id: "rename", analysis: analysis(), map: map() });
    const blind = analysis("breaking", {
      contracts: [{ id: "billing-api", owner: "billing", change: "breaking", consumers: [] }],
    });
    const withoutMail = {
      ...plan,
      steps: plan.steps
        .filter((s) => s.id !== "mail-migrate")
        .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== "mail-migrate") })),
    };
    expect(errors(withoutMail, map(), blind)).toEqual([
      "consumer mail of billing-api has no step that migrates it",
    ]);
    // A strategy alone makes the contract breaking, whatever the analysis says.
    expect(errors(withoutMail, map(), analysis("compatible"))).toContain(
      "consumer mail of billing-api has no step that migrates it",
    );
  });

  test("only the provider bumps, expands or contracts its contract", () => {
    const plan = draftSystemPlan({ id: "v", analysis: analysis(), map: map("versioned") });
    const moved = {
      ...plan,
      steps: plan.steps.map((s) => (s.id === "billing-bump" ? { ...s, id: "web-bump", app: "web" } : s)),
    };
    const fixed = {
      ...moved,
      steps: moved.steps.map((s) => ({
        ...s,
        dependsOn: s.dependsOn.map((d) => (d === "billing-bump" ? "web-bump" : d)),
      })),
    };
    expect(errors(fixed, map("versioned"), analysis())).toEqual([
      "billing-api needs a bump step in billing",
      "web-bump: only billing can bump billing-api",
    ]);
  });

  test("the approval covers what a child run is told: its summary, deploy and the task", () => {
    const plan = draftSystemPlan({ id: "rename", analysis: analysis(), map: map() });
    const digest = systemPlanDigest(plan);
    const reworded = {
      ...plan,
      steps: plan.steps.map((s, i) => (i === 0 ? { ...s, summary: "Drop the database" } : s)),
    };
    const flagged = {
      ...plan,
      steps: plan.steps.map((s, i) => (i === 0 ? { ...s, deploy: { flag: "x" } } : s)),
    };
    expect([
      systemPlanDigest(reworded),
      systemPlanDigest(flagged),
      systemPlanDigest({ ...plan, task: "Other" }),
    ]).not.toContain(digest);
    const stale = lintSystemPlan(
      { ...reworded, approval: { by: "ana", at: "t", digest } },
      map(),
      analysis(),
    );
    expect(stale.map((p) => [p.code, p.severity])).toEqual([["stale-approval", "error"]]);
  });

  test("the gate's exception: the provider's breaking step, after its dependencies, in an unchanged approved plan", () => {
    const draft = draftSystemPlan({ id: "rename", analysis: analysis(), map: map() });
    const approved = {
      ...draft,
      status: "approved" as const,
      approval: { by: "ana", at: "t", digest: systemPlanDigest(draft) },
    };
    const done = (ids: string[]) => ({
      ...approved,
      steps: approved.steps.map((s) => (ids.includes(s.id) ? { ...s, status: "done" as const } : s)),
    });
    expect(breakingAllowance(approved, "billing-api", "billing")).toBeUndefined();
    expect(
      breakingAllowance(done(["billing-expand", "web-migrate", "mail-migrate"]), "billing-api", "billing"),
    ).toBe("planned in system plan rename (step billing-contract, approved by ana)");
    expect(
      breakingAllowance(done(["billing-expand", "web-migrate", "mail-migrate"]), "billing-api", "web"),
    ).toBeUndefined();
    expect(
      breakingAllowance(
        { ...done(["billing-expand", "web-migrate", "mail-migrate"]), status: "draft" },
        "billing-api",
        "billing",
      ),
    ).toBeUndefined();
  });
});

describe("system plan use cases", () => {
  test("analyze saves the analysis; new drafts from it; lint, approve and the gate's exception", async () => {
    const w = world();
    const made = (
      await w.analyze.execute({ task: "Rename refunds", breaking: ["billing-api"] })
    )._unsafeUnwrap();
    expect([made.id, made.file]).toEqual([
      "rename-refunds",
      "metator/system/plans/rename-refunds.analysis.yml",
    ]);
    expect(w.impact.calls).toEqual([{ base: "HEAD", contracts: ["billing-api"] }]);
    expect(made.analysis.contracts[0]?.change).toBe("breaking");
    const plan = (await w.create.execute({ task: "Rename refunds", by: "ana" }))._unsafeUnwrap();
    expect(plan.steps.map((s) => s.id)).toEqual(["billing-expand", "web-migrate", "billing-contract"]);
    expect(w.impact.calls).toHaveLength(1); // the saved analysis is reused
    expect((await w.create.execute({ task: "Rename refunds" }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect((await w.lint.execute("rename-refunds"))._unsafeUnwrap().problems).toEqual([]);
    const allowance = new PlannedBreakingChanges(w.store);
    expect((await allowance.allows("billing-api", "billing"))._unsafeUnwrap()).toBeUndefined();
    const approved = (await w.approve.execute({ id: "rename-refunds", by: "ana" }))._unsafeUnwrap();
    expect([approved.status, approved.approval?.at]).toEqual(["approved", "2026-10-29T10:00:00.000Z"]);
    // Approved, but the consumers have not migrated: the old shape cannot go yet.
    expect((await allowance.allows("billing-api", "billing"))._unsafeUnwrap()).toBeUndefined();
    await w.store.save({
      ...approved,
      steps: approved.steps.map((s) => (s.id === "billing-contract" ? s : { ...s, status: "done" })),
    });
    expect((await allowance.allows("billing-api", "billing"))._unsafeUnwrap()).toBe(
      "planned in system plan rename-refunds (step billing-contract, approved by ana)",
    );
    expect((await allowance.allows("other", "billing"))._unsafeUnwrap()).toBeUndefined();
    // A plan edited after its approval allows nothing.
    await w.store.save({ ...approved, steps: approved.steps.slice(1).map((s) => ({ ...s, dependsOn: [] })) });
    expect((await allowance.allows("billing-api", "billing"))._unsafeUnwrap()).toBeUndefined();
    expect((await w.store.list())._unsafeUnwrap().map((p) => p.id)).toEqual(["rename-refunds"]);
  });

  test("approve refuses a plan lint rejects and a plan already running; missing plans are NOT_FOUND", async () => {
    const w = world();
    await w.create.execute({ task: "Rename refunds", breaking: ["billing-api"] });
    const plan = (await w.store.load("rename-refunds"))._unsafeUnwrap();
    await w.store.save({ ...plan, steps: plan.steps.filter((s) => s.id !== "web-migrate") });
    const refused = (await w.approve.execute({ id: "rename-refunds", by: "ana" }))._unsafeUnwrapErr();
    expect([refused.code, refused.message]).toEqual([
      "CHECK_FAILED",
      "rename-refunds: 1 lint error(s); fix them before approving",
    ]);
    await w.store.save({ ...plan, status: "running" });
    expect((await w.approve.execute({ id: "rename-refunds", by: "ana" }))._unsafeUnwrapErr().code).toBe(
      "USAGE",
    );
    expect((await w.lint.execute("ghost"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    await w.fs.remove("metator/system/plans/rename-refunds.analysis.yml");
    // Without an analysis nobody said what breaks: lint fails, so the plan cannot be approved.
    expect((await w.lint.execute("rename-refunds"))._unsafeUnwrap().problems.map((p) => p.severity)).toEqual([
      "error",
    ]);
  });

  test("propose: the agents may read every application's checkout on this machine", async () => {
    const w = world();
    const host = new FakeAgentHost({});
    const propose = new ProposeSystemPlan(
      new Map([["scenario", host]]),
      w.analyze,
      w.create,
      w.lint,
      w.store,
      async () => ["/r", "/folder/frontend", "/folder/frontend"],
    );
    await propose.execute({
      task: "Rename refunds",
      breaking: ["billing-api"],
      host: "scenario",
      by: "ana",
      cwd: "/r",
      projectRoot: "/r",
    });
    expect(host.tasks.map((t) => t.dirs)).toEqual([["/folder/frontend"], ["/folder/frontend"]]);
  });

  test("propose: the scout checks the analysis, the planner refines the draft, then lint", async () => {
    const w = world();
    const host = new FakeAgentHost({
      "mt-system-planner": [
        {
          effect: async () => {
            const draft = (await w.store.load("rename-refunds"))._unsafeUnwrap();
            // An agent that also "approves" its own plan: the tool drops that.
            await w.store.save({
              ...draft,
              status: "approved",
              approval: { by: "mt-system-planner", at: "t", digest: "forged" },
              steps: draft.steps.map((s) => ({ ...s, summary: `${s.summary} (refined)` })),
            });
          },
        },
      ],
    });
    const propose = new ProposeSystemPlan(
      new Map([["scenario", host]]),
      w.analyze,
      w.create,
      w.lint,
      w.store,
    );
    const input = {
      task: "Rename refunds",
      breaking: ["billing-api"],
      host: "scenario",
      by: "ana",
      cwd: "/r",
      projectRoot: "/r",
    };
    const r = (await propose.execute(input))._unsafeUnwrap();
    expect(host.tasks.map((t) => t.agent)).toEqual(["mt-system-scout", "mt-system-planner"]);
    expect(host.tasks[0]?.prompt).toContain("metator/system/plans/rename-refunds.analysis.yml");
    expect(host.tasks[1]?.prompt).toContain("metator/system/plans/rename-refunds.yml");
    expect([r.plan.status, r.plan.approval]).toEqual(["draft", undefined]);
    expect([r.problems, r.plan.steps[0]?.summary]).toEqual([
      [],
      "Add the new shape of billing-api beside the old one (refined)",
    ]);
    // Without the other repositories' checkouts, the agents may read only this one.
    expect(host.tasks[0]?.dirs).toBeUndefined();
    expect((await propose.execute({ ...input, host: "nope" }))._unsafeUnwrapErr().message).toBe(
      "unknown host nope",
    );
    const failing = new FakeAgentHost({ "mt-system-scout": [{ ok: false }] });
    const stopped = new ProposeSystemPlan(
      new Map([["scenario", failing]]),
      w.analyze,
      w.create,
      w.lint,
      w.store,
    );
    expect((await stopped.execute(input))._unsafeUnwrapErr().message).toBe(
      "scenario: mt-system-scout stopped without a result",
    );
  });
});
