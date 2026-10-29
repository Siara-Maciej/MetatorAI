import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonorepo } from "@metator/testing";
import { OxcImportAnalyzer, packageName, pathAliases } from "../src/oxc-import-analyzer.ts";

let root: string;
let analyzer: OxcImportAnalyzer;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "metator-oxc-"));
  await createMonorepo(root);
  analyzer = new OxcImportAnalyzer(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("OxcImportAnalyzer.parse", () => {
  const parse = (code: string, file = "a.ts") =>
    new OxcImportAnalyzer("/tmp").parse(file, code)._unsafeUnwrap();

  test("static, type-only, side-effect, re-export and dynamic imports", () => {
    const imports = parse(
      [
        'import type { A } from "./types";',
        'import def, { b } from "./b";',
        'import "./side-effect.css";',
        'export * from "./all";',
        'export type { T } from "./t";',
        'export { c } from "./c";',
        'const lazy = () => import("./lazy");',
        "const dynamic = (p: string) => import(p);",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
        "const tpl = (x: string) => import(`./x/${x}`);",
        'const fake = "import(./not-real)";',
      ].join("\n"),
    );
    expect(imports).toEqual([
      { specifier: "./types", kind: "static", typeOnly: true },
      { specifier: "./b", kind: "static", typeOnly: false },
      { specifier: "./side-effect.css", kind: "static", typeOnly: false },
      { specifier: "./all", kind: "reexport", typeOnly: false },
      { specifier: "./t", kind: "reexport", typeOnly: true },
      { specifier: "./c", kind: "reexport", typeOnly: false },
      { specifier: "./lazy", kind: "dynamic", typeOnly: false },
    ]);
  });

  test("TSX and JSX files parse", () => {
    expect(parse('import { x } from "./x";\nexport const C = () => <div>{x}</div>;', "c.tsx")).toHaveLength(
      1,
    );
    expect(parse('import React from "react";\nexport const C = () => <b/>;', "c.jsx")).toHaveLength(1);
  });

  test("a syntax error is PARSE_FAILED with the file name, not a crash", () => {
    const error = new OxcImportAnalyzer("/tmp").parse("bad.ts", "import { from ;;; ")._unsafeUnwrapErr();
    expect(error.code).toBe("PARSE_FAILED");
    expect(error.message).toContain("bad.ts");
  });

  test("fingerprint is stable and content-sensitive", () => {
    const a = new OxcImportAnalyzer("/tmp");
    expect(a.fingerprint("x")).toBe(a.fingerprint("x"));
    expect(a.fingerprint("x")).not.toBe(a.fingerprint("y"));
  });
});

describe("OxcImportAnalyzer.resolve (real monorepo, real bun install)", () => {
  test("relative import with .js → .ts extension alias", () => {
    expect(analyzer.resolve("packages/billing/src/invoice.ts", "./tax.js")).toEqual({
      type: "file",
      path: "packages/billing/src/tax.ts",
    });
  });

  test("workspace package through package.json exports and the node_modules symlink", () => {
    expect(analyzer.resolve("packages/billing/src/invoice.ts", "@acme/money")).toEqual({
      type: "file",
      path: "packages/money/src/index.ts",
    });
  });

  test("tsconfig paths alias", () => {
    expect(analyzer.resolve("apps/web/src/main.ts", "@app/util")).toEqual({
      type: "file",
      path: "apps/web/src/util.ts",
    });
  });

  test("non-code assets resolve to files", () => {
    expect(analyzer.resolve("apps/web/src/main.ts", "./styles.css")).toEqual({
      type: "file",
      path: "apps/web/src/styles.css",
    });
  });

  test("Node builtins and uninstalled packages are external", () => {
    expect(analyzer.resolve("apps/web/src/main.ts", "node:fs")).toEqual({
      type: "external",
      name: "node:fs",
    });
    expect(analyzer.resolve("apps/web/src/main.ts", "lodash")).toEqual({ type: "external", name: "lodash" });
  });

  test("a builtin without the node: prefix reads as the node: builtin, not as a package", () => {
    expect(analyzer.resolve("apps/web/src/main.ts", "fs")).toEqual({ type: "external", name: "node:fs" });
    expect(analyzer.resolve("apps/web/src/main.ts", "path/posix")).toEqual({
      type: "external",
      name: "node:path/posix",
    });
  });

  test("a broken relative import is unresolved", () => {
    expect(analyzer.resolve("packages/billing/src/broken.ts", "./does-not-exist")).toEqual({
      type: "unresolved",
    });
  });
});

describe("OxcImportAnalyzer.resolve (not installed: configs extend missing packages)", () => {
  let bare: string;
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), "metator-oxc-bare-"));
    const files: Record<string, string> = {
      "tsconfig.json": '{ "extends": "./node_modules/@x/config/base.json" }',
      // JSONC: comments and trailing commas, as tsconfig allows.
      "apps/web/tsconfig.json": `{
        // the app's own aliases
        "extends": "@x/config/next.json",
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["./*"], "@ui/*": ["../../packages/ui/src/*"], "theme": ["./theme.ts"], "a*b": ["x"], },
        },
      }`,
      "apps/web/app/page.ts": "",
      "apps/web/components/button.ts": "",
      "apps/web/theme.ts": "",
      "packages/ui/src/card.ts": "",
      "packages/utils/src/index.ts": "",
      "packages/utils/src/date.ts": "",
    };
    for (const [file, text] of Object.entries(files)) await Bun.write(join(bare, file), text);
  });
  afterAll(async () => {
    await rm(bare, { recursive: true, force: true });
  });

  test("relative imports and each app's own paths still resolve; notes say why it is approximate", () => {
    const a = new OxcImportAnalyzer(bare);
    expect(a.resolve("packages/utils/src/index.ts", "./date")).toEqual({
      type: "file",
      path: "packages/utils/src/date.ts",
    });
    expect(a.resolve("apps/web/app/page.ts", "@/components/button")).toEqual({
      type: "file",
      path: "apps/web/components/button.ts",
    });
    expect(a.resolve("apps/web/app/page.ts", "@ui/card")).toEqual({
      type: "file",
      path: "packages/ui/src/card.ts",
    });
    expect(a.resolve("apps/web/app/page.ts", "theme")).toEqual({ type: "file", path: "apps/web/theme.ts" });
    // The root tsconfig has no paths: an app alias does not resolve outside the app.
    expect(a.resolve("packages/utils/src/index.ts", "@/components/button")).toEqual({
      type: "external",
      name: "@/components",
    });
    expect([...a.notes()].sort()).toEqual([
      "apps/web/tsconfig.json extends a config that is not installed; its own paths are used as aliases. Install dependencies for exact resolution.",
      "tsconfig.json extends a config that is not installed; its own paths are used as aliases. Install dependencies for exact resolution.",
    ]);
  });

  test("an installed config gives no notes", () => {
    expect(analyzer.notes()).toEqual([]);
  });
});

describe("pathAliases", () => {
  test("a broken or path-less tsconfig gives no aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-paths-"));
    await Bun.write(join(dir, "broken.json"), "{ not json");
    await Bun.write(join(dir, "plain.json"), "{}");
    expect([pathAliases(join(dir, "broken.json")), pathAliases(join(dir, "plain.json"))]).toEqual([{}, {}]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("packageName", () => {
  test("scoped and unscoped, with subpaths", () => {
    expect(packageName("@scope/pkg/sub/path")).toBe("@scope/pkg");
    expect(packageName("lodash/fp")).toBe("lodash");
    expect(packageName("react")).toBe("react");
  });
});

describe("OxcImportAnalyzer.symbols (real oxc)", () => {
  const SOURCE = `import { a, b as c } from "./x";
import * as ns from "./y";
import def from "./z";
import type { T0 } from "./t";
export function f() {}
export const g = 1, h = 2;
export interface I {}
export default function () {}
export { a as aa } from "./x";
export * from "./w";
export * as nsx from "./v";
const local = 1;
export { local };
`;

  test("exports with lines and type-ness, re-exports with renames and stars, imports with local names", () => {
    const s = new OxcImportAnalyzer("/repo").symbols("a.ts", SOURCE)._unsafeUnwrap();
    expect(s.exports.map((e) => `${e.name}:${e.line}:${e.typeOnly}`)).toEqual([
      "f:5:false",
      "g:6:false",
      "h:6:false",
      "I:7:true",
      "default:8:false",
      "local:13:false",
    ]);
    expect(s.reexports.map((r) => `${r.specifier}:${r.imported}->${r.exported}:${r.line}`)).toEqual([
      "./x:a->aa:9",
      "./w:*->*:10",
      "./v:*->nsx:11",
    ]);
    expect(s.imports.map((i) => `${i.specifier}:${i.imported}->${i.local}:${i.line}:${i.typeOnly}`)).toEqual([
      "./x:a->a:1:false",
      "./x:b->c:1:false",
      "./y:*->ns:2:false",
      "./z:default->def:3:false",
      "./t:T0->T0:4:true",
    ]);
  });

  test("a syntax error is a PARSE_FAILED value", () => {
    expect(new OxcImportAnalyzer("/repo").symbols("a.ts", "export const = ;")._unsafeUnwrapErr().code).toBe(
      "PARSE_FAILED",
    );
  });
});
