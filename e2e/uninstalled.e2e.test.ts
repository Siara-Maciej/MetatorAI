/**
 * A Turborepo monorepo before `pnpm install` (shaped like a real Next.js one): configs that
 * extend packages not installed, app-local tsconfig paths, a shared lint config package, Tailwind
 * imports in CSS and task-runner scripts. The real `metator` process scans it as it is.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;

const json = (value: unknown) => JSON.stringify(value, null, 2);

beforeAll(async () => {
  repo = await ScratchRepo.create();
  const files: Record<string, string> = {
    "package.json": json({
      name: "shop",
      private: true,
      scripts: {
        "//": "///// -- CHECKS -- /////",
        lint: "turbo lint",
        "lint-staged:eslint": "eslint --fix",
        test: "turbo run test:ui test:scripts",
        "test:scripts": "TS_DEBUG=1 jest --selectProjects=scripts",
      },
      devDependencies: { turbo: "2", jest: "30", eslint: "9" },
    }),
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "turbo.json": json({ tasks: { lint: {}, "test:ui": {} } }),
    "tsconfig.json": json({ extends: "./node_modules/@shop/typescript-config/base.json" }),
    "apps/web/package.json": json({
      name: "web",
      private: true,
      dependencies: { "@shop/ui": "workspace:*", "@shop/utils": "workspace:*" },
      devDependencies: { "@shop/eslint-config": "workspace:*", "@shop/typescript-config": "workspace:*" },
    }),
    "apps/web/tsconfig.json": `{
      // the app's own aliases
      "extends": "@shop/typescript-config/nextjs.json",
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["./*"], "@shop/ui/*": ["../../packages/ui/src/*"] },
      },
    }`,
    "apps/web/app/page.tsx":
      'import { Header } from "@/components/header";\nimport { Card } from "@shop/ui/card";\nexport default () => [Header, Card];\n',
    "apps/web/components/header.tsx": "export const Header = 1;\n",
    "apps/web/eslint.config.js": 'import base from "@shop/eslint-config/base";\nexport default base;\n',
    "packages/ui/package.json": json({
      name: "@shop/ui",
      private: true,
      exports: { "./*": "./src/*.tsx" },
      dependencies: { "tw-animate-css": "1" },
      devDependencies: { tailwindcss: "4", "@shop/eslint-config": "workspace:*" },
    }),
    "packages/ui/tsconfig.json": json({ extends: "@shop/typescript-config/react.json" }),
    "packages/ui/src/card.tsx": 'import { day } from "../../utils/src/date";\nexport const Card = day;\n',
    "packages/ui/src/globals.css": '@import "tailwindcss";\n@import "tw-animate-css";\n',
    "packages/ui/eslint.config.js": 'import base from "@shop/eslint-config/base";\nexport default base;\n',
    "packages/utils/package.json": json({
      name: "@shop/utils",
      private: true,
      exports: { ".": "./src/index.ts" },
      devDependencies: { "@shop/eslint-config": "workspace:*" },
    }),
    "packages/utils/src/index.ts": 'export * from "./date";\n',
    "packages/utils/src/date.ts": "export const day = 1;\n",
    "packages/eslint-config/package.json": json({
      name: "@shop/eslint-config",
      private: true,
      exports: { "./base": "./base.js" },
      devDependencies: { "eslint-plugin-import": "2", globals: "16" },
    }),
    "packages/eslint-config/base.js":
      'import importPlugin from "eslint-plugin-import";\nimport globals from "globals";\nexport default [importPlugin, globals];\n',
    "packages/typescript-config/package.json": json({ name: "@shop/typescript-config", private: true }),
    "packages/typescript-config/base.json": json({ compilerOptions: { strict: true } }),
  };
  for (const [file, text] of Object.entries(files)) await repo.write(file, text);
  await repo.commit("init");
}, 60_000);

afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

describe("a monorepo before install", () => {
  test("index build: relative imports and each app's own paths resolve, with a warning why it is approximate", async () => {
    const r = await metator(["index", "build"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r)).toMatchObject({ edges: 4, unresolved: [] });
    const warnings = r.json.warnings as string[];
    expect(warnings).toContain(
      "apps/web/tsconfig.json extends a config that is not installed; its own paths are used as aliases. Install dependencies for exact resolution.",
    );
    const deps = await metator(["graph", "deps", "apps/web/app/page.tsx"], repo.root);
    expect(data(deps).files).toEqual(["apps/web/components/header.tsx", "packages/ui/src/card.tsx"]);
  });

  test("arch analyze: tool configs and the shared lint config may use devDependencies; CSS imports are uses", async () => {
    const r = await metator(["arch", "analyze"], repo.root);
    expect(r.code).toBe(0);
    const violations = (data(r).violations as { id: string }[]).map((v) => v.id);
    // The real problem: ui reaches into utils with a relative path it does not declare.
    expect(violations).toContain("relative-import:@shop/ui→@shop/utils");
    expect(violations.filter((v) => v.startsWith("dev-in-prod"))).toEqual([]);
    expect(violations.filter((v) => v.includes("tw-animate-css") || v.includes("tailwindcss"))).toEqual([]);
  });

  test("init: task-runner scripts are the gates; a fixer and comments are not", async () => {
    await metator(["discover"], repo.root);
    const r = await metator(["init"], repo.root);
    expect(r.code).toBe(0);
    const decisions = (data(r).decisions as { gate: string; step: string }[]).map(
      (d) => `${d.gate}: ${d.step}`,
    );
    expect(decisions).toEqual(["full: script lint", "quick: eslint on files", "full: script test"]);
    const discovery = JSON.parse(await repo.read(".metator/discovery.json")) as {
      scripts: { name: string }[];
    };
    expect(discovery.scripts.map((s) => s.name)).not.toContain("//");
  });
});
