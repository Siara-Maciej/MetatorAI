import { describe, expect, test } from "bun:test";
import { type Issue, IssueDocument, type Snapshot } from "../src/domain/issue.ts";
import {
  backlogFromPlan,
  citedPaths,
  type Freshness,
  freshnessOf,
  issueViews,
  planCites,
  planSummary,
  settledParents,
  systemPlanSummary,
} from "../src/domain/issue-snapshot.ts";
import type { Plan } from "../src/domain/plan.ts";
import type { SystemPlan } from "../src/domain/system-plan.ts";

const AT = "2026-11-10T09:00:00.000Z";
const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
  id,
  title: `Task ${id}`,
  body: "",
  status: "open",
  priority: "normal",
  labels: [],
  refs: [],
  dependsOn: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

describe("Issue v3 (ADR-0096)", () => {
  test("a v2 file reads as v3 with no dependencies; v3 keeps analysis, plan, parent, step and thread", () => {
    const v2 = {
      kind: "Issue",
      schemaVersion: 2,
      ...issue("i001"),
    } as Record<string, unknown>;
    delete v2.dependsOn;
    expect(IssueDocument.parse(v2, "i001.json")._unsafeUnwrap().dependsOn).toEqual([]);
    const snapshot: Snapshot = {
      file: ".metator/issues/i002/analysis.md",
      at: AT,
      commit: "abc123",
      cites: [{ path: "src/a.ts", sha256: "f".repeat(64) }],
      packages: ["shop"],
    };
    const v3 = issue("i002", {
      threadId: "20261122-prices",
      parent: "i001",
      dependsOn: ["i003"],
      analysis: snapshot,
      plan: {
        ...snapshot,
        file: ".metator/issues/i002/plan.json",
        runId: "20261122-mt-feature-x",
        kind: "plan",
      },
      step: { runId: "20261122-mt-system-change-x", plan: "x", stepId: "billing-change" },
    });
    const stamped = IssueDocument.stamp(v3);
    expect(stamped.schemaVersion).toBe(3);
    expect(IssueDocument.parse(JSON.parse(JSON.stringify(stamped)), "i002.json")._unsafeUnwrap()).toEqual(v3);
  });
});

describe("citations", () => {
  test("path:line references in an agent's text, repository-relative and unique; never a URL or an absolute path", () => {
    const text = [
      "Prices round in `packages/core/src/price.ts:12` and src/invoice.ts:40-44.",
      "See (src/invoice.ts:7), README.md:3 and https://example.com/a.ts:80.",
      "Not /etc/passwd:1, not ../outside.ts:2, not a time 10:30.",
    ].join("\n");
    expect(citedPaths(text)).toEqual(["packages/core/src/price.ts", "src/invoice.ts", "README.md"]);
  });

  test("a plan cites its step files, their tests first, and its exemplars", () => {
    const plan: Plan = {
      task: "Round",
      scope: ["src/**"],
      steps: [
        {
          id: "S1",
          action: "modify",
          path: "src/price.ts",
          intent: "round half up as in src/money.ts:4",
          rules: [],
          testsFirst: ["test/price.test.ts"],
          dependsOn: [],
          patternSource: { pattern: "util", exemplar: "src/util.ts:3", reason: "same" },
        },
      ],
    };
    expect(planCites(plan)).toEqual(["src/price.ts", "test/price.test.ts", "src/util.ts", "src/money.ts"]);
  });
});

describe("freshness: one result per snapshot", () => {
  const snapshot: Snapshot = {
    file: ".metator/issues/i001/analysis.md",
    at: AT,
    commit: "abc",
    cites: [
      { path: "packages/core/src/price.ts", sha256: "h1" },
      { path: "packages/core/src/gone.ts", sha256: "h2" },
    ],
    packages: ["@shop/core"],
  };
  const hashes = (m: Record<string, string>) => (path: string) => m[path] ?? "";
  const base = {
    snapshot,
    packageDirs: ["packages/core"],
    now: new Date("2026-11-12T09:00:00.000Z"),
    staleDays: 14,
  };

  test("fresh: every cited file as it was and nothing in its packages changed", () => {
    const fresh = freshnessOf({
      ...base,
      hash: hashes({ "packages/core/src/price.ts": "h1", "packages/core/src/gone.ts": "h2" }),
      changed: ["packages/web/src/app.ts", "README.md"],
    });
    expect(fresh).toEqual({ state: "fresh" });
  });

  test("stale: a cited file's content changed or it is gone, or another file of its package changed", () => {
    const stale = freshnessOf({
      ...base,
      hash: hashes({ "packages/core/src/price.ts": "h9" }),
      changed: ["packages/core/src/other.ts", "packages/web/x.ts"],
    });
    expect(stale).toEqual({
      state: "stale",
      changed: ["packages/core/src/gone.ts", "packages/core/src/other.ts", "packages/core/src/price.ts"],
    });
  });

  test("a file of the package that had changed already when the snapshot was made counts only once it changes again", () => {
    const dirty: Snapshot = { ...snapshot, dirty: [{ path: "packages/core/src/wip.ts", sha256: "w1" }] };
    const hash = hashes({
      "packages/core/src/price.ts": "h1",
      "packages/core/src/gone.ts": "h2",
      "packages/core/src/wip.ts": "w1",
    });
    expect(freshnessOf({ ...base, snapshot: dirty, hash, changed: ["packages/core/src/wip.ts"] })).toEqual({
      state: "fresh",
    });
    // Edited again, or put back as it was in the commit: both are changes since the snapshot.
    expect(
      freshnessOf({
        ...base,
        snapshot: dirty,
        hash: (p) => (p.endsWith("wip.ts") ? "w2" : hash(p)),
        changed: ["packages/core/src/wip.ts"],
      }),
    ).toEqual({ state: "stale", changed: ["packages/core/src/wip.ts"] });
    expect(freshnessOf({ ...base, snapshot: dirty, hash, changed: [] })).toEqual({
      state: "stale",
      changed: ["packages/core/src/wip.ts"],
    });
  });

  test("a package at the repository's root holds every file", () => {
    const root = freshnessOf({
      ...base,
      packageDirs: ["."],
      hash: hashes({ "packages/core/src/price.ts": "h1", "packages/core/src/gone.ts": "h2" }),
      changed: ["docs/a.md"],
    });
    expect(root).toEqual({ state: "stale", changed: ["docs/a.md"] });
  });

  test("old: past backlog.staleDays only a warning, in whole days; stale wins", () => {
    const hash = hashes({ "packages/core/src/price.ts": "h1", "packages/core/src/gone.ts": "h2" });
    const later = new Date("2026-11-24T09:00:00.000Z");
    expect(freshnessOf({ ...base, hash, changed: [], now: later })).toEqual({
      state: "fresh",
    } satisfies Freshness);
    expect(freshnessOf({ ...base, hash, changed: [], now: new Date("2026-11-24T09:00:01.000Z") })).toEqual({
      state: "old",
      days: 14,
    });
    expect(freshnessOf({ ...base, hash, changed: ["packages/core/x.ts"], now: later }).state).toBe("stale");
  });
});

describe("a Backlog item from a plan", () => {
  const system: SystemPlan = {
    id: "prices",
    task: "Prices in the customer's currency",
    status: "approved",
    strategies: [],
    steps: [
      {
        id: "billing-change",
        app: "billing",
        summary: "Add exchange rates",
        contracts: [],
        dependsOn: [],
        status: "pending",
      },
      {
        id: "shop-change",
        app: "shop",
        summary: "Price in currency",
        contracts: [],
        dependsOn: ["billing-change"],
        status: "pending",
      },
    ],
  };

  test("a system plan: a parent and one child per step, dependencies mapped from the steps", () => {
    const made = backlogFromPlan({
      ids: ["i004", "i005", "i006"],
      runId: "20261122-mt-system-change-prices",
      title: system.task,
      body: systemPlanSummary(system),
      system,
    });
    expect(made.parent).toEqual({ id: "i004", title: system.task, body: systemPlanSummary(system) });
    expect(made.children).toEqual([
      {
        id: "i005",
        title: "Add exchange rates",
        body: "Step billing-change of system plan prices, in billing.",
        parent: "i004",
        dependsOn: [],
        step: { runId: "20261122-mt-system-change-prices", plan: "prices", stepId: "billing-change" },
      },
      {
        id: "i006",
        title: "Price in currency",
        body: "Step shop-change of system plan prices, in shop. After billing-change.",
        parent: "i004",
        dependsOn: ["i005"],
        step: { runId: "20261122-mt-system-change-prices", plan: "prices", stepId: "shop-change" },
      },
    ]);
  });

  test("a single-repository plan has no phases: the parent alone", () => {
    const made = backlogFromPlan({ ids: ["i001"], runId: "r", title: "Round", body: "b" });
    expect(made.children).toEqual([]);
  });

  test("summaries: the task, then one line per step", () => {
    expect(systemPlanSummary(system)).toBe(
      "Prices in the customer's currency\n\n- billing-change (billing): Add exchange rates\n- shop-change (shop): Price in currency (after billing-change)\n",
    );
    const plan: Plan = {
      task: "Round prices",
      scope: ["src/**"],
      steps: [
        {
          id: "S1",
          action: "modify",
          path: "src/price.ts",
          intent: "round half up",
          rules: [],
          testsFirst: [],
          dependsOn: [],
        },
      ],
    };
    expect(planSummary(plan)).toBe("Round prices\n\n- S1 modify src/price.ts: round half up\n");
  });
});

describe("parents and children", () => {
  test("a parent is done once every child is done or dropped (dropped counts as done)", () => {
    const items = [
      issue("i001"),
      issue("i002", { parent: "i001", status: "done" }),
      issue("i003", { parent: "i001", status: "dropped" }),
      issue("i004"),
      issue("i005", { parent: "i004", status: "done" }),
      issue("i006", { parent: "i004", status: "open" }),
      issue("i007", { status: "dropped" }),
      issue("i008", { parent: "i007", status: "done" }),
    ];
    // i007 was dropped by a person: it stays dropped.
    expect(settledParents(items)).toEqual(["i001"]);
  });

  test("the views: children, what each waits for (the shared rule), a parent's progress", () => {
    const items = [
      issue("i001"),
      issue("i002", { parent: "i001", status: "done" }),
      issue("i003", { parent: "i001", dependsOn: ["i002"] }),
      issue("i004", { parent: "i001", dependsOn: ["i003", "i002"] }),
    ];
    const views = issueViews(items);
    expect(views.map((v) => [v.id, v.children, v.waitsFor, v.progress])).toEqual([
      ["i001", ["i002", "i003", "i004"], [], { done: 1, of: 3 }],
      ["i002", [], [], undefined],
      ["i003", [], [], undefined],
      ["i004", [], ["i003"], undefined],
    ]);
  });
});
