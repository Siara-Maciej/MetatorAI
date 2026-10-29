import { describe, expect, test } from "bun:test";
import { DEFAULT_TEST_GLOBS } from "../src/application/paths.ts";
import { lintPlan, type Plan, PlanDocument, type PlanFacts, planScope } from "../src/domain/plan.ts";

const SRC = "packages/billing/src";
const TEST = "packages/billing/test";

const facts = (extra: Partial<PlanFacts> = {}): PlanFacts => ({
  files: new Set([
    `${SRC}/invoice.ts`,
    `${SRC}/money.ts`,
    `${SRC}/legacy.ts`,
    "packages/orders/src/order.mapper.ts",
  ]),
  patterns: new Map([["mapper", new Set(["packages/orders/src/order.mapper.ts"])]]),
  rules: new Set(["MT-ARCH-001"]),
  imports: [{ from: `${SRC}/invoice.ts`, to: `${SRC}/money.ts` }],
  testGlobs: DEFAULT_TEST_GLOBS,
  ...extra,
});

/** A healthy plan: test first, a mapper from an exemplar, the importer after what it imports. */
const healthy = (): Plan =>
  PlanDocument.parse(
    {
      kind: "Plan",
      schemaVersion: 1,
      task: "Invoices in foreign currencies",
      scope: ["packages/billing/**"],
      steps: [
        { id: "S1", action: "create", path: `${TEST}/invoice.mapper.test.ts`, intent: "mapper spec" },
        {
          id: "S2",
          action: "create",
          path: `${SRC}/invoice.mapper.ts`,
          intent: "map invoices",
          patternSource: {
            pattern: "mapper",
            exemplar: "packages/orders/src/order.mapper.ts:8",
            reason: "same shape",
          },
          rules: ["MT-ARCH-001"],
          testsFirst: [`${TEST}/invoice.mapper.test.ts`],
          dependsOn: ["S1"],
        },
        { id: "S3", action: "modify", path: `${TEST}/money.test.ts`, intent: "currency cases" },
        {
          id: "S4",
          action: "modify",
          path: `${SRC}/money.ts`,
          intent: "currencies",
          testsFirst: [`${TEST}/money.test.ts`],
          dependsOn: ["S3"],
        },
        {
          id: "S5",
          action: "modify",
          path: `${SRC}/invoice.ts`,
          intent: "use the mapper",
          testsFirst: [`${TEST}/invoice.mapper.test.ts`],
          dependsOn: ["S2", "S4"],
        },
      ],
    },
    "plan.json",
  )._unsafeUnwrap();

const withSteps = (edit: (steps: Plan["steps"]) => Plan["steps"]): Plan => {
  const plan = healthy();
  return { ...plan, steps: edit(plan.steps.map((s) => ({ ...s }))) };
};
const FACTS = facts({ files: new Set([...facts().files, `${TEST}/money.test.ts`]) });
const messages = (plan: Plan) =>
  lintPlan(plan, FACTS).problems.map((p) => `${p.step ?? "-"} ${p.severity}: ${p.message}`);

describe("lintPlan", () => {
  test("a healthy plan has no problems", () => {
    expect(lintPlan(healthy(), FACTS)).toEqual({ steps: 5, problems: [], adrRequired: [] });
  });

  test("step ids: duplicates, unknown and self dependencies, cycles", () => {
    const plan = withSteps((steps) => {
      (steps[0] as { dependsOn: string[] }).dependsOn = ["S2", "S9", "S1"];
      return [...steps, { ...(steps[2] as Plan["steps"][number]), path: `${TEST}/other.test.ts` }];
    });
    expect(messages(plan)).toEqual([
      "S3 error: duplicate step id S3",
      "S1 error: depends on unknown step S9",
      "S1 error: depends on itself",
      "- error: steps depend on each other: S1, S2",
      `S3 error: ${TEST}/other.test.ts does not exist`,
    ]);
  });

  test("scope, unknown rules and file existence", () => {
    const plan = withSteps((steps) => [
      ...steps.slice(0, 4),
      { ...(steps[4] as Plan["steps"][number]), rules: ["MT-NOPE-001"] },
      {
        id: "S6",
        action: "modify",
        path: "packages/orders/src/order.ts",
        intent: "x",
        rules: [],
        testsFirst: [],
        dependsOn: [],
      },
      {
        id: "S7",
        action: "create",
        path: `${SRC}/legacy.ts`,
        intent: "x",
        rules: [],
        testsFirst: [],
        dependsOn: [],
      },
    ]);
    const out = messages(plan);
    expect(out).toContain("S5 error: unknown rule MT-NOPE-001");
    expect(out).toContain("S6 error: packages/orders/src/order.ts is outside the task scope");
    expect(out).toContain("S6 error: packages/orders/src/order.ts does not exist");
    expect(out).toContain(`S7 error: ${SRC}/legacy.ts already exists; modify it instead`);
  });

  test("a created file needs an exemplar that the pattern index knows, or an ADR for a new pattern", () => {
    const step = (patch: Record<string, unknown>) =>
      withSteps((steps) => {
        const { patternSource: _p, ...rest } = steps[1] as Plan["steps"][number];
        steps[1] = { ...rest, ...patch } as Plan["steps"][number];
        return steps;
      });
    expect(messages(step({}))).toEqual([
      "S2 error: a created file needs patternSource (an exemplar) or newPatternAdr",
    ]);
    expect(messages(step({ patternSource: { pattern: "repo", exemplar: "a.ts:1", reason: "r" } }))).toEqual([
      "S2 error: pattern repo is not in the pattern index",
    ]);
    expect(
      messages(step({ patternSource: { pattern: "mapper", exemplar: `${SRC}/money.ts:3`, reason: "r" } })),
    ).toEqual([`S2 error: ${SRC}/money.ts is not an occurrence of pattern mapper`]);
    const adr = lintPlan(step({ newPatternAdr: "docs/adr/0099-mapper-v2.md" }), FACTS);
    expect([adr.adrRequired, adr.problems.map((p) => p.severity)]).toEqual([["S2"], ["warning"]]);
    expect(
      messages(
        step({
          newPatternAdr: "docs/adr/0099.md",
          patternSource: {
            pattern: "mapper",
            exemplar: "packages/orders/src/order.mapper.ts:8",
            reason: "r",
          },
        }),
      )[0],
    ).toBe("S2 error: use patternSource or newPatternAdr, not both");
  });

  test("without a pattern catalog an exemplar only has to exist (a warning says so)", () => {
    const none = facts({ files: FACTS.files, patterns: new Map() });
    const lintNone = (exemplar: string) =>
      lintPlan(
        withSteps((steps) => {
          steps[1] = {
            ...(steps[1] as Plan["steps"][number]),
            patternSource: { pattern: "formatter", exemplar, reason: "r" },
          };
          return steps;
        }),
        none,
      ).problems.map((p) => `${p.step} ${p.severity}: ${p.message}`);
    expect(lintNone(`${SRC}/money.ts:3`)).toEqual([
      `S2 warning: no pattern catalog: ${SRC}/money.ts is checked to exist, not to be an occurrence of formatter`,
    ]);
    expect(lintNone("packages/nope/x.ts:1")).toEqual([
      "S2 error: exemplar packages/nope/x.ts does not exist",
    ]);
  });

  test("code needs its tests first, written by a step it depends on", () => {
    const plan = withSteps((steps) => {
      (steps[1] as { dependsOn: string[] }).dependsOn = [];
      (steps[3] as { testsFirst: string[] }).testsFirst = [];
      (steps[4] as { testsFirst: string[] }).testsFirst = [`${SRC}/money.ts`];
      return steps;
    });
    expect(messages(plan)).toEqual([
      `S2 error: ${TEST}/invoice.mapper.test.ts must be written by a step this one depends on`,
      "S4 error: code changes need testsFirst (the tests written before it)",
      `S5 error: ${SRC}/money.ts is not a test file`,
    ]);
  });

  test("an importer runs after the files it imports; transitive order is enough", () => {
    const direct = withSteps((steps) => {
      (steps[4] as { dependsOn: string[] }).dependsOn = ["S2", "S3"];
      return steps;
    });
    expect(messages(direct)).toEqual([`S5 error: ${SRC}/invoice.ts imports ${SRC}/money.ts: depend on S4`]);
    const transitive = withSteps((steps) => {
      (steps[1] as { dependsOn: string[] }).dependsOn = ["S1", "S4"];
      (steps[4] as { dependsOn: string[] }).dependsOn = ["S2"];
      return steps;
    });
    expect(messages(transitive)).toEqual([]);
  });

  test("a test that imports the code it tests still comes first", () => {
    const f = {
      ...FACTS,
      imports: [...FACTS.imports, { from: `${TEST}/money.test.ts`, to: `${SRC}/money.ts` }],
    };
    expect(lintPlan(healthy(), f).problems).toEqual([]);
  });

  test("deleting a file that is still imported is an error unless the importer changes too", () => {
    const del = (keepImporter: boolean) =>
      withSteps((steps) => [
        ...steps.slice(0, 3),
        { ...(steps[3] as Plan["steps"][number]), action: "delete", testsFirst: [] },
        ...(keepImporter ? [steps[4] as Plan["steps"][number]] : []),
      ]);
    expect(messages(del(true))).toEqual([]);
    expect(messages(del(false))).toEqual([
      `S4 error: ${SRC}/invoice.ts still imports ${SRC}/money.ts; modify or delete it in the plan`,
    ]);
  });

  test("two steps on one file are a warning", () => {
    const plan = withSteps((steps) => [
      ...steps,
      {
        id: "S6",
        action: "modify",
        path: `${TEST}/money.test.ts`,
        intent: "more",
        rules: [],
        testsFirst: [],
        dependsOn: ["S3"],
      },
    ]);
    expect(messages(plan)).toEqual([`S6 warning: ${TEST}/money.test.ts is in steps S3, S6; merge them`]);
  });

  test("the document rejects unknown fields and actions", () => {
    const raw = {
      kind: "Plan",
      schemaVersion: 1,
      task: "t",
      scope: ["**"],
      steps: [{ id: "S1", action: "rename", path: "a", intent: "x" }],
    };
    expect(PlanDocument.parse(raw, "plan.json")._unsafeUnwrapErr().code).toBe("INVALID_ARTIFACT");
  });
});

describe("planScope", () => {
  test("edit scope lists every step file and test; shards have no edges between them", () => {
    const plan = withSteps((steps) => [
      ...steps,
      {
        id: "S6",
        action: "create",
        path: "packages/billing/docs/README.md",
        intent: "docs",
        rules: [],
        testsFirst: [],
        dependsOn: [],
      },
    ]);
    const scope = planScope(plan, ".metator/runs/r1/plan.json", FACTS.imports);
    expect(scope.edit).toEqual([
      "packages/billing/docs/README.md",
      `${SRC}/invoice.mapper.ts`,
      `${SRC}/invoice.ts`,
      `${SRC}/money.ts`,
      `${TEST}/invoice.mapper.test.ts`,
      `${TEST}/money.test.ts`,
    ]);
    expect(scope.shards.map((s) => [s.id, s.steps])).toEqual([
      ["shard-1", ["S1", "S2", "S3", "S4", "S5"]],
      ["shard-2", ["S6"]],
    ]);
  });

  test("without dependencies, an import edge or a shared file keeps steps together", () => {
    const plan = withSteps((steps) =>
      steps.map((s) => ({ ...s, dependsOn: [] })).filter((s) => ["S1", "S2", "S4", "S5"].includes(s.id)),
    );
    expect(planScope(plan, "p", []).shards.map((s) => s.steps)).toEqual([["S1", "S2", "S5"], ["S4"]]);
    expect(planScope(plan, "p", FACTS.imports).shards.map((s) => s.steps)).toEqual([
      ["S1", "S2", "S4", "S5"],
    ]);
  });
});
