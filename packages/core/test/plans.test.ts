import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { stringify } from "yaml";
import { DEFAULT_PATHS, DEFAULT_TEST_GLOBS } from "../src/application/paths.ts";
import { CheckPlanStep, LintPlan, PlanProgress, ScopePlan } from "../src/application/plans.ts";
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

  test("whether the repository has any test is read from its files, not only the plan's", async () => {
    const plan = {
      ...PLAN,
      steps: [{ id: "S1", action: "modify", path: "src/use.ts", intent: "use it" }],
    };
    const severity = async (files: InMemoryFileSystem) =>
      (await lint(files).execute({ file: `${RUN}/plan.json` }))._unsafeUnwrap().problems[0]?.severity;
    // src/use.test.ts exists, though no step names it: tests come first.
    expect(await severity(fs(plan))).toBe("error");
    const untested = fs(plan);
    await untested.remove("src/use.test.ts");
    expect(await severity(untested)).toBe("warning");
  });

  test("without a pattern catalog the exemplar is looked up in the repository", async () => {
    const none = (files: InMemoryFileSystem) =>
      new LintPlan(
        files,
        { execute: async () => ok({ patterns: [], problems: [] }) },
        new RuleCatalog(files, DEFAULT_PATHS),
        graph([{ from: "src/use.ts", to: "src/a.mapper.ts" }]),
        DEFAULT_TEST_GLOBS,
      );
    const there = (await none(fs()).execute({ file: `${RUN}/plan.json` }))._unsafeUnwrap();
    expect(there.problems.map((p) => p.severity)).toEqual(["warning"]);
    const gone = fs();
    await gone.remove("src/b.mapper.ts");
    const missing = (await none(gone).execute({ file: `${RUN}/plan.json` }))._unsafeUnwrap();
    expect(missing.problems.map((p) => p.message)).toContain("exemplar src/b.mapper.ts does not exist");
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

  test("a dry run computes the same scope and writes nothing", async () => {
    const files = fs();
    const dry = (
      await new ScopePlan(files, graph([])).execute({ file: `${RUN}/plan.json`, dryRun: true })
    )._unsafeUnwrap();
    expect([dry.output, dry.shards.map((s) => s.steps)]).toEqual([undefined, [["S1", "S2", "S3", "S4"]]]);
    expect(await files.exists(`${RUN}/plan-scope.json`)).toBe(false);
  });
});

describe("CheckPlanStep and PlanProgress (Etap 3): a step is done when its own tests pass", () => {
  const PLAN_FILE = `${RUN}/plan.json`;
  const PROGRESS_FILE = `${RUN}/build-progress.json`;
  type Asked = { changed: readonly string[]; script: string };
  const tests = (passed: (changed: readonly string[]) => boolean) => {
    const asked: Asked[] = [];
    return {
      asked,
      runner: {
        execute: async (input: { changed?: readonly string[]; script: string }) => {
          const changed = input.changed ?? [];
          asked.push({ changed, script: input.script });
          const ok_ = passed(changed);
          return ok({
            changed,
            tests: changed.filter((f) => f.endsWith(".test.ts")),
            command: ["bun", "test"],
            exitCode: ok_ ? 0 : 1,
            passed: ok_,
            output: ok_ ? "1 pass" : "expect(received).toBe(expected)\n 1 fail",
          });
        },
      },
    };
  };
  const setup = (passed: (changed: readonly string[]) => boolean = () => true) => {
    const fs = new InMemoryFileSystem({ [PLAN_FILE]: JSON.stringify(PLAN) });
    const t = tests(passed);
    const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
    return {
      fs,
      asked: t.asked,
      check: new CheckPlanStep(fs, t.runner, clock),
      progress: new PlanProgress(fs),
    };
  };

  test("a step runs the tests its file and its tests-first reach, and the result is kept with the output", async () => {
    const { fs, asked, check } = setup();
    expect((await check.execute({ file: PLAN_FILE, step: "S1" }))._unsafeUnwrap().passed).toBe(true);
    const s2 = (await check.execute({ file: PLAN_FILE, step: "S2", script: "test:unit" }))._unsafeUnwrap();
    expect(asked.at(-1)).toEqual({
      changed: ["src/a.mapper.ts", "src/a.mapper.test.ts"],
      script: "test:unit",
    });
    expect([s2.step, s2.passed, s2.tests]).toEqual(["S2", true, ["src/a.mapper.test.ts"]]);
    const saved = JSON.parse((await fs.read(PROGRESS_FILE))._unsafeUnwrap()) as {
      kind: string;
      steps: Record<string, { passed: boolean; at: string; output?: string }>;
    };
    expect(saved.kind).toBe("BuildProgress");
    expect(saved.steps.S2).toMatchObject({ passed: true, at: "2026-11-15T10:00:00.000Z", output: "1 pass" });
  });

  test("a red step is recorded as failed with what failed, and a later green run replaces it", async () => {
    let green = false;
    const { check, progress } = setup(() => green);
    const red = (await check.execute({ file: PLAN_FILE, step: "S1" }))._unsafeUnwrap();
    expect([red.passed, red.exitCode, red.output]).toEqual([false, 1, expect.stringContaining("1 fail")]);
    expect((await progress.execute({ file: PLAN_FILE }))._unsafeUnwrap().steps[0]).toEqual({
      id: "S1",
      status: "failed",
    });
    green = true;
    expect((await check.execute({ file: PLAN_FILE, step: "S1" }))._unsafeUnwrap().passed).toBe(true);
    expect((await progress.execute({ file: PLAN_FILE }))._unsafeUnwrap().steps[0]?.status).toBe("passed");
  });

  test("a step whose dependencies have not passed is refused before any test runs", async () => {
    const { asked, check } = setup();
    const refused = (await check.execute({ file: PLAN_FILE, step: "S2" }))._unsafeUnwrapErr();
    expect([refused.code, refused.message]).toEqual(["CHECK_FAILED", expect.stringContaining("S1")]);
    expect(asked).toEqual([]);
    const unknown = (await check.execute({ file: PLAN_FILE, step: "S9" }))._unsafeUnwrapErr();
    expect([unknown.code, unknown.message]).toEqual(["NOT_FOUND", expect.stringContaining("S9")]);
  });

  test("progress: done only when every step passed; nothing recorded yet is pending", async () => {
    const { check, progress } = setup();
    const empty = (await progress.execute({ file: PLAN_FILE }))._unsafeUnwrap();
    expect([empty.done, empty.steps.map((s) => s.status)]).toEqual([
      false,
      ["pending", "pending", "pending", "pending"],
    ]);
    for (const step of ["S1", "S3", "S2", "S4"]) await check.execute({ file: PLAN_FILE, step });
    const all = (await progress.execute({ file: PLAN_FILE }))._unsafeUnwrap();
    expect([all.done, all.passed, all.total]).toEqual([true, 4, 4]);
  });
});
