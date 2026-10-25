import { join } from "node:path";

/**
 * A realistic Bun-workspaces monorepo used by adapter tests and e2e tests (DRY): workspace
 * packages with `exports`, tsconfig `paths`, `.js`→`.ts` imports, `import type`, re-exports,
 * a dynamic import, an import cycle, CSS, a Node builtin, an uninstalled package, a broken
 * relative import and a git-ignored build output.
 */
export const MONOREPO_FILES: Readonly<Record<string, string>> = {
  "package.json": json({ name: "acme", private: true, workspaces: ["packages/*", "apps/*"] }),
  ".gitignore": "node_modules/\ndist/\n.metator/\n",
  "tsconfig.json": json({
    compilerOptions: {
      module: "preserve",
      moduleResolution: "bundler",
      paths: { "@app/*": ["./apps/web/src/*"] },
    },
  }),

  "packages/money/package.json": json({
    name: "@acme/money",
    version: "1.0.0",
    exports: { ".": "./src/index.ts" },
  }),
  "packages/money/src/index.ts":
    'export * from "./money.ts";\nexport type { Currency } from "./currency.ts";\n',
  "packages/money/src/money.ts":
    'import type { Currency } from "./currency.ts";\nexport const add = (a: number, b: number, _c?: Currency) => a + b;\n',
  "packages/money/src/currency.ts": 'export type Currency = "PLN" | "EUR";\n',
  "packages/money/src/money.test.ts": 'import { add } from "./money.ts";\nconsole.log(add(1, 2));\n',

  "packages/billing/package.json": json({
    name: "@acme/billing",
    version: "1.0.0",
    exports: { ".": "./src/invoice.ts" },
    dependencies: { "@acme/money": "workspace:*" },
  }),
  "packages/billing/src/invoice.ts":
    'import { add } from "@acme/money";\nimport { tax } from "./tax.js";\nexport const invoice = (n: number) => add(n, tax(n));\n',
  "packages/billing/src/tax.ts":
    'import { round } from "./round.ts";\nexport const tax = (n: number) => round(n * 0.23);\n',
  "packages/billing/src/round.ts":
    'import { tax } from "./tax.ts";\nexport const round = (n: number) => Math.round(n);\nexport const again = () => tax;\n',
  "packages/billing/src/lazy.ts": 'export const load = () => import("./invoice.ts");\n',
  "packages/billing/src/broken.ts": 'import { nothing } from "./does-not-exist";\nexport { nothing };\n',

  "apps/web/package.json": json({
    name: "@acme/web",
    private: true,
    dependencies: { "@acme/billing": "workspace:*" },
  }),
  "apps/web/src/main.ts":
    'import { invoice } from "@acme/billing";\nimport { util } from "@app/util";\nimport "./styles.css";\nimport { readFileSync } from "node:fs";\nimport { chunk } from "lodash";\nexport const main = () => [invoice(1), util, readFileSync, chunk];\n',
  "apps/web/src/util.ts": "export const util = 1;\n",
  "apps/web/src/styles.css": "body { margin: 0 }\n",
  "apps/web/src/main.test.ts": 'import { main } from "./main.ts";\nmain();\n',

  "dist/bundle.js": 'import "../packages/money/src/money.ts";\n',
};

export async function writeFixture(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content);
}

/** Writes the monorepo and links its workspaces with a real `bun install` (offline: workspace deps only). */
export async function createMonorepo(root: string): Promise<void> {
  await writeFixture(root, MONOREPO_FILES);
  const proc = Bun.spawn(["bun", "install", "--silent"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`bun install failed in fixture: ${stderr}`);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
