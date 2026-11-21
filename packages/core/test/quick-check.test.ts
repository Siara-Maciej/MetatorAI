import { describe, expect, test } from "bun:test";
import { QuickCheck } from "../src/application/quick.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const LIMITS = { maxFiles: 5, maxLines: 150, maxDependents: 3 };

function world(over: Partial<ConstructorParameters<typeof QuickCheck>[0]> = {}) {
  const dependents: Record<string, string[]> = {
    "packages/shop/src/price.ts": ["packages/shop/src/cart.ts", "packages/shop/test/price.test.ts"],
    "packages/shop/src/index.ts": ["packages/web/src/app.ts"],
    "packages/shop/src/tax.ts": ["packages/shop/src/cart.ts"],
    // The graph knows the test file too: nothing imports it.
    "packages/shop/test/price.test.ts": [],
  };
  return new QuickCheck({
    limits: LIMITS,
    testGlobs: ["**/*.test.ts"],
    vcs: { changedFiles: async () => ok(["packages/shop/src/price.ts"]) },
    patch: {
      patch: async () =>
        ok("--- a/packages/shop/src/price.ts\n+++ b/packages/shop/src/price.ts\n@@ -1 +1 @@\n-a\n+b\n"),
    },
    workspace: {
      packages: async () =>
        ok([
          { name: "@shop/core", dir: "packages/shop" },
          { name: "@shop/web", dir: "packages/web" },
        ]),
    },
    graph: {
      dependents: async (file) =>
        dependents[file] ? ok(dependents[file] as string[]) : err(MetatorError.notFound(`file ${file}`)),
    },
    impact: { execute: async () => err(new MetatorError("NOT_FOUND", "no system map")) },
    exists: async () => true,
    ...over,
  });
}

describe("QuickCheck: the facts of a change, gathered from the tools, then the verdict", () => {
  test("named files: a tested file of one package with few dependents is quick", async () => {
    const r = (await world().execute({ files: ["packages/shop/src/price.ts"] }))._unsafeUnwrap();
    expect(r).toEqual({
      quick: true,
      escalators: [],
      thresholds: LIMITS,
      files: ["packages/shop/src/price.ts"],
    });
  });

  test("the diff: its files and its lines; a package's entry is its public API; another package is a boundary", async () => {
    const r = (
      await world({
        vcs: { changedFiles: async () => ok(["packages/shop/src/index.ts", "packages/web/src/app.ts"]) },
      }).execute({ diff: true })
    )._unsafeUnwrap();
    expect(r.escalators.map((e) => e.id)).toEqual(["public-api", "package-boundary", "untested"]);
    expect(r.files).toEqual(["packages/shop/src/index.ts", "packages/web/src/app.ts"]);
  });

  test("code no test reaches; a test file, a document and a file that is not there yet are not code to test", async () => {
    const check = world({ exists: async (f) => f !== "packages/shop/src/new.ts" });
    const r = (
      await check.execute({
        files: [
          "packages/shop/src/tax.ts",
          "packages/shop/test/price.test.ts",
          "README.md",
          "packages/shop/src/new.ts",
        ],
      })
    )._unsafeUnwrap();
    expect(r.escalators).toEqual([
      {
        id: "untested",
        why: "no test reaches packages/shop/src/tax.ts",
        source: "metator graph dependents --transitive",
      },
    ]);
  });

  test("the system map: a touched contract, and another application the change reaches", async () => {
    const r = (
      await world({
        impact: {
          execute: async () =>
            ok({
              self: ["shop-api"],
              applications: [
                { id: "shop-api", changed: true },
                { id: "shop-web", changed: false },
              ],
              contracts: [{ id: "prices-api" }],
            } as never),
        },
      }).execute({ files: ["packages/shop/src/price.ts"] })
    )._unsafeUnwrap();
    expect(r.escalators.map((e) => [e.id, e.why])).toEqual([
      ["cross-repository", "it reaches another repository: shop-web"],
      ["contract", "it touches a contract: prices-api"],
    ]);
  });

  test("many dependents; nothing to check is a usage error", async () => {
    const r = (
      await world({
        graph: { dependents: async () => ok(["a.ts", "b.ts", "c.ts", "d.ts", "e.test.ts"]) },
      }).execute({ files: ["packages/shop/src/price.ts"] })
    )._unsafeUnwrap();
    expect(r.escalators.map((e) => [e.id, e.why])).toEqual([
      ["dependents", "4 files depend on what it changes (limit 3)"],
    ]);
    // Tests follow a change: three files and a test that depend on it are at the limit, not past it.
    const atLimit = (
      await world({
        graph: { dependents: async () => ok(["a.ts", "b.ts", "c.ts", "e.test.ts"]) },
      }).execute({ files: ["packages/shop/src/price.ts"] })
    )._unsafeUnwrap();
    expect(atLimit.quick).toBe(true);
    expect((await world().execute({}))._unsafeUnwrapErr().message).toBe(
      'say what to check: the files the change touches (--files a,b), the working tree\'s diff (--diff), or the task (--task "<text>")',
    );
    const clean = await world({ vcs: { changedFiles: async () => ok([]) } }).execute({ diff: true });
    expect(clean._unsafeUnwrap()).toMatchObject({ quick: true, files: [] });
  });

  test("the task: the files it names (that exist) are checked, and its words; a task alone is enough to ask", async () => {
    const check = world({ exists: async (f) => f.startsWith("packages/") });
    const r = (
      await check.execute({
        task: "Fix rounding in packages/shop/src/tax.ts (see notes.md) and add a migration",
      })
    )._unsafeUnwrap();
    expect(r.files).toEqual(["packages/shop/src/tax.ts"]);
    expect(r.escalators.map((e) => e.id)).toEqual(["untested", "migration"]);
    const plain = (await check.execute({ task: "Rename the price helper" }))._unsafeUnwrap();
    expect([plain.quick, plain.files]).toEqual([true, []]);
    expect((await check.execute({}))._unsafeUnwrapErr().message).toBe(
      'say what to check: the files the change touches (--files a,b), the working tree\'s diff (--diff), or the task (--task "<text>")',
    );
  });
});
