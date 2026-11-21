import { describe, expect, test } from "bun:test";
import {
  changedLines,
  type QuickFacts,
  quickCheck,
  quickOverride,
  quickReviewFindings,
  taskEscalators,
  taskFiles,
} from "../src/domain/quick.ts";

const LIMITS = { maxFiles: 5, maxLines: 150, maxDependents: 10 };
const facts = (over: Partial<QuickFacts> = {}): QuickFacts => ({
  files: ["packages/shop/src/price.ts", "packages/shop/test/price.test.ts"],
  packages: ["@shop/core"],
  dependents: 2,
  publicApi: [],
  untested: [],
  contracts: [],
  repositories: [],
  ...over,
});
const ids = (f: QuickFacts) => quickCheck(f, LIMITS).escalators.map((e) => e.id);

describe("quickCheck: is this change small enough for the quick way (ADR-0093)", () => {
  test("a small, tested change in one package is quick; the thresholds are said", () => {
    expect(quickCheck(facts(), LIMITS)).toEqual({ quick: true, escalators: [], thresholds: LIMITS });
  });

  test("each escalator trips alone and says why and which tool saw it", () => {
    expect(quickCheck(facts({ repositories: ["shop-web"] }), LIMITS).escalators).toEqual([
      {
        id: "cross-repository",
        why: "it reaches another repository: shop-web",
        source: "metator system impact",
      },
    ]);
    expect(quickCheck(facts({ contracts: ["prices-api"] }), LIMITS).escalators).toEqual([
      { id: "contract", why: "it touches a contract: prices-api", source: "metator system impact" },
    ]);
    expect(quickCheck(facts({ publicApi: ["@shop/core"] }), LIMITS).escalators).toEqual([
      { id: "public-api", why: "the public API of @shop/core changes", source: "metator api diff" },
    ]);
    expect(quickCheck(facts({ packages: ["@shop/core", "@shop/web"] }), LIMITS).escalators).toEqual([
      {
        id: "package-boundary",
        why: "it crosses a package boundary: @shop/core, @shop/web",
        source: "metator graph dependents --transitive",
      },
    ]);
    expect(quickCheck(facts({ dependents: 11 }), LIMITS).escalators).toEqual([
      {
        id: "dependents",
        why: "11 files depend on what it changes (limit 10)",
        source: "metator graph dependents --transitive",
      },
    ]);
    expect(quickCheck(facts({ untested: ["packages/shop/src/tax.ts"] }), LIMITS).escalators).toEqual([
      {
        id: "untested",
        why: "no test reaches packages/shop/src/tax.ts",
        source: "metator graph dependents --transitive",
      },
    ]);
    // Exactly at a limit is still quick.
    expect(ids(facts({ dependents: 10 }))).toEqual([]);
  });

  test("size: more files than the limit, or more changed lines (when there is a diff)", () => {
    const six = Array.from({ length: 6 }, (_, i) => `packages/shop/src/f${i}.ts`);
    expect(quickCheck(facts({ files: six }), LIMITS).escalators).toEqual([
      { id: "size", why: "6 files (limit 5)", source: "git diff" },
    ]);
    expect(quickCheck(facts({ lines: 151 }), LIMITS).escalators).toEqual([
      { id: "size", why: "151 changed lines (limit 150)", source: "git diff" },
    ]);
    expect(ids(facts({ lines: 150 }))).toEqual([]);
    expect(ids(facts({ files: six.slice(0, 5) }))).toEqual([]);
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n";
    expect(changedLines(patch)).toBe(3);
  });

  test("files that are never a quick change: a migration, a schema version, a dependency, CI configuration", () => {
    expect(ids(facts({ files: ["db/migrations/0007_currency.sql"] }))).toEqual(["migration"]);
    expect(ids(facts({ files: ["docs/metator/schemas/Layout.v5.json"] }))).toEqual(["schema-version"]);
    expect(ids(facts({ files: ["prisma/schema.prisma"] }))).toEqual(["schema-version"]);
    expect(ids(facts({ files: [".github/workflows/ci.yml"] }))).toEqual(["ci-config"]);
    expect(ids(facts({ files: [".gitlab-ci.yml"] }))).toEqual(["ci-config"]);
    expect(ids(facts({ files: ["bun.lock"] }))).toEqual(["dependency"]);
    // A manifest that will change (no diff yet) may bring a dependency; with a diff, only an added one does.
    expect(ids(facts({ files: ["packages/shop/package.json"] }))).toEqual(["dependency"]);
    const scripts =
      '--- a/packages/shop/package.json\n+++ b/packages/shop/package.json\n@@ -3,1 +3,2 @@\n+    "lint": "biome check ."\n';
    const added =
      '--- a/packages/shop/package.json\n+++ b/packages/shop/package.json\n@@ -9,1 +9,2 @@\n+    "currency.js": "^2.0.4"\n';
    expect(ids(facts({ files: ["packages/shop/package.json"], patch: scripts }))).toEqual([]);
    expect(ids(facts({ files: ["packages/shop/package.json"], patch: added }))).toEqual(["dependency"]);
    // A document's version in the diff.
    const version =
      "--- a/src/doc.ts\n+++ b/src/doc.ts\n@@ -1 +1 @@\n-  schemaVersion: 1,\n+  schemaVersion: 2,\n";
    expect(ids(facts({ files: ["src/doc.ts"], patch: version }))).toEqual(["schema-version"]);
  });

  test("several at once are all named, the cross-repository one first", () => {
    expect(
      ids(facts({ dependents: 40, repositories: ["shop-web"], untested: ["a.ts"], lines: 900 })),
    ).toEqual(["cross-repository", "dependents", "untested", "size"]);
  });
});

describe("quickOverride: the person may keep it quick with a sentence, never across repositories", () => {
  const tripped = (list: string[]) => list.map((id) => ({ id, why: "w", source: "s" }));
  test("no escalator needs no override; with one, the person's sentence is needed", () => {
    expect(quickOverride([], undefined)).toEqual({ allowed: true });
    expect(quickOverride(tripped(["size"]), undefined)).toEqual({
      allowed: false,
      why: 'not quick: size (w). The person may keep it quick with one sentence (--override "<their words>").',
    });
    expect(quickOverride(tripped(["size", "untested"]), "it is only a rename, keep it quick")).toEqual({
      allowed: true,
      overridden: ["size", "untested"],
    });
    expect(quickOverride(tripped(["size"]), "  ")).toMatchObject({ allowed: false });
  });

  test("a change that reaches another repository is never quick, whatever the person says", () => {
    expect(quickOverride(tripped(["cross-repository", "size"]), "keep it quick")).toEqual({
      allowed: false,
      why: "not quick, and this cannot be overridden: it reaches another repository (w). Use the full workflow (mt-system-change).",
    });
  });
});

describe("the task's own words (quick check --task): what it names before any file is known", () => {
  test("a task that speaks of a migration, a dependency, CI, a schema version or another repository is not quick", () => {
    const of = (task: string) => taskEscalators(task).map((e) => e.id);
    expect(of("Rename the price helper to priceOf")).toEqual([]);
    expect(of("Add a migration for the currency column")).toEqual(["migration"]);
    expect(of("Upgrade the zod dependency to 4")).toEqual(["dependency"]);
    expect(of("install the currency.js package and use it")).toEqual(["dependency"]);
    expect(of("Fix the CI pipeline")).toEqual(["ci-config"]);
    expect(of("bump schemaVersion of the layout document")).toEqual(["schema-version"]);
    expect(of("Change the price API in both repositories")).toEqual(["cross-repository"]);
    // Polish, as the person may write it.
    expect(of("Dodaj migrację dla kolumny waluty")).toEqual(["migration"]);
    expect(of("Zaktualizuj zależność zod")).toEqual(["dependency"]);
    expect(taskEscalators("Add a migration")[0]).toEqual({
      id: "migration",
      why: "the task speaks of a migration",
      source: "the task's words",
    });
    // A word inside another is no hint ("specification" holds "ci").
    expect(of("Update the specification text")).toEqual([]);
  });

  test("the files a task names are the files it is expected to touch", () => {
    expect(taskFiles("Fix rounding in packages/shop/src/price.ts and `src/tax.ts`, see README.md.")).toEqual([
      "packages/shop/src/price.ts",
      "src/tax.ts",
      "README.md",
    ]);
    expect(taskFiles("Rename the helper (e.g. priceOf) in v2.0")).toEqual([]);
  });

  test("quickCheck adds the task's hints to what the files say, each escalator once", () => {
    const got = quickCheck(
      facts({ files: ["db/migrations/1.sql"], task: "Add a migration and fix CI" }),
      LIMITS,
    );
    expect(got.escalators.map((e) => [e.id, e.source])).toEqual([
      ["migration", "git diff"],
      ["ci-config", "the task's words"],
    ]);
  });
});

describe("quickReviewFindings: what the one short review of a quick change says (quick-review.md)", () => {
  test("its first line decides: no blocking finding passes, BLOCKING: n names them, anything else is no review", () => {
    expect(quickReviewFindings("No blocking finding.\n\nNotes:\n- a name could be clearer\n")).toEqual([]);
    expect(quickReviewFindings("BLOCKING: 0\n")).toEqual([]);
    expect(
      quickReviewFindings(
        "BLOCKING: 2\nsrc/price.ts:4 rounds down; half-up is asked for\nsrc/price.ts:9 no test for 0.5\n\nNotes:\n- naming\n",
      ),
    ).toEqual(["src/price.ts:4 rounds down; half-up is asked for", "src/price.ts:9 no test for 0.5"]);
    // The count is what the reviewer said, also when the lines are fewer.
    expect(quickReviewFindings("BLOCKING: 1\n")).toEqual(["1 blocking finding(s), not listed"]);
    expect(quickReviewFindings("Looks good to me!\n")).toBeUndefined();
    expect(quickReviewFindings("")).toBeUndefined();
  });
});
