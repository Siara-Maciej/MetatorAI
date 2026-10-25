import { describe, expect, test } from "bun:test";
import { FakeRuleEngine, FakeVcs, InMemoryFileSystem } from "@metator/testing";
import { stringify } from "yaml";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import {
  CheckRules,
  GenerateRuleAdapters,
  LintRules,
  PackRules,
  RuleCatalog,
} from "../src/application/rules.ts";
import { SourceFiles } from "../src/application/source-files.ts";
import { RuleSetDocument, rulesFor } from "../src/domain/rule.ts";

type RawRule = Record<string, unknown>;

const rule = (id: string, extra: RawRule = {}): RawRule => ({
  id,
  title: `Rule ${id} title`,
  applyTo: ["packages/*/src/**"],
  enforcement: "E2",
  summary: `Summary of ${id}, one actionable sentence.`,
  rationale: "docs/adr/0001-x.md",
  source: { ref: "AGENTS.md#architecture", verified: "2026-10-25" },
  ...extra,
});

const ruleSet = (area: string, rules: RawRule[], extra: RawRule = {}) =>
  stringify({ kind: "RuleSet", schemaVersion: 1, area, rules, ...extra });

const ARCH = ruleSet(
  "ARCH",
  [
    rule("MT-ARCH-001", {
      enforcement: "E1",
      implementation: "ast-grep:mt-arch-domain-pure",
      applyTo: ["packages/core/src/domain/**"],
    }),
    rule("MT-ARCH-002", {
      do: ["inject ports via the constructor"],
      dont: ["new BunFileSystem() in a use case"],
    }),
    rule("MT-ARCH-003", { enforcement: "E3", applyTo: ["packages/cli/**"] }),
    rule("MT-ARCH-004", { status: "deprecated", supersededBy: "MT-ARCH-002" }),
  ],
  { description: "Architecture boundaries." },
);

const BASE_FILES: Record<string, string> = {
  "docs/adr/0001-x.md": "# ADR",
  "AGENTS.md": "# Agents\n\n## Architecture\n",
  "packages/core/src/domain/a.ts": "",
  "packages/core/src/application/b.ts": "",
  "packages/cli/src/main.ts": "",
};

const ENGINE_RULES = [{ id: "mt-arch-domain-pure", source: "rules/architecture/x.yml", hasTest: true }];

function world(files: Record<string, string>, engines = [new FakeRuleEngine("ast-grep", ENGINE_RULES)]) {
  const all = { ...BASE_FILES, ...files };
  const fs = new InMemoryFileSystem(all);
  const vcs = new FakeVcs(Object.keys(all), ["packages/core/src/domain/a.ts"]);
  const catalog = new RuleCatalog(fs, DEFAULT_PATHS);
  return {
    fs,
    catalog,
    lint: new LintRules(catalog, fs, new SourceFiles(vcs, fs, []), engines),
    pack: new PackRules(catalog),
    adapters: new GenerateRuleAdapters(catalog, fs, DEFAULT_PATHS),
    check: new CheckRules(catalog, engines, vcs),
  };
}

const messages = async (files: Record<string, string>, engines?: FakeRuleEngine[]) =>
  (await world(files, engines).lint.execute())
    ._unsafeUnwrap()
    .problems.map((p) => `${p.severity}: ${p.message}`);

describe("RuleSet document", () => {
  test("defaults status, do, dont and conflictsWith", () => {
    const raw = { kind: "RuleSet", schemaVersion: 1, area: "TS", rules: [rule("MT-TS-001")] };
    const parsed = RuleSetDocument.parse(raw, "ts.yml")._unsafeUnwrap();
    expect(parsed.rules[0]).toMatchObject({ status: "active", do: [], dont: [], conflictsWith: [] });
  });

  test.each([
    ["bad id", rule("ARCH-1"), "PREFIX"],
    ["E1 without implementation", rule("MT-TS-001", { enforcement: "E1" }), "implementation"],
    ["implementation on E2", rule("MT-TS-001", { implementation: "ast-grep:x" }), "E1"],
    ["superseded but active", rule("MT-TS-001", { supersededBy: "MT-TS-002" }), "deprecated"],
    ["unknown key", rule("MT-TS-001", { severity: "high" }), ""],
    ["bad date", rule("MT-TS-001", { source: { ref: "x", verified: "yesterday" } }), ""],
  ])("rejects %s", (_name, bad, fragment) => {
    const error = RuleSetDocument.parse(
      { kind: "RuleSet", schemaVersion: 1, area: "TS", rules: [bad] },
      "ts.yml",
    );
    expect(error.isErr()).toBe(true);
    expect(JSON.stringify(error._unsafeUnwrapErr().details)).toContain(fragment);
  });

  test("rulesFor: active rules matching any path, negations respected", () => {
    const parsed = RuleSetDocument.parse(
      {
        kind: "RuleSet",
        schemaVersion: 1,
        area: "TS",
        rules: [
          rule("MT-TS-001", { applyTo: ["src/**", "!src/**/*.test.ts"] }),
          rule("MT-TS-002", { status: "draft", applyTo: ["src/**"] }),
        ],
      },
      "ts.yml",
    )._unsafeUnwrap();
    expect(rulesFor(parsed.rules, ["src/a.ts"]).map((r) => r.id)).toEqual(["MT-TS-001"]);
    expect(rulesFor(parsed.rules, ["src/a.test.ts"])).toEqual([]);
  });
});

describe("LintRules", () => {
  test("a healthy canon has no problems and counts enforcement levels", async () => {
    const report = (await world({ "docs/metator/rules/arch.yml": ARCH }).lint.execute())._unsafeUnwrap();
    expect(report).toEqual({ sets: 1, rules: 4, byEnforcement: { E1: 1, E2: 2, E3: 1 }, problems: [] });
  });

  test("invalid documents are reported, not thrown", async () => {
    expect(
      await messages({ "docs/metator/rules/bad.yml": "kind: RuleSet\nschemaVersion: 1\narea: X\n" }),
    ).toEqual([expect.stringContaining("error: docs/metator/rules/bad.yml: does not match RuleSet v1")]);
    expect(await messages({ "docs/metator/rules/broken.yml": "rules: [" })).toEqual([
      expect.stringContaining("Invalid YAML"),
    ]);
  });

  test("duplicate ids across files, wrong area and mixed prefixes", async () => {
    const result = await messages({
      "docs/metator/rules/arch.yml": ARCH,
      "docs/metator/rules/ts.yml": ruleSet("TS", [rule("MT-ARCH-002"), rule("OPL-TS-001")]),
    });
    expect(result).toContain(
      "error: duplicate rule id MT-ARCH-002 (first defined in docs/metator/rules/arch.yml)",
    );
    expect(result).toContain("error: MT-ARCH-002 is not in area TS");
    expect(result).toContain("error: rule ids use several prefixes (MT, OPL); use one");
  });

  test("missing link targets and unknown rule references", async () => {
    const result = await messages({
      "docs/metator/rules/ts.yml": ruleSet("TS", [
        rule("MT-TS-001", { rationale: "docs/adr/9999-gone.md#why", conflictsWith: ["MT-TS-404"] }),
        rule("MT-TS-002", {
          rationale: "https://example.com/adr",
          source: { ref: "#local", verified: "2026-01-01" },
        }),
      ]),
    });
    expect(result).toEqual([
      "error: link target not found: docs/adr/9999-gone.md#why",
      "error: references unknown rule MT-TS-404",
    ]);
  });

  test("Markdown anchors in links must match a heading (GitHub slugs)", async () => {
    const result = await messages({
      "docs/guide.md":
        "# Guide\n\n## Dependency policy: don't reinvent the wheel\n\n```md\n## Not a heading\n```\n",
      "docs/metator/rules/ts.yml": ruleSet("TS", [
        rule("MT-TS-001", {
          source: { ref: "docs/guide.md#dependency-policy-dont-reinvent-the-wheel", verified: "2026-10-25" },
        }),
        rule("MT-TS-002", { source: { ref: "docs/guide.md#renamed-section", verified: "2026-10-25" } }),
        rule("MT-TS-003", { source: { ref: "docs/guide.md#not-a-heading", verified: "2026-10-25" } }),
      ]),
    });
    expect(result).toEqual([
      "error: link target not found: docs/guide.md#renamed-section",
      "error: link target not found: docs/guide.md#not-a-heading",
    ]);
  });

  test("E1 implementations must exist in their engine and have a test", async () => {
    const set = ruleSet("TS", [
      rule("MT-TS-001", { enforcement: "E1", implementation: "ast-grep:nope" }),
      rule("MT-TS-002", { enforcement: "E1", implementation: "ast-grep:untested" }),
      rule("MT-TS-003", { enforcement: "E1", implementation: "biome:lint/style/noVar" }),
    ]);
    const engine = new FakeRuleEngine("ast-grep", [
      { id: "untested", source: "rules/u.yml", hasTest: false },
    ]);
    expect(await messages({ "docs/metator/rules/ts.yml": set }, [engine])).toEqual([
      "error: ast-grep:nope does not exist (engine rules: 1)",
      "error: ast-grep:untested has no test (rules/u.yml)",
      'warning: no adapter for engine "biome": implementation not verified',
    ]);
  });

  test("an active rule whose applyTo matches nothing is a warning (dead rule)", async () => {
    expect(
      await messages({
        "docs/metator/rules/ts.yml": ruleSet("TS", [rule("MT-TS-001", { applyTo: ["nowhere/**"] })]),
      }),
    ).toEqual(["warning: applyTo matches no file in the repository"]);
  });

  test("an empty canon is fine", async () => {
    expect((await world({}).lint.execute())._unsafeUnwrap()).toMatchObject({
      sets: 0,
      rules: 0,
      problems: [],
    });
  });
});

describe("PackRules", () => {
  test("only matching active rules; E2 before E3; E1 as a one-liner", async () => {
    const pack = (
      await world({ "docs/metator/rules/arch.yml": ARCH }).pack.execute({
        paths: ["packages/cli/src/main.ts", "packages/core/src/domain/a.ts"],
      })
    )._unsafeUnwrap();
    expect(pack.rules.map((r) => [r.id, r.enforcement])).toEqual([
      ["MT-ARCH-002", "E2"],
      ["MT-ARCH-003", "E3"],
    ]);
    expect(pack.rules[0]?.dont).toEqual(["new BunFileSystem() in a use case"]);
    expect(pack.enforcedByTools).toEqual([
      { id: "MT-ARCH-001", title: "Rule MT-ARCH-001 title", implementation: "ast-grep:mt-arch-domain-pure" },
    ]);
    expect(pack.omitted).toEqual([]);
  });

  test("paths outside every rule give an empty pack", async () => {
    const pack = (
      await world({ "docs/metator/rules/arch.yml": ARCH }).pack.execute({ paths: ["README.md"] })
    )._unsafeUnwrap();
    expect([pack.rules, pack.enforcedByTools, pack.omitted]).toEqual([[], [], []]);
  });

  test("the token budget is respected; what does not fit is listed by id", async () => {
    const pack = (
      await world({ "docs/metator/rules/arch.yml": ARCH }).pack.execute({
        paths: ["packages/cli/src/main.ts"],
        budgetTokens: 60,
      })
    )._unsafeUnwrap();
    expect(pack.tokens).toBeLessThanOrEqual(60);
    expect([...pack.rules.map((r) => r.id), ...pack.omitted].sort()).toEqual(["MT-ARCH-002", "MT-ARCH-003"]);
    expect(pack.omitted.length).toBeGreaterThan(0);
  });

  test("an invalid canon is an error, never a silently partial pack", async () => {
    const error = (
      await world({ "docs/metator/rules/bad.yml": "x: [" }).pack.execute({ paths: ["a.ts"] })
    )._unsafeUnwrapErr();
    expect([error.code, error.hint]).toEqual(["INVALID_CONFIG", "Run `metator rules lint` for details."]);
  });
});

describe("GenerateRuleAdapters", () => {
  test("one versioned instructions file per area with the union of applyTo globs", async () => {
    const w = world({ "docs/metator/rules/arch.yml": ARCH });
    expect((await w.adapters.execute({ check: false }))._unsafeUnwrap().written).toEqual([
      ".github/instructions/mt-arch.instructions.md",
    ]);
    const text = (await w.fs.read(".github/instructions/mt-arch.instructions.md"))._unsafeUnwrap();
    expect(text).toStartWith("---\nkind: InstructionsAdapter\nschemaVersion: 1\n");
    expect(text).toContain("applyTo: packages/*/src/**,packages/cli/**,packages/core/src/domain/**\n");
    expect(text).toContain("## MT-ARCH-002: Rule MT-ARCH-002 title");
    expect(text).toContain("- Don't: `new BunFileSystem() in a use case`");
    expect(text).toContain("Applies to: `packages/cli/**`");
    expect(text).toContain("- MT-ARCH-001: Rule MT-ARCH-001 title (`ast-grep:mt-arch-domain-pure`)");
    expect(text).not.toContain("MT-ARCH-004"); // deprecated
  });

  test("examples containing backticks keep a valid code span", async () => {
    const set = ruleSet("TS", [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
      rule("MT-TS-001", { do: ["err(`${id} missing`)"], applyTo: ["packages/**"] }),
    ]);
    const w = world({ "docs/metator/rules/ts.yml": set });
    await w.adapters.execute({ check: false });
    expect((await w.fs.read(".github/instructions/mt-ts.instructions.md"))._unsafeUnwrap()).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
      "- Do: `` err(`${id} missing`) ``",
    );
  });

  test("long descriptions stay on one front matter line (hosts read applyTo from it)", async () => {
    const set = ruleSet("TS", [rule("MT-TS-001")], { description: "x".repeat(200) });
    const w = world({ "docs/metator/rules/ts.yml": set });
    await w.adapters.execute({ check: false });
    expect((await w.fs.read(".github/instructions/mt-ts.instructions.md"))._unsafeUnwrap()).toContain(
      `description: ${"x".repeat(200)}\n`,
    );
  });

  test("regeneration is idempotent and check mode detects hand edits", async () => {
    const w = world({ "docs/metator/rules/arch.yml": ARCH });
    await w.adapters.execute({ check: false });
    expect((await w.adapters.execute({ check: true }))._unsafeUnwrap()).toEqual({
      written: [],
      unchanged: [".github/instructions/mt-arch.instructions.md"],
      stale: [],
      orphaned: [],
    });
    const file = ".github/instructions/mt-arch.instructions.md";
    await w.fs.write(file, `${(await w.fs.read(file))._unsafeUnwrap()}\nhand edit\n`);
    expect((await w.adapters.execute({ check: true }))._unsafeUnwrap().stale).toEqual([file]);
    expect((await w.fs.read(file))._unsafeUnwrap()).toContain("hand edit"); // check never writes
  });

  test("generated files of removed areas are orphaned; hand-written instructions are left alone", async () => {
    const w = world({
      "docs/metator/rules/arch.yml": ARCH,
      ".github/instructions/mt-old.instructions.md":
        "---\nkind: InstructionsAdapter\nschemaVersion: 1\n---\nold\n",
      ".github/instructions/team.instructions.md": "---\napplyTo: '**'\n---\nours\n",
    });
    expect((await w.adapters.execute({ check: false }))._unsafeUnwrap().orphaned).toEqual([
      ".github/instructions/mt-old.instructions.md",
    ]);
  });
});

describe("CheckRules", () => {
  const diagnostics = [
    {
      source: "ast-grep",
      toolRuleId: "mt-arch-domain-pure",
      file: "packages/core/src/domain/a.ts",
      line: 3,
      severity: "error" as const,
      message: "no I/O",
    },
    {
      source: "ast-grep",
      toolRuleId: "unlisted",
      file: "packages/cli/src/main.ts",
      line: 1,
      severity: "warning" as const,
      message: "tool-only",
    },
  ];

  test("maps tool rule ids to canon ids; tool-only rules stay unmapped", async () => {
    const engine = new FakeRuleEngine("ast-grep", ENGINE_RULES, diagnostics);
    const report = (
      await world({ "docs/metator/rules/arch.yml": ARCH }, [engine]).check.execute({})
    )._unsafeUnwrap();
    expect(report.files).toBe("all");
    expect(report.violations.map((v) => [v.file, v.canonRuleId])).toEqual([
      ["packages/cli/src/main.ts", undefined],
      ["packages/core/src/domain/a.ts", "MT-ARCH-001"],
    ]);
  });

  test("--base checks only changed files; no changes means nothing runs", async () => {
    const engine = new FakeRuleEngine("ast-grep", ENGINE_RULES, diagnostics);
    const w = world({ "docs/metator/rules/arch.yml": ARCH }, [engine]);
    const report = (await w.check.execute({ base: "main" }))._unsafeUnwrap();
    expect(engine.checked).toEqual([["packages/core/src/domain/a.ts"]]);
    expect(report.violations).toHaveLength(1);
    expect((await w.check.execute({ files: [] }))._unsafeUnwrap()).toEqual({
      engines: [],
      files: 0,
      violations: [],
    });
  });
});
