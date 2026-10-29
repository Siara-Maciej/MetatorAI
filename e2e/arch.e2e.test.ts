/**
 * `metator arch` end to end (H1): the real CLI on a real monorepo in a temp git repository, not
 * installed (a fresh clone). Six packages, one of them an application; a cycle between two
 * libraries, a library that imports the application, an undeclared import, a relative import
 * into another package and a dependency nobody imports.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const pkg = (name: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name, version: "1.0.0", main: "src/index.ts", ...extra }, null, 2)}\n`;

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);

interface Report {
  files: { json: string; markdown: string; html: string };
  summary: {
    packages: number;
    apps: number;
    cycles: number;
    errors: number;
    warnings: number;
    score: number;
  };
  packages: { name: string; kind: string; dependsOn: string[] }[];
  cycles: { packages: string[]; typeOnly: boolean }[];
  violations: { id: string; severity: string; evidence: { file: string }[] }[];
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\n");
  await repo.write(
    "package.json",
    `${JSON.stringify({ name: "shop", private: true, workspaces: ["apps/*", "packages/*"] }, null, 2)}\n`,
  );
  await repo.write(
    "apps/web/package.json",
    pkg("@shop/web", {
      main: undefined,
      scripts: { dev: "bun src/index.ts" },
      dependencies: { "@shop/cart": "workspace:*" },
    }),
  );
  await repo.write(
    "apps/web/src/index.ts",
    'import { cart } from "@shop/cart";\nexport const page = cart;\n',
  );
  await repo.write(
    "packages/cart/package.json",
    pkg("@shop/cart", { dependencies: { "@shop/pricing": "workspace:*" } }),
  );
  await repo.write(
    "packages/cart/src/index.ts",
    'import { price } from "@shop/pricing";\nimport { format } from "../../format/src/index.ts";\nexport const cart = format(price);\n',
  );
  await repo.write(
    "packages/pricing/package.json",
    pkg("@shop/pricing", { dependencies: { "@shop/cart": "workspace:*", "left-pad": "^1.3.0" } }),
  );
  await repo.write(
    "packages/pricing/src/index.ts",
    'import type { cart } from "@shop/cart";\nimport { z } from "zod";\nexport const price: number = 1;\nexport type Cart = typeof cart;\nexport const schema = z;\n',
  );
  await repo.write("packages/format/package.json", pkg("@shop/format"));
  await repo.write("packages/format/src/index.ts", "export const format = (n: number) => String(n);\n");
  await repo.write("packages/banner/package.json", pkg("@shop/banner"));
  await repo.write(
    "packages/banner/src/index.ts",
    'import { page } from "@shop/web";\nimport fs from "fs";\nexport const banner = [page, fs];\n',
  );
  await repo.write(
    "packages/banner/test/banner.test.ts",
    'import { banner } from "../src/index.ts";\nexport { banner };\n',
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator arch (real CLI, real monorepo)", () => {
  test("analyze: the package graph, its cycle and what is wrong, written as JSON, Markdown and HTML", async () => {
    const run = await mt("arch", "analyze");
    expect(run.code).toBe(0);
    const report = run.json.data as Report;
    expect(report.files).toEqual({
      json: ".metator/arch/report.json",
      markdown: ".metator/arch/report.md",
      html: ".metator/arch/report.html",
    });
    expect(report.summary).toMatchObject({ packages: 5, apps: 1, cycles: 1 });
    expect(report.packages.map((p) => [p.name, p.kind, p.dependsOn])).toEqual([
      ["@shop/banner", "lib", ["@shop/web"]],
      ["@shop/cart", "lib", ["@shop/format", "@shop/pricing"]],
      ["@shop/format", "lib", []],
      ["@shop/pricing", "lib", ["@shop/cart"]],
      ["@shop/web", "app", ["@shop/cart"]],
    ]);
    expect(report.cycles).toEqual([
      expect.objectContaining({ packages: ["@shop/cart", "@shop/pricing"], typeOnly: true }),
    ]);
    expect(report.violations.map((v) => [v.id, v.severity])).toEqual([
      ["app-import:@shop/banner→@shop/web", "error"],
      ["relative-import:@shop/cart→@shop/format", "error"],
      ["undeclared:@shop/banner→@shop/web", "error"],
      ["undeclared:@shop/cart→@shop/format", "error"],
      ["undeclared:@shop/pricing→zod", "error"],
      ["cycle:@shop/cart,@shop/pricing", "warning"],
      ["unused-dependency:@shop/pricing→left-pad", "warning"],
    ]);
    expect(report.summary).toMatchObject({ errors: 5, warnings: 2, score: 73 });

    const saved = JSON.parse(await repo.read(".metator/arch/report.json"));
    expect([saved.kind, saved.schemaVersion, saved.summary.score]).toEqual(["ArchitectureReport", 1, 73]);
    const md = await repo.read(".metator/arch/report.md");
    expect(md).toContain("### @shop/cart ⇄ @shop/pricing (type-only)");
    expect(md).toContain("**app-import** @shop/banner depends on the application @shop/web");
  }, 60_000);

  test("cycles and declared: the two views on their own", async () => {
    const cycles = await mt("arch", "cycles");
    expect((cycles.json.data as { cycles: { packages: string[] }[] }).cycles.map((c) => c.packages)).toEqual([
      ["@shop/cart", "@shop/pricing"],
    ]);
    const declared = await mt("arch", "declared");
    expect((declared.json.data as { violations: { id: string }[] }).violations.map((v) => v.id)).toEqual([
      "undeclared:@shop/banner→@shop/web",
      "undeclared:@shop/cart→@shop/format",
      "undeclared:@shop/pricing→zod",
      "unused-dependency:@shop/pricing→left-pad",
    ]);
  }, 60_000);

  test("simulate: what each kind of move would fix and break, without touching a file", async () => {
    type Effect = {
      effect: { before: { cycles: number }; after: { cycles: number }; fixed: string[]; rewrites: number };
    };
    const invert = (await mt("arch", "simulate", "invert", "@shop/pricing", "@shop/cart")).json
      .data as Effect;
    expect([invert.effect.before.cycles, invert.effect.after.cycles]).toEqual([1, 0]);
    expect(invert.effect.fixed).toContain("cycle:@shop/cart,@shop/pricing");
    // The example on the architecture guide page.
    expect(invert.effect).toMatchObject({
      before: { cycles: 1, errors: 5, warnings: 2, score: 73 },
      after: { cycles: 0, errors: 5, warnings: 2, score: 73 },
      fixed: ["cycle:@shop/cart,@shop/pricing"],
      added: [{ id: "unused-dependency:@shop/pricing→@shop/cart", severity: "warning" }],
      rewrites: 1,
      declared: [],
    });

    const move = (await mt("arch", "simulate", "move", "packages/format/src/index.ts", "--to", "@shop/cart"))
      .json.data as Effect;
    expect(move.effect.fixed).toEqual([
      "relative-import:@shop/cart→@shop/format",
      "undeclared:@shop/cart→@shop/format",
    ]);
    expect(move.effect.rewrites).toBe(1);

    const merge = (await mt("arch", "simulate", "merge", "@shop/pricing", "--into", "@shop/cart")).json
      .data as Effect;
    expect(merge.effect.after.cycles).toBe(0);

    const extract = (
      await mt(
        "arch",
        "simulate",
        "extract",
        "packages/banner/src/*.ts",
        "--name",
        "@shop/promo",
        "--dir",
        "packages/promo",
      )
    ).json.data as Effect & {
      effect: { declared: { package: string; dependency: string }[]; added: { id: string }[] };
    };
    // banner's test still imports the code, so banner declares the new package; the undeclared
    // import of the application moves with the files instead of being declared for them.
    expect(extract.effect.declared).toEqual([{ package: "@shop/banner", dependency: "@shop/promo" }]);
    expect(extract.effect.added.map((v) => v.id)).toContain("undeclared:@shop/promo→@shop/web");

    const bad = await mt("arch", "simulate", "merge", "@shop/nope", "--into", "@shop/cart");
    expect([bad.code, (bad.json.error as { message: string }).message]).toEqual([
      64,
      "merge @shop/nope into @shop/cart: there is no package @shop/nope",
    ]);
    expect(await repo.git("status", "--porcelain")).toBe("");
  }, 90_000);

  test("a policy with layers: a dependency upwards is an error", async () => {
    await repo.write(
      "metator/architecture.yml",
      [
        "kind: ArchitecturePolicy",
        "schemaVersion: 1",
        "layers:",
        "  - name: apps",
        "    packages: [apps/*]",
        "  - name: features",
        "    packages: ['@shop/cart', '@shop/banner']",
        "  - name: shared",
        "    packages: ['@shop/pricing', '@shop/format']",
        "severity:",
        "  cycle: error",
        "",
      ].join("\n"),
    );
    const run = await mt("arch", "analyze");
    const report = run.json.data as Report & { policy: string };
    expect(report.policy).toBe("metator/architecture.yml");
    const ids = report.violations.map((v) => `${v.id} ${v.severity}`);
    expect(ids).toContain("layer:@shop/pricing→@shop/cart error");
    expect(ids).toContain("layer:@shop/banner→@shop/web error");
    expect(ids).toContain("cycle:@shop/cart,@shop/pricing error");
  }, 60_000);

  test("an invalid policy is INVALID_CONFIG; schema prints the format", async () => {
    await repo.write(
      "metator/architecture.yml",
      "kind: ArchitecturePolicy\nschemaVersion: 1\nlayers:\n  - name: x\n",
    );
    const run = await mt("arch", "analyze");
    expect([run.code, (run.json.error as { code: string }).code]).toEqual([1, "INVALID_CONFIG"]);
    const schema = await mt("arch", "schema");
    expect((schema.json.data as { properties: Record<string, unknown> }).properties).toHaveProperty("layers");
  }, 60_000);
});
