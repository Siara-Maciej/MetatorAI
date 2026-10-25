/**
 * Import graph end to end: the real `metator` process on a real Bun-workspaces monorepo
 * (real `bun install`, real git), and on the MetatorAI repository itself (dogfood).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMonorepo } from "@metator/testing";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");
let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await createMonorepo(repo.root);
  await repo.commit("init");
  await repo.git("checkout", "-q", "-b", "feature");
}, 60_000);

afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

describe("metator index build", () => {
  test("indexes source files, skips ignored output, reports externals and broken imports", async () => {
    const r = await metator(["index", "build"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r)).toMatchObject({
      files: 12,
      packages: 3,
      crossPackageEdges: 2,
      externals: ["lodash", "node:fs"],
      unresolved: [{ from: "packages/billing/src/broken.ts", specifier: "./does-not-exist" }],
    });
  });

  test("second build reuses the index; an edited file is parsed again", async () => {
    await metator(["index", "build"], repo.root);
    expect(data(await metator(["index", "build"], repo.root)).stats).toEqual({
      parsed: 0,
      reused: 12,
      failed: 0,
    });
    await repo.write("apps/web/src/util.ts", "export const util = 2;\n");
    expect(data(await metator(["index", "build"], repo.root)).stats).toEqual({
      parsed: 1,
      reused: 11,
      failed: 0,
    });
    await repo.git("checkout", "--", "apps/web/src/util.ts");
  });

  test("a syntax error is a warning, not a failure", async () => {
    await repo.write("apps/web/src/bad.ts", "export const = ;\n");
    try {
      const r = await metator(["index", "build"], repo.root);
      expect(r.code).toBe(0);
      expect(data(r).stats).toMatchObject({ failed: 1 });
      expect((r.json.warnings as string[])[0]).toContain("apps/web/src/bad.ts");
    } finally {
      await Bun.file(repo.path("apps/web/src/bad.ts")).delete();
    }
  });

  test("the index is a versioned document", async () => {
    await metator(["index", "build"], repo.root);
    expect((await findUnversioned(repo.root, [".metator"])).unversioned).toEqual([]);
  });
});

describe("metator graph", () => {
  test("cycles finds the tax ↔ round cycle", async () => {
    expect(data(await metator(["graph", "cycles"], repo.root))).toEqual({
      cycles: [["packages/billing/src/round.ts", "packages/billing/src/tax.ts"]],
    });
  });

  test("deps resolves workspace packages, tsconfig paths, CSS and .js → .ts imports", async () => {
    const r = await metator(["graph", "deps", "apps/web/src/main.ts"], repo.root);
    expect(data(r).files).toEqual([
      "apps/web/src/styles.css",
      "apps/web/src/util.ts",
      "packages/billing/src/invoice.ts",
    ]);
    const invoice = await metator(["graph", "deps", "packages/billing/src/invoice.ts"], repo.root);
    expect(data(invoice).files).toEqual(["packages/billing/src/tax.ts", "packages/money/src/index.ts"]);
  });

  test("transitive dependents of a type-only module include the importing app and tests", async () => {
    const r = await metator(
      ["graph", "dependents", "./packages/money/src/currency.ts", "--transitive"],
      repo.root,
    );
    expect(data(r).file).toBe("packages/money/src/currency.ts");
    expect(data(r).files).toContain("apps/web/src/main.ts");
    expect(data(r).files).toContain("packages/billing/src/lazy.ts"); // through the dynamic import
  });

  test("path is the import chain in order", async () => {
    const r = await metator(
      ["graph", "path", "apps/web/src/main.ts", "packages/money/src/currency.ts"],
      repo.root,
    );
    expect(data(r).path).toEqual([
      "apps/web/src/main.ts",
      "packages/billing/src/invoice.ts",
      "packages/money/src/index.ts",
      "packages/money/src/currency.ts",
    ]);
    const none = await metator(
      ["graph", "path", "packages/money/src/currency.ts", "apps/web/src/main.ts"],
      repo.root,
    );
    expect(data(none).path).toBeNull();
  });

  test("packages aggregates cross-package edges", async () => {
    expect(data(await metator(["graph", "packages"], repo.root))).toEqual({
      edges: [
        { from: "@acme/billing", to: "@acme/money", count: 1 },
        { from: "@acme/web", to: "@acme/billing", count: 1 },
      ],
    });
  });

  test("affected against a branch: a change in money reaches billing, web and their tests", async () => {
    await repo.write(
      "packages/money/src/money.ts",
      `${await repo.read("packages/money/src/money.ts")}// edit\n`,
    );
    try {
      const r = await metator(["graph", "affected", "--base", "main"], repo.root);
      expect(r.code).toBe(0);
      expect(data(r).changed).toEqual(["packages/money/src/money.ts"]);
      expect(data(r).files).toContain("apps/web/src/main.ts");
      expect(data(r).tests).toEqual(["apps/web/src/main.test.ts", "packages/money/src/money.test.ts"]);
    } finally {
      await repo.git("checkout", "--", "packages/money/src/money.ts");
    }
  });

  test("affected with explicit files does not need git changes", async () => {
    const r = await metator(["graph", "affected", "--files", "apps/web/src/util.ts"], repo.root);
    expect(data(r)).toEqual({
      changed: ["apps/web/src/util.ts"],
      files: ["apps/web/src/main.test.ts", "apps/web/src/main.ts", "apps/web/src/util.ts"],
      tests: ["apps/web/src/main.test.ts"],
    });
  });

  test("an unknown file is NOT_FOUND with a hint", async () => {
    const r = await metator(["graph", "deps", "nope.ts"], repo.root);
    expect(r.code).not.toBe(0);
    expect(r.json.error).toMatchObject({ code: "NOT_FOUND" });
  });

  test("a missing argument is a usage error", async () => {
    expect((await metator(["graph", "path", "apps/web/src/main.ts"], repo.root)).code).toBe(64);
  });
});

describe("metator workspace list", () => {
  test("lists the Bun workspace packages", async () => {
    expect(data(await metator(["workspace", "list"], repo.root))).toEqual({
      packages: [
        { name: "@acme/web", dir: "apps/web" },
        { name: "@acme/billing", dir: "packages/billing" },
        { name: "@acme/money", dir: "packages/money" },
      ],
    });
  });
});

describe("dogfood: the MetatorAI repository", () => {
  test("has no import cycles", async () => {
    expect(data(await metator(["graph", "cycles", "--root", SELF], SELF))).toEqual({ cycles: [] });
  });

  test("core depends on no plugin, runtime wires every plugin", async () => {
    const edges = data(await metator(["graph", "packages", "--root", SELF], SELF)).edges as {
      from: string;
      to: string;
    }[];
    const fromCore = edges.filter((e) => e.from === "@metator/core").map((e) => e.to);
    expect(fromCore.every((to) => to === "@metator/testing")).toBe(true); // tests only
    const fromRuntime = edges.filter((e) => e.from === "@metator/runtime").map((e) => e.to);
    expect(fromRuntime).toEqual(
      expect.arrayContaining(["@metator/plugin-git", "@metator/plugin-node", "@metator/plugin-typescript"]),
    );
  });

  test("a change to the git adapter affects its own test", async () => {
    const r = await metator(
      ["graph", "affected", "--files", "packages/plugin-git/src/git-vcs.ts", "--root", SELF],
      SELF,
    );
    expect(data(r).tests).toContain("packages/plugin-git/test/git-vcs.test.ts");
  });
});
