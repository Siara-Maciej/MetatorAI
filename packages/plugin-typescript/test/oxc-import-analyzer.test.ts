import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonorepo } from "@metator/testing";
import { OxcImportAnalyzer, packageName } from "../src/oxc-import-analyzer.ts";

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

  test("a broken relative import is unresolved", () => {
    expect(analyzer.resolve("packages/billing/src/broken.ts", "./does-not-exist")).toEqual({
      type: "unresolved",
    });
  });
});

describe("packageName", () => {
  test("scoped and unscoped, with subpaths", () => {
    expect(packageName("@scope/pkg/sub/path")).toBe("@scope/pkg");
    expect(packageName("lodash/fp")).toBe("lodash");
    expect(packageName("react")).toBe("react");
  });
});
