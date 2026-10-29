import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { stringify } from "yaml";
import { DEFAULT_PATHS, DEFAULT_TEST_GLOBS } from "../src/application/paths.ts";
import { LintPlan, ScopePlan } from "../src/application/plans.ts";
import { RuleCatalog } from "../src/application/rules.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const RUN = ".metator/runs/r1";
const PLAN = {
  kind: "Plan",
  schemaVersion: 1,
  task: "mapper",
  scope: ["src/**"],
  steps: [
    { id: "S1", action: "create", path: "src/a.mapper.test.ts", intent: "spec" },
    {
      id: "S2",
      action: "create",
      path: "src/a.mapper.ts",
      intent: "mapper",
      patternSource: { pattern: "mapper", exemplar: "src/b.mapper.ts:1", reason: "same" },
      rules: ["ACME-ARCH-001"],
      testsFirst: ["src/a.mapper.test.ts"],
      dependsOn: ["S1"],
    },
    { id: "S3", action: "modify", path: "src/use.test.ts", intent: "cases" },
    {
      id: "S4",
      action: "modify",
      path: "src/use.ts",
      intent: "use it",
      testsFirst: ["src/use.test.ts"],
      dependsOn: ["S2", "S3"],
    },
  ],
};
const RULES = stringify({
  kind: "RuleSet",
  schemaVersion: 1,
  area: "ARCH",
  rules: [
    {
      id: "ACME-ARCH-001",
      title: "Mappers are pure",
      applyTo: ["src/**"],
      enforcement: "E3",
      summary: "No I/O in mappers.",
      rationale: "README.md",
      source: { ref: "README.md", verified: "2026-10-26" },
    },
  ],
});

const fs = (plan: object = PLAN) =>
  new InMemoryFileSystem({
    [`${RUN}/plan.json`]: JSON.stringify(plan),
    "src/b.mapper.ts": "export function toB() {}\n",
    "src/use.ts": 'import "./a.mapper.ts";\n',
    "src/use.test.ts": 'import "./use.ts";\n',
    [`${DEFAULT_PATHS.rules}/arch.yml`]: RULES,
  });
const patterns = (files: string[]) => ({
  execute: async () =>
    ok({
      patterns: [
        {
          id: "mapper",
          title: "",
          intent: "",
          exemplar: files[0] ?? "",
          occurrences: files.map((file) => ({ file, line: 1 })),
          byPackage: {},
          legacy: [],
        },
      ],
      problems: [],
    }),
});
const graph = (edges: { from: string; to: string }[]) => ({
  execute: async () =>
    ok({
      files: [],
      edges: edges.map((e) => ({ ...e, kind: "internal" as const })),
      packages: [],
      externals: [],
      externalUses: [],
      imports: [],
      unresolved: [],
      stats: { parsed: 0, reused: 0, failed: 0 },
      parseErrors: [],
    }),
});
const lint = (
  files: InMemoryFileSystem,
  occurrences = ["src/b.mapper.ts"],
  edges = [{ from: "src/use.ts", to: "src/a.mapper.ts" }],
) =>
  new LintPlan(
    files,
    patterns(occurrences),
    new RuleCatalog(files, DEFAULT_PATHS),
    graph(edges),
    DEFAULT_TEST_GLOBS,
  );

describe("LintPlan", () => {
  test("reads the plan and checks it against files, patterns, rules and imports", async () => {
    expect((await lint(fs()).execute({ file: `${RUN}/plan.json` }))._unsafeUnwrap()).toEqual({
      steps: 4,
      problems: [],
      adrRequired: [],
    });
  });

  test("facts come from the repository: occurrences, existing files, canon rules, import edges", async () => {
    const broken = {
      ...PLAN,
      steps: [
        PLAN.steps[0],
        { ...PLAN.steps[1], rules: ["ACME-ARCH-404"] },
        PLAN.steps[2],
        { ...PLAN.steps[3], dependsOn: ["S3"] },
        {
          id: "S5",
          action: "modify",
          path: "src/gone.ts",
          intent: "x",
          testsFirst: ["src/use.test.ts"],
          dependsOn: ["S3"],
        },
      ],
    };
    const report = (
      await lint(fs(broken), ["src/other.mapper.ts"]).execute({ file: `${RUN}/plan.json` })
    )._unsafeUnwrap();
    expect(report.problems.map((p) => `${p.step}: ${p.message}`)).toEqual([
      "S2: unknown rule ACME-ARCH-404",
      "S2: src/b.mapper.ts is not an occurrence of pattern mapper",
      "S5: src/gone.ts does not exist",
      "S4: src/use.ts imports src/a.mapper.ts: depend on S2",
    ]);
  });

  test("a missing plan, a broken plan and failing collaborators are error values", async () => {
    expect((await lint(fs()).execute({ file: `${RUN}/none.json` }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
    const files = fs();
    await files.write(`${RUN}/bad.json`, "{");
    expect((await lint(files).execute({ file: `${RUN}/bad.json` }))._unsafeUnwrapErr().code).toBe(
      "INVALID_ARTIFACT",
    );
    const failing = { execute: async () => err(new MetatorError("COMMAND_FAILED", "ast-grep failed")) };
    const viaPatterns = new LintPlan(
      fs(),
      failing,
      new RuleCatalog(fs(), DEFAULT_PATHS),
      graph([]),
      DEFAULT_TEST_GLOBS,
    );
    expect((await viaPatterns.execute({ file: `${RUN}/plan.json` }))._unsafeUnwrapErr().code).toBe(
      "COMMAND_FAILED",
    );
    const viaGraph = new LintPlan(
      fs(),
      patterns([]),
      new RuleCatalog(fs(), DEFAULT_PATHS),
      failing,
      DEFAULT_TEST_GLOBS,
    );
    expect((await viaGraph.execute({ file: `${RUN}/plan.json` }))._unsafeUnwrapErr().code).toBe(
      "COMMAND_FAILED",
    );
  });
});

describe("ScopePlan", () => {
  test("writes a versioned PlanScope next to the plan, or where asked", async () => {
    const files = fs();
    const scope = (
      await new ScopePlan(files, graph([])).execute({ file: `${RUN}/plan.json` })
    )._unsafeUnwrap();
    expect([scope.output, scope.shards.map((s) => s.steps)]).toEqual([
      `${RUN}/plan-scope.json`,
      [["S1", "S2", "S3", "S4"]],
    ]);
    const saved = JSON.parse((await files.read(`${RUN}/plan-scope.json`))._unsafeUnwrap()) as Record<
      string,
      unknown
    >;
    expect([saved.kind, saved.schemaVersion, saved.plan]).toEqual(["PlanScope", 1, `${RUN}/plan.json`]);

    const out = (
      await new ScopePlan(files, graph([])).execute({ file: `${RUN}/plan.json`, out: "x/s.json" })
    )._unsafeUnwrap();
    expect([out.output, await files.exists("x/s.json")]).toEqual(["x/s.json", true]);
    const root = new InMemoryFileSystem({ "plan.json": JSON.stringify(PLAN) });
    expect((await new ScopePlan(root, graph([])).execute({ file: "plan.json" }))._unsafeUnwrap().output).toBe(
      "./plan-scope.json",
    );
  });
});
