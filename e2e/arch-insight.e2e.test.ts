/**
 * `metator arch analyze` insight end to end (H3): metrics with thresholds, a package whose two
 * halves serve different users (split), a private library with one user (merge), an export
 * nothing imports, packages that always change together in git, teams from CODEOWNERS, what
 * each application reaches, and the HTML report.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const lib = (name: string, deps: string[] = [], extra: Record<string, unknown> = {}) =>
  json({
    name,
    private: true,
    main: "src/index.ts",
    dependencies: Object.fromEntries(deps.map((d) => [d, "*"])),
    ...extra,
  });

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);

interface Report {
  files: { html: string };
  packages: {
    name: string;
    metrics?: { ca: number; ce: number; instability: number; depth: number; exportsUsed: number | null };
  }[];
  violations: { id: string; message: string }[];
  boundaries: {
    split: { package: string; clusters: { files: number; consumers: string[] }[] }[];
    merge: { package: string; into: string }[];
    deadExports: { package: string; file: string; name: string }[];
  };
  coupling: { a: string; b: string; together: number; ratio: number; dependency: string }[];
  teams: { edges: { from: string; to: string; imports: number }[]; unowned: string[] };
  apps: {
    closure: { app: string; packages: string[] }[];
    blastRadius: { package: string; apps: string[] }[];
  };
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\n");
  await repo.write(
    "package.json",
    json({ name: "shop", private: true, workspaces: ["apps/*", "packages/*"] }),
  );
  await repo.write(
    ".github/CODEOWNERS",
    "/apps/ @web-team\n/packages/ @platform\n/packages/money/ @billing\n",
  );
  await repo.write(
    "metator/architecture.yml",
    "kind: ArchitecturePolicy\nschemaVersion: 1\nthresholds:\n  fanOut: 2\n",
  );
  await repo.write(
    "apps/web/package.json",
    json({ name: "@shop/web", dependencies: { "@shop/kit": "*", "@shop/money": "*", "@shop/cart": "*" } }),
  );
  await repo.write(
    "apps/web/src/main.ts",
    'import { button } from "@shop/kit";\nimport { add } from "@shop/money";\nimport { cart } from "@shop/cart";\nexport const page = [button, add, cart];\n',
  );
  await repo.write(
    "apps/admin/package.json",
    json({ name: "@shop/admin", dependencies: { "@shop/kit": "*" } }),
  );
  await repo.write(
    "apps/admin/src/main.ts",
    'import { chart } from "@shop/kit";\nexport const admin = chart;\n',
  );
  // kit: two halves, one used by web (ui), one by admin (charts), tied together only by the barrel.
  await repo.write("packages/kit/package.json", lib("@shop/kit"));
  await repo.write(
    "packages/kit/src/index.ts",
    'export * from "./ui/button.ts";\nexport * from "./charts/chart.ts";\n',
  );
  await repo.write(
    "packages/kit/src/ui/button.ts",
    'import { theme } from "./theme.ts";\nexport const button = theme;\n',
  );
  await repo.write(
    "packages/kit/src/ui/theme.ts",
    "export const theme = 1;\nexport const unusedColor = 2;\n",
  );
  await repo.write(
    "packages/kit/src/charts/chart.ts",
    'import { axis } from "./axis.ts";\nexport const chart = axis;\n',
  );
  await repo.write("packages/kit/src/charts/axis.ts", "export const axis = 1;\n");
  await repo.write(
    "packages/kit/src/charts/legend.ts",
    'import { axis } from "./axis.ts";\nexport const legend = axis;\n',
  );
  await repo.write(
    "packages/kit/src/ui/icon.ts",
    'import { theme } from "./theme.ts";\nexport const icon = theme;\n',
  );
  await repo.write("packages/money/package.json", lib("@shop/money"));
  await repo.write("packages/money/src/index.ts", "export const add = (a: number, b: number) => a + b;\n");
  await repo.write("packages/cart/package.json", lib("@shop/cart", ["@shop/money"]));
  await repo.write(
    "packages/cart/src/index.ts",
    'import { add } from "@shop/money";\nexport const cart = add(1, 2);\n',
  );
  await repo.commit("init");
  // Linked like a developer's checkout (workspace packages only: nothing to download).
  const install = Bun.spawnSync(["bun", "install"], { cwd: repo.root });
  if (install.exitCode !== 0) throw new Error(install.stderr.toString());
  // Three more commits: money changes in each, cart in the last two (and both in the first).
  for (let i = 1; i <= 3; i++) {
    await repo.write(
      "packages/cart/src/index.ts",
      `import { add } from "@shop/money";\nexport const cart = add(${i}, 2);\n`,
    );
    await repo.write(
      "packages/money/src/index.ts",
      `export const add = (a: number, b: number) => a + b + ${i};\n`,
    );
    await repo.commit(`change ${i}`);
  }
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator arch analyze: metrics and boundaries (real CLI, real git history)", () => {
  test("metrics per package, and a threshold the policy sets", async () => {
    const run = await mt("arch", "analyze");
    expect(run.code).toBe(0);
    const r = run.json.data as Report;
    const m = (name: string) => r.packages.find((p) => p.name === name)?.metrics;
    expect(m("@shop/web")).toMatchObject({ ca: 0, ce: 3, instability: 1, depth: 2 });
    expect(m("@shop/money")).toMatchObject({ ca: 2, ce: 0, instability: 0, depth: 0, exportsUsed: 1 });
    expect(r.violations.map((v) => v.message)).toContain("@shop/web: fanOut 3 is over the threshold 2");
  }, 60_000);

  test("split, merge and dead exports", async () => {
    const r = (await mt("arch", "analyze")).json.data as Report;
    expect(r.boundaries.split).toEqual([
      {
        package: "@shop/kit",
        clusters: [
          expect.objectContaining({ files: 3, consumers: ["@shop/admin"] }),
          expect.objectContaining({ files: 3, consumers: ["@shop/web"] }),
        ],
      },
    ]);
    expect(r.boundaries.merge).toEqual([
      expect.objectContaining({ package: "@shop/cart", into: "@shop/web" }),
    ]);
    expect(r.boundaries.deadExports.map((d) => `${d.file}:${d.name}`)).toEqual([
      "packages/kit/src/charts/legend.ts:legend",
      "packages/kit/src/ui/icon.ts:icon",
      "packages/kit/src/ui/theme.ts:unusedColor",
    ]);
  }, 60_000);

  test("history, teams, applications and the HTML report", async () => {
    const r = (await mt("arch", "analyze")).json.data as Report;
    expect(r.coupling).toEqual([
      { a: "@shop/cart", b: "@shop/money", together: 3, ratio: 0.75, dependency: "a-to-b" },
    ]);
    expect(r.teams.edges).toEqual([
      { from: "@web-team", to: "@platform", imports: 3 },
      { from: "@platform", to: "@billing", imports: 1 },
      { from: "@web-team", to: "@billing", imports: 1 },
    ]);
    expect(r.teams.unowned).toEqual([]);
    expect(r.apps.closure).toEqual([
      { app: "@shop/admin", packages: ["@shop/kit"] },
      { app: "@shop/web", packages: ["@shop/cart", "@shop/kit", "@shop/money"] },
    ]);
    expect(r.apps.blastRadius[0]).toEqual({ package: "@shop/kit", apps: ["@shop/admin", "@shop/web"] });
    const html = await repo.read(r.files.html);
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('aria-label="Package graph"');
    expect(html).toContain("@shop/kit");
  }, 60_000);
});
