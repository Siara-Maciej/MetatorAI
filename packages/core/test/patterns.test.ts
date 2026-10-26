import { describe, expect, test } from "bun:test";
import { FakeRuleEngine, FakeVcs, InMemoryFileSystem } from "@metator/testing";
import { stringify } from "yaml";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { FindSimilar, PatternCatalog, ScanPatterns } from "../src/application/patterns.ts";
import { CheckRules, RuleCatalog } from "../src/application/rules.ts";
import type { Diagnostic } from "../src/domain/diagnostic.ts";
import { pathAffinity } from "../src/domain/pattern.ts";
import { ok } from "../src/domain/result.ts";

const pattern = (id: string, extra: Record<string, unknown> = {}) =>
  stringify({
    kind: "Pattern",
    schemaVersion: 1,
    id,
    title: `Pattern ${id}`,
    intent: "Fetch server data in the UI through a query hook.",
    when: "data from the API",
    detection: `ast-grep:mt-pattern-${id}`,
    exemplar: "packages/orders/src/orders.queries.ts",
    ...extra,
  });

const hint = (rule: string, file: string, line = 1): Diagnostic => ({
  source: "ast-grep",
  toolRuleId: rule,
  file,
  line,
  severity: "info",
  message: "pattern",
});

const DIAGNOSTICS: Diagnostic[] = [
  hint("mt-pattern-query-hook", "packages/orders/src/orders.queries.ts", 12),
  hint("mt-pattern-query-hook", "packages/orders/src/orders.queries.ts", 30),
  hint("mt-pattern-query-hook", "packages/billing/src/invoices.queries.ts", 4),
  hint("mt-pattern-query-hook", "packages/legacy/src/useFetch.ts", 2),
  { ...hint("mt-arch-x", "packages/orders/src/a.ts"), severity: "error" },
];

const ENGINE_RULES = [
  { id: "mt-pattern-query-hook", source: "sg/p.yml", hasTest: true },
  { id: "mt-pattern-untested", source: "sg/u.yml", hasTest: false },
];

function world(files: Record<string, string>) {
  const fs = new InMemoryFileSystem({ "packages/legacy/src/useFetch.ts": "", ...files });
  const engine = new FakeRuleEngine("ast-grep", ENGINE_RULES, DIAGNOSTICS);
  const workspace = {
    packages: async () =>
      ok([
        { name: "@acme/orders", dir: "packages/orders" },
        { name: "@acme/billing", dir: "packages/billing" },
      ]),
  };
  const scan = new ScanPatterns(
    new PatternCatalog(fs, DEFAULT_PATHS),
    new RuleCatalog(fs, DEFAULT_PATHS),
    [engine],
    workspace,
    fs,
    DEFAULT_PATHS,
  );
  return { fs, engine, scan, similar: new FindSimilar(scan) };
}

const QUERY_HOOK = pattern("query-hook", {
  legacy: [{ path: "packages/legacy/src/useFetch.ts", reason: "manual fetch in useEffect" }],
});

describe("ScanPatterns", () => {
  test("occurrences per file (first line), per package, legacy kept apart, index written", async () => {
    const w = world({ "docs/metator/patterns/query-hook.yml": QUERY_HOOK });
    const scan = (await w.scan.execute())._unsafeUnwrap();
    expect(scan.problems).toEqual([]);
    expect(scan.patterns[0]).toMatchObject({
      id: "query-hook",
      occurrences: [
        { file: "packages/billing/src/invoices.queries.ts", line: 4 },
        { file: "packages/orders/src/orders.queries.ts", line: 12 },
      ],
      byPackage: { "@acme/billing": 1, "@acme/orders": 1 },
      legacy: ["packages/legacy/src/useFetch.ts"],
    });
    const index = JSON.parse((await w.fs.read(".metator/index/patterns.json"))._unsafeUnwrap());
    expect([index.kind, index.schemaVersion, index.patterns[0].occurrences.length]).toEqual([
      "PatternIndex",
      1,
      2,
    ]);
  });

  test("catalog problems: missing detection rule, untested rule, bad exemplar, too few, unknown rule", async () => {
    const w = world({
      "docs/metator/patterns/a.yml": pattern("missing"),
      "docs/metator/patterns/b.yml": pattern("untested", { minOccurrences: 1 }),
      "docs/metator/patterns/c.yml": pattern("query-hook", {
        id: "query-hook",
        exemplar: "packages/legacy/src/useFetch.ts",
        legacy: [{ path: "packages/legacy/src/useFetch.ts", reason: "old" }],
        minOccurrences: 3,
        rules: ["MT-API-404"],
      }),
    });
    const problems = (await w.scan.execute())
      ._unsafeUnwrap()
      .problems.map((p) => `${p.pattern}: ${p.severity}: ${p.message}`);
    expect(problems).toEqual([
      "missing: error: detection rule ast-grep:mt-pattern-missing does not exist",
      "missing: error: 0 occurrence(s), expected at least 2",
      "missing: error: exemplar packages/orders/src/orders.queries.ts is not an occurrence of ast-grep:mt-pattern-missing",
      "untested: warning: detection rule ast-grep:mt-pattern-untested has no test",
      "untested: error: 0 occurrence(s), expected at least 1",
      "untested: error: exemplar packages/orders/src/orders.queries.ts is not an occurrence of ast-grep:mt-pattern-untested",
      "query-hook: error: references unknown rule MT-API-404",
      "query-hook: error: 2 occurrence(s), expected at least 3",
      "query-hook: error: exemplar packages/legacy/src/useFetch.ts is marked legacy",
    ]);
  });

  test("an invalid pattern file is a problem, not a crash; no catalog runs no engine", async () => {
    const w = world({ "docs/metator/patterns/bad.yml": "kind: Pattern\nschemaVersion: 1\nid: Bad Id\n" });
    const scan = (await w.scan.execute())._unsafeUnwrap();
    expect(scan.problems[0]?.message).toContain("does not match Pattern v1");
    expect(w.engine.checked).toEqual([]);
  });
});

describe("FindSimilar", () => {
  test("a planned file ranks occurrences by directory and file kind; the exemplar wins ties", async () => {
    const w = world({ "docs/metator/patterns/query-hook.yml": QUERY_HOOK });
    const matches = (
      await w.similar.execute({ target: "packages/orders/src/customers.queries.ts", top: 3 })
    )._unsafeUnwrap();
    expect(matches.map((m) => [m.file, m.exemplar])).toEqual([
      ["packages/orders/src/orders.queries.ts", true],
      ["packages/billing/src/invoices.queries.ts", false],
    ]);
    expect(matches[0]?.reasons).toContain("same file kind *.queries.ts");
    expect(matches.some((m) => m.file.includes("legacy"))).toBe(false);
  });

  test("a description matches pattern words; nothing related returns an empty list", async () => {
    const w = world({ "docs/metator/patterns/query-hook.yml": QUERY_HOOK });
    expect(
      (await w.similar.execute({ query: "fetch invoices from the server", top: 1 }))._unsafeUnwrap()[0],
    ).toMatchObject({
      pattern: "query-hook",
      exemplar: true,
    });
    expect((await w.similar.execute({ query: "zebra", top: 3 }))._unsafeUnwrap()).toEqual([]);
  });

  test("needs a file or a description", async () => {
    expect((await world({}).similar.execute({ top: 3 }))._unsafeUnwrapErr().code).toBe("USAGE");
  });
});

describe("pathAffinity", () => {
  test("shared directories and compound suffixes count; a plain .ts suffix does not", () => {
    expect(pathAffinity("a/b/x.queries.ts", "a/b/y.queries.ts")).toEqual({
      score: 5,
      reasons: ["same directory prefix a/b/", "same file kind *.queries.ts"],
    });
    expect(pathAffinity("a/x.ts", "b/y.ts")).toEqual({ score: 0, reasons: [] });
  });
});

describe("rules check ignores pattern hints", () => {
  test("info-level findings are not violations", async () => {
    const fs = new InMemoryFileSystem({});
    const check = new CheckRules(
      new RuleCatalog(fs, DEFAULT_PATHS),
      [new FakeRuleEngine("ast-grep", [], DIAGNOSTICS)],
      new FakeVcs([]),
    );
    const report = (await check.execute({}))._unsafeUnwrap();
    expect(report.violations.map((v) => v.toolRuleId)).toEqual(["mt-arch-x"]);
  });
});
