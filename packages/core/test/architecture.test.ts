import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import {
  AnalyzeArchitecture,
  ArchitectureFacts,
  ArchitecturePolicyCatalog,
} from "../src/application/architecture.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import {
  type ArchitectureInput,
  analyzeArchitecture,
  type ExternalImport,
  manifestOf,
  matchesId,
  type PackageManifest,
  type ResolvedImport,
  ROOT_PACKAGE,
} from "../src/domain/architecture.ts";
import {
  ArchitecturePolicySchema,
  brokenTagRules,
  EMPTY_POLICY,
  layerOf,
  lintPolicy,
  matchesPackage,
  tagsOf,
} from "../src/domain/architecture-policy.ts";
import { renderArchitectureMarkdown } from "../src/domain/architecture-render.ts";
import { ok } from "../src/domain/result.ts";

const m = (dir: string, name: string, json: Record<string, unknown> = {}, extra = {}): PackageManifest =>
  manifestOf(dir, { name, ...json }, extra);
const imp = (from: string, to: string, specifier = "@x/pkg", typeOnly = false): ResolvedImport => ({
  from,
  to,
  specifier,
  typeOnly,
});
const ext = (from: string, name: string, typeOnly = false): ExternalImport => ({ from, name, typeOnly });

const WEB = m("apps/web", "@x/web", { dependencies: { "@x/ui": "workspace:*", "@x/core": "workspace:*" } });
const UI = m("packages/ui", "@x/ui", { main: "src/index.ts", dependencies: { "@x/core": "workspace:*" } });
const CORE = m("packages/core", "@x/core", { main: "src/index.ts", dependencies: { zod: "^4.0.0" } });

function input(over: Partial<ArchitectureInput> = {}): ArchitectureInput {
  return {
    files: [
      "apps/web/src/main.ts",
      "packages/ui/src/button.ts",
      "packages/ui/test/button.test.ts",
      "packages/core/src/money.ts",
    ],
    imports: [
      imp("apps/web/src/main.ts", "packages/ui/src/button.ts", "@x/ui"),
      imp("apps/web/src/main.ts", "packages/core/src/money.ts", "@x/core", true),
      imp("packages/ui/src/button.ts", "packages/core/src/money.ts", "@x/core"),
    ],
    externals: [ext("packages/core/src/money.ts", "zod")],
    unresolved: [],
    manifests: { packages: [WEB, UI, CORE] },
    policy: EMPTY_POLICY,
    policySource: null,
    today: "2026-10-29",
    ...over,
  };
}
/** Violation ids, without the unused dependencies a fixture's trimmed imports leave behind. */
const ids = (i: ArchitectureInput) =>
  analyzeArchitecture(i)
    .violations.filter((v) => v.kind !== "unused-dependency")
    .map((v) => v.id);
const policy = (raw: unknown) => ArchitecturePolicySchema.parse(raw);

describe("manifestOf", () => {
  test("reads dependencies, entry points, bin and scripts; ignores malformed fields", () => {
    const manifest = manifestOf("packages/a", {
      name: "@x/a",
      private: true,
      exports: { ".": "./src/index.ts" },
      bin: { a: "bin.js" },
      dependencies: { zod: "^4", broken: 3 },
      devDependencies: "nope",
      scripts: { build: "tsc" },
    });
    expect(manifest).toMatchObject({
      name: "@x/a",
      private: true,
      entry: true,
      bin: true,
      dependencies: { zod: "^4" },
      devDependencies: {},
      scripts: { build: "tsc" },
      tags: [],
    });
  });

  test("a nameless package is named after its directory; the root after the root", () => {
    expect(manifestOf("packages/b", {}).name).toBe("packages/b");
    expect(manifestOf(".", null).name).toBe(ROOT_PACKAGE);
    expect(manifestOf(".", {}).entry).toBe(false);
  });

  test("tags are unique and sorted; the Nx project type is kept", () => {
    expect(
      manifestOf("a", { name: "a" }, { tags: ["b", "a", "b"], projectType: "application" }),
    ).toMatchObject({
      tags: ["a", "b"],
      projectType: "application",
    });
  });
});

describe("analyzeArchitecture: the package graph", () => {
  test("edges are aggregated per package pair with import and runtime counts", () => {
    const report = analyzeArchitecture(input());
    expect(report.edges.map((e) => [e.from, e.to, e.imports, e.runtime, e.declared])).toEqual([
      ["@x/ui", "@x/core", 1, 1, "dependencies"],
      ["@x/web", "@x/core", 1, 0, "dependencies"],
      ["@x/web", "@x/ui", 1, 1, "dependencies"],
    ]);
    expect(report.edges[0]?.samples).toEqual([
      { from: "packages/ui/src/button.ts", to: "packages/core/src/money.ts" },
    ]);
  });

  test("packages carry kind, files, test files and both directions of dependency", () => {
    const report = analyzeArchitecture(input());
    expect(
      report.packages.map((p) => [p.name, p.kind, p.files, p.testFiles, p.dependsOn, p.dependents]),
    ).toEqual([
      ["@x/core", "lib", 1, 0, [], ["@x/ui", "@x/web"]],
      ["@x/ui", "lib", 2, 1, ["@x/core"], ["@x/web"]],
      ["@x/web", "app", 1, 0, ["@x/core", "@x/ui"], []],
    ]);
    expect(report.summary).toEqual({
      packages: 3,
      apps: 1,
      edges: 3,
      cycles: 0,
      errors: 0,
      warnings: 0,
      excepted: 0,
      score: 100,
    });
  });

  test("files outside every package belong to the root, which is listed only when it has files", () => {
    expect(analyzeArchitecture(input()).packages.some((p) => p.name === ROOT_PACKAGE)).toBe(false);
    const report = analyzeArchitecture(
      input({
        files: [...input().files, "scripts/build.ts"],
        imports: [...input().imports, imp("scripts/build.ts", "packages/core/src/money.ts", "@x/core")],
      }),
    );
    expect(report.packages.find((p) => p.name === ROOT_PACKAGE)).toMatchObject({ kind: "root", files: 1 });
    expect(report.summary.packages).toBe(3);
    expect(
      ids(input({ imports: [imp("scripts/build.ts", "packages/core/src/money.ts", "@x/core")] })),
    ).toEqual([]);
  });

  test("an edge whose every import comes from a test file is test-only and does not count", () => {
    const report = analyzeArchitecture(
      input({ imports: [imp("packages/ui/test/button.test.ts", "apps/web/src/main.ts", "@x/web")] }),
    );
    expect(report.edges[0]).toMatchObject({ from: "@x/ui", to: "@x/web", testOnly: true });
    expect(report.summary.edges).toBe(0);
    expect(report.packages.find((p) => p.name === "@x/ui")?.dependsOn).toEqual([]);
  });

  test("a workspace package imported by name without being linked is still a dependency", () => {
    const report = analyzeArchitecture(
      input({ imports: [], externals: [ext("apps/web/src/main.ts", "@x/ui", true)] }),
    );
    expect(report.edges).toEqual([
      {
        from: "@x/web",
        to: "@x/ui",
        imports: 1,
        runtime: 0,
        testOnly: false,
        declared: "dependencies",
        samples: [{ from: "apps/web/src/main.ts", to: "packages/ui/package.json" }],
      },
    ]);
  });

  test("ignored files are left out entirely", () => {
    const report = analyzeArchitecture(input({ policy: policy({ ignore: ["packages/ui/**"] }) }));
    expect(report.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["@x/web>@x/core"]);
  });

  test("a placement moves files to another package (what a simulated move does)", () => {
    const report = analyzeArchitecture(
      input({ placement: new Map([["packages/ui/src/button.ts", "@x/core"]]) }),
    );
    expect(report.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["@x/web>@x/core"]);
  });

  test("samples keep at most five distinct file pairs", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      imp(`packages/ui/src/f${i}.ts`, "packages/core/src/money.ts", "@x/core"),
    );
    const report = analyzeArchitecture(input({ imports: [...many, many[0] as ResolvedImport] }));
    expect(report.edges[0]?.imports).toBe(8);
    expect(report.edges[0]?.samples).toHaveLength(5);
  });
});

describe("analyzeArchitecture: kinds", () => {
  const kind = (manifest: PackageManifest, extra: Partial<ArchitectureInput> = {}) =>
    analyzeArchitecture(
      input({
        manifests: { packages: [manifest] },
        files: [`${manifest.dir}/x.ts`],
        imports: [],
        externals: [],
        ...extra,
      }),
    ).packages[0]?.kind;

  test("an app: under apps/, an Nx application, a bin nothing depends on, or a start script without an entry", () => {
    expect(kind(m("apps/api", "api", { main: "x.ts" }))).toBe("app");
    expect(kind(m("tools/cli", "cli", { main: "x.ts" }, { projectType: "application" }))).toBe("app");
    expect(kind(m("tools/cli", "cli", { bin: "x.js" }))).toBe("app");
    expect(kind(m("svc", "svc", { scripts: { start: "bun x.ts" } }))).toBe("app");
  });

  test("a library: an Nx library, an entry point, or anything others depend on", () => {
    expect(kind(m("apps/x", "x", {}, { projectType: "library" }))).toBe("lib");
    expect(kind(m("svc", "svc", { main: "x.ts", scripts: { dev: "x" } }))).toBe("lib");
    expect(kind(m("plain", "plain"))).toBe("lib");
    expect(analyzeArchitecture(input()).packages.find((p) => p.name === "@x/ui")?.kind).toBe("lib");
    const withBin = m("packages/ui", "@x/ui", { bin: "x.js", dependencies: { "@x/core": "*" } });
    const report = analyzeArchitecture(input({ manifests: { packages: [WEB, withBin, CORE] } }));
    expect(report.packages.find((p) => p.name === "@x/ui")?.kind).toBe("lib");
  });

  test("the policy has the last word", () => {
    expect(
      kind(m("apps/web", "web"), { policy: policy({ packages: [{ packages: ["apps/*"], kind: "lib" }] }) }),
    ).toBe("lib");
  });
});

describe("analyzeArchitecture: cycles", () => {
  const cyclic = (typeOnly: boolean) =>
    input({
      imports: [
        imp("packages/ui/src/button.ts", "packages/core/src/money.ts", "@x/core"),
        imp("packages/core/src/money.ts", "packages/ui/src/button.ts", "@x/ui", typeOnly),
      ],
      manifests: {
        packages: [
          WEB,
          UI,
          m("packages/core", "@x/core", { main: "x", dependencies: { "@x/ui": "*", zod: "^4" } }),
        ],
      },
    });

  test("a runtime cycle stays an error when type-only imports widen its component", () => {
    const wide = input({
      imports: [
        imp("packages/ui/src/button.ts", "packages/core/src/money.ts", "@x/core"),
        imp("packages/core/src/money.ts", "packages/ui/src/button.ts", "@x/ui"),
        imp("packages/core/src/money.ts", "apps/web/src/main.ts", "@x/web", true),
        imp("apps/web/src/main.ts", "packages/core/src/money.ts", "@x/core", true),
      ],
    });
    const report = analyzeArchitecture(wide);
    expect(report.cycles.map((c) => [c.packages, c.typeOnly])).toEqual([
      [["@x/core", "@x/ui", "@x/web"], false],
    ]);
    expect(report.violations.find((v) => v.kind === "cycle")?.severity).toBe("error");
  });

  test("packages that depend on each other are one cycle with its inner edges, an error", () => {
    const report = analyzeArchitecture(cyclic(false));
    expect(report.cycles).toEqual([
      {
        packages: ["@x/core", "@x/ui"],
        edges: [
          { from: "@x/core", to: "@x/ui", imports: 1, runtime: 1 },
          { from: "@x/ui", to: "@x/core", imports: 1, runtime: 1 },
        ],
        typeOnly: false,
        cut: [{ from: "@x/ui", to: "@x/core", imports: 1 }],
      },
    ]);
    expect(report.violations[0]).toMatchObject({ id: "cycle:@x/core,@x/ui", severity: "error" });
    expect(report.summary).toMatchObject({ cycles: 1, errors: 1 });
  });

  test("a cycle closed only through import type is marked type-only", () => {
    const report = analyzeArchitecture(cyclic(true));
    expect(report.cycles[0]?.typeOnly).toBe(true);
    expect(report.violations[0]?.message).toContain("only through import type");
    expect(report.violations.find((v) => v.kind === "cycle")?.severity).toBe("warning");
    const strict = analyzeArchitecture({ ...cyclic(true), policy: policy({ severity: { cycle: "error" } }) });
    expect(strict.violations.find((v) => v.kind === "cycle")?.severity).toBe("error");
  });

  test("test-only edges never close a cycle", () => {
    const report = analyzeArchitecture(
      input({
        imports: [
          ...input().imports,
          imp("packages/ui/test/button.test.ts", "apps/web/src/main.ts", "@x/web"),
        ],
      }),
    );
    expect(report.cycles).toEqual([]);
  });
});

describe("analyzeArchitecture: declarations", () => {
  test("a workspace package imported without being declared", () => {
    const bare = m("packages/ui", "@x/ui", { main: "x" });
    expect(ids(input({ manifests: { packages: [WEB, bare, CORE] } }))).toEqual(["undeclared:@x/ui→@x/core"]);
  });

  test("a workspace package declared only in devDependencies but imported outside tests", () => {
    const dev = m("packages/ui", "@x/ui", { main: "x", devDependencies: { "@x/core": "*" } });
    expect(ids(input({ manifests: { packages: [WEB, dev, CORE] } }))).toEqual(["dev-in-prod:@x/ui→@x/core"]);
    const testOnly = input({
      manifests: { packages: [WEB, dev, CORE] },
      imports: [imp("packages/ui/test/button.test.ts", "packages/core/src/money.ts", "@x/core")],
    });
    expect(ids(testOnly)).toEqual([]);
  });

  test("tool configuration may use devDependencies: it runs at build or check time", () => {
    const dev = m("packages/ui", "@x/ui", { main: "x", devDependencies: { "@x/core": "*", eslint: "9" } });
    const config = input({
      files: [...input().files, "packages/ui/eslint.config.js", "packages/ui/jest.setup.ts"],
      manifests: { packages: [WEB, dev, CORE] },
      imports: [imp("packages/ui/eslint.config.js", "packages/core/src/money.ts", "@x/core")],
      externals: [ext("packages/ui/eslint.config.js", "eslint"), ext("packages/ui/jest.setup.ts", "eslint")],
    });
    expect(ids(config)).toEqual([]);
  });

  test("a workspace package everyone declares only in devDependencies is a tool: its imports are dev-time", () => {
    const LINT = m("packages/lint", "@x/lint", {
      main: "index.js",
      devDependencies: { "eslint-plugin-x": "1" },
    });
    const web = m("apps/web", "@x/web", { devDependencies: { "@x/lint": "*" } });
    const tool = input({
      files: ["apps/web/src/main.ts", "packages/lint/index.js"],
      imports: [],
      externals: [ext("packages/lint/index.js", "eslint-plugin-x")],
      manifests: { packages: [web, LINT] },
    });
    expect(ids(tool)).toEqual([]);
    // Once a package declares it as a dependency, it ships: its devDependencies are in production.
    const shipped = {
      ...tool,
      manifests: { packages: [m("apps/web", "@x/web", { dependencies: { "@x/lint": "*" } }), LINT] },
    };
    expect(ids(shipped)).toEqual(["dev-in-prod:@x/lint→eslint-plugin-x"]);
  });

  test("a relative import into another package", () => {
    const report = analyzeArchitecture(
      input({
        imports: [imp("packages/ui/src/button.ts", "packages/core/src/money.ts", "../../core/src/money.ts")],
      }),
    );
    expect(report.violations.filter((v) => v.severity === "error").map((v) => v.id)).toEqual([
      "relative-import:@x/ui→@x/core",
    ]);
    expect(report.violations[0]?.evidence).toEqual([
      {
        file: "packages/ui/src/button.ts",
        to: "packages/core/src/money.ts",
        specifier: "../../core/src/money.ts",
      },
    ]);
  });

  test("a library that depends on an application", () => {
    expect(
      ids(input({ imports: [imp("packages/ui/src/button.ts", "apps/web/src/main.ts", "@x/web")] })),
    ).toEqual(["app-import:@x/ui→@x/web", "undeclared:@x/ui→@x/web"]);
  });

  test("external packages: undeclared, only in the root, or dev-only in production code", () => {
    const report = analyzeArchitecture(
      input({
        externals: [
          ext("packages/core/src/money.ts", "zod"),
          ext("packages/core/src/money.ts", "lodash"),
          ext("packages/core/src/money.ts", "@scope/tool"),
          ext("packages/ui/src/button.ts", "react"),
          ext("packages/ui/src/button.ts", "csstype", true),
          ext("packages/ui/test/button.test.ts", "vitest"),
        ],
        manifests: {
          root: m(".", "root", { devDependencies: { "@scope/tool": "1" } }),
          packages: [
            WEB,
            m("packages/ui", "@x/ui", {
              main: "x",
              dependencies: { "@x/core": "*" },
              devDependencies: { react: "19", csstype: "3", vitest: "3" },
            }),
            CORE,
          ],
        },
      }),
    );
    expect(report.violations.map((v) => [v.id, v.severity])).toEqual([
      ["dev-in-prod:@x/ui→react", "error"],
      ["undeclared:@x/core→lodash", "error"],
      ["root-only:@x/core→@scope/tool", "warning"],
    ]);
  });

  test("a package whose @types are declared is declared: its types are what the import uses", () => {
    const withTypes = (devDependencies: Record<string, string>) =>
      ids(
        input({
          externals: [
            ext("packages/core/src/guard.ts", "express"),
            ext("packages/core/src/x.ts", "@scope/lib"),
          ],
          manifests: {
            packages: [m("packages/core", "@x/core", { main: "x", devDependencies })],
          },
        }),
      ).filter((id) => id.startsWith("undeclared"));
    expect(withTypes({ "@types/express": "5", "@types/scope__lib": "1" })).toEqual([]);
    expect(withTypes({})).toEqual(["undeclared:@x/core→@scope/lib", "undeclared:@x/core→express"]);
  });

  test("builtins, invalid names, root files and the package itself are not external dependencies", () => {
    expect(
      ids(
        input({
          externals: [
            ext("packages/core/src/money.ts", "zod"),
            ext("packages/core/src/money.ts", "node:fs"),
            ext("packages/core/src/money.ts", "bun:test"),
            ext("packages/core/src/money.ts", "bun"),
            ext("packages/core/load/test.js", "k6"),
            ext("packages/core/src/money.ts", "~/alias"),
            ext("packages/core/src/money.ts", "#internal"),
            ext("packages/core/src/money.ts", "@x/core"),
            ext("scripts/x.ts", "lodash"),
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("a declared dependency nothing imports is a warning; scripts and @types count as uses", () => {
    const core = m("packages/core", "@x/core", {
      main: "x",
      dependencies: { zod: "^4", unused: "1", "@types/node": "1", rimraf: "1" },
      scripts: { clean: "rimraf dist" },
    });
    const report = analyzeArchitecture(input({ manifests: { packages: [WEB, UI, core] } }));
    expect(report.violations.map((v) => [v.id, v.severity, v.evidence])).toEqual([
      [
        "unused-dependency:@x/core→unused",
        "warning",
        [{ file: "packages/core/package.json", specifier: "unused" }],
      ],
    ]);
  });

  test("one dependency declared with several ranges is drift; workspace protocols are not ranges", () => {
    const report = analyzeArchitecture(
      input({
        manifests: {
          root: m(".", "root", { devDependencies: { zod: "4.0.0" } }),
          packages: [
            WEB,
            m("packages/ui", "@x/ui", { main: "x", dependencies: { "@x/core": "workspace:^" } }),
            CORE,
          ],
        },
      }),
    );
    expect(report.violations.map((v) => [v.id, v.packages])).toEqual([
      ["version-drift:zod", ["@x/core", "root"]],
    ]);
    expect(report.violations[0]?.message).toBe(
      "zod is declared with 2 ranges: ^4.0.0 (@x/core); 4.0.0 (root)",
    );
  });
});

describe("analyzeArchitecture: policy", () => {
  const layered = policy({
    layers: [
      { name: "apps", packages: ["apps/*"] },
      { name: "features", tags: ["type:feature"] },
      { name: "shared", packages: ["@x/core"] },
    ],
    packages: [{ packages: ["@x/ui"], tags: ["type:feature"] }],
  });

  test("layers: a dependency on a layer above is an error; the same or a lower layer is fine", () => {
    const report = analyzeArchitecture(input({ policy: layered }));
    expect(report.packages.map((p) => p.layer)).toEqual(["shared", "features", "apps"]);
    expect(report.violations).toEqual([]);
    const up = input({
      policy: layered,
      imports: [...input().imports, imp("packages/core/src/money.ts", "packages/ui/src/button.ts", "@x/ui")],
    });
    expect(ids(up)).toContain("layer:@x/core→@x/ui");
    expect(analyzeArchitecture(up).violations.find((v) => v.kind === "layer")?.message).toBe(
      "@x/core (layer shared) depends on @x/ui (layer features, above it)",
    );
  });

  test("with layers, a package in none is a warning", () => {
    const partial = policy({ layers: [{ name: "apps", packages: ["apps/*"] }] });
    expect(ids(input({ policy: partial }))).toEqual(["unlayered:@x/core", "unlayered:@x/ui"]);
  });

  test("tag rules: allow and deny", () => {
    const tagged = policy({
      packages: [
        { packages: ["@x/web"], tags: ["scope:shop"] },
        { packages: ["@x/ui"], tags: ["scope:shared", "type:ui"] },
        { packages: ["@x/core"], tags: ["scope:billing"] },
      ],
      rules: [
        { from: "scope:shop", allow: ["scope:shop", "scope:shared"] },
        { from: "type:ui", deny: ["scope:billing"] },
      ],
    });
    const report = analyzeArchitecture(input({ policy: tagged }));
    expect(report.violations.map((v) => [v.id, v.message])).toEqual([
      ["tag:@x/ui→@x/core", "@x/ui → @x/core: type:ui must not depend on scope:billing"],
      ["tag:@x/web→@x/core", "@x/web → @x/core: scope:shop may depend only on scope:shop, scope:shared"],
    ]);
  });

  const bare = { manifests: { packages: [WEB, m("packages/ui", "@x/ui", { main: "x" }), CORE] } };

  test("an exception covers a violation until it expires; then the violation and the expiry are errors", () => {
    const covered = analyzeArchitecture(
      input({
        ...bare,
        policy: policy({
          exceptions: [
            { violation: "undeclared:*", reason: "migrating", owner: "@team", expires: "2026-12-31" },
          ],
        }),
      }),
    );
    expect(covered.violations[0]?.exception).toEqual({
      reason: "migrating",
      owner: "@team",
      expires: "2026-12-31",
    });
    expect(covered.summary).toMatchObject({ errors: 0, excepted: 1, score: 100 });

    const expired = analyzeArchitecture(
      input({
        ...bare,
        policy: policy({
          exceptions: [
            { violation: "undeclared:@x/ui→@x/core", reason: "r", owner: "@team", expires: "2026-10-28" },
          ],
        }),
      }),
    );
    expect(expired.violations.map((v) => [v.id, v.severity, v.exception])).toEqual([
      ["expired-exception:undeclared:@x/ui→@x/core", "error", undefined],
      ["undeclared:@x/ui→@x/core", "error", undefined],
    ]);
  });

  test("an exception that matches nothing is a warning to remove it", () => {
    const report = analyzeArchitecture(
      input({
        policy: policy({
          exceptions: [{ violation: "cycle:*", reason: "r", owner: "@o", expires: "2027-01-01" }],
        }),
      }),
    );
    expect(report.violations.map((v) => [v.id, v.severity])).toEqual([
      ["unused-exception:cycle:*", "warning"],
    ]);
  });

  test("severities: a kind can be raised, lowered or turned off", () => {
    expect(
      analyzeArchitecture(input({ ...bare, policy: policy({ severity: { undeclared: "warning" } }) }))
        .violations[0]?.severity,
    ).toBe("warning");
    expect(ids(input({ ...bare, policy: policy({ severity: { undeclared: "off" } }) }))).toEqual([]);
    expect(
      ids(
        input({
          policy: policy({
            severity: { "unused-exception": "off" },
            exceptions: [{ violation: "x", reason: "r", owner: "o", expires: "2027-01-01" }],
          }),
        }),
      ),
    ).toEqual([]);
  });

  test("errors come before warnings, each sorted by id", () => {
    const report = analyzeArchitecture(
      input({
        ...bare,
        externals: [ext("packages/core/src/money.ts", "zod"), ext("packages/core/src/money.ts", "lodash")],
        policy: policy({ layers: [{ name: "apps", packages: ["apps/*"] }] }),
      }),
    );
    expect(report.violations.map((v) => v.id)).toEqual([
      "undeclared:@x/core→lodash",
      "undeclared:@x/ui→@x/core",
      "unlayered:@x/core",
      "unlayered:@x/ui",
    ]);
    expect(report.summary.score).toBe(88);
  });

  test("unresolved imports are counted, with a sample of fifty", () => {
    const unresolved = Array.from({ length: 60 }, (_, i) => ({ from: "a.ts", specifier: `./x${i}` }));
    expect(analyzeArchitecture(input({ unresolved })).unresolved).toMatchObject({ count: 60 });
    expect(analyzeArchitecture(input({ unresolved })).unresolved.sample).toHaveLength(50);
  });
});

describe("policy helpers", () => {
  test("package patterns match a name or a directory, exactly or as a glob", () => {
    const pkg = { name: "@shop/ui-kit", dir: "packages/ui-kit" };
    expect(
      ["@shop/ui-kit", "packages/ui-kit", "@shop/ui-*", "packages/*"].map((p) => matchesPackage(p, pkg)),
    ).toEqual([true, true, true, true]);
    expect(matchesPackage("apps/*", pkg)).toBe(false);
  });

  test("tags merge the package's own with the policy's; layers prefer an explicit package rule", () => {
    const p = policy({
      layers: [
        { name: "top", tags: ["t"] },
        { name: "bottom", packages: ["b"] },
      ],
      packages: [{ packages: ["b"], tags: ["t", "z"], layer: "bottom" }],
    });
    const pkg = { name: "b", dir: "b", tags: ["a"] };
    expect(tagsOf(p, pkg)).toEqual(["a", "t", "z"]);
    expect(layerOf(p, pkg, tagsOf(p, pkg))).toBe(1);
    expect(layerOf(p, { name: "c", dir: "c" }, ["t"])).toBe(0);
    expect(layerOf(p, { name: "d", dir: "d" }, [])).toBeUndefined();
    const top = policy({
      layers: [{ name: "top", tags: ["t"] }],
      packages: [{ packages: ["e"], layer: "top" }],
    });
    expect(layerOf(top, { name: "e", dir: "e" }, [])).toBe(0);
  });

  test("a `to` rule judges who depends on the tagged package", () => {
    const p = policy({
      rules: [
        { to: "type:internal", allow: ["scope:billing"] },
        { to: "type:db", deny: ["type:ui"] },
      ],
    });
    expect(brokenTagRules(p, ["scope:billing"], ["type:internal"])).toEqual([]);
    expect(brokenTagRules(p, ["scope:shop"], ["type:internal"])).toEqual([
      "only scope:billing may depend on type:internal",
    ]);
    expect(brokenTagRules(p, ["type:ui"], ["type:db"])).toEqual(["type:ui must not depend on type:db"]);
    expect(brokenTagRules(p, ["type:ui"], ["type:other"])).toEqual([]);
  });

  test("a rule names exactly one of from and to", () => {
    expect(() => policy({ rules: [{ from: "a", to: "b", allow: ["*"] }] })).toThrow(
      "a rule names either from or to",
    );
    expect(() => policy({ rules: [{ allow: ["*"] }] })).toThrow("a rule names either from or to");
  });

  test("tag rules apply to `*` and allow `*`", () => {
    const p = policy({ rules: [{ from: "*", allow: ["*"], deny: ["legacy"] }] });
    expect(brokenTagRules(p, [], ["a"])).toEqual([]);
    expect(brokenTagRules(p, [], ["legacy"])).toEqual(["* must not depend on legacy"]);
  });

  test("lint: duplicate layers and unknown layer names", () => {
    expect(
      lintPolicy(
        policy({
          layers: [
            { name: "a", tags: ["x"] },
            { name: "a", tags: ["y"] },
          ],
          packages: [{ packages: ["p"], layer: "nope" }],
        }),
      ),
    ).toEqual(["two layers are named a", "packages p name the layer nope, which is not in layers"]);
  });

  test("the schema refuses empty layers and rules without allow or deny", () => {
    expect(() => policy({ layers: [{ name: "a" }] })).toThrow("a layer lists packages or tags");
    expect(() => policy({ rules: [{ from: "x" }] })).toThrow("a rule allows or denies tags");
  });

  test("exception ids: exact, or `*` for any text", () => {
    expect(matchesId("cycle:*", "cycle:@a/x,@a/y")).toBe(true);
    expect(matchesId("undeclared:@x/*→lodash", "undeclared:@x/ui→lodash")).toBe(true);
    expect(matchesId("undeclared:@x/ui→lodash", "undeclared:@x/ui→lodash")).toBe(true);
    expect(matchesId("cycle:a.b", "cycle:aXb")).toBe(false);
    expect(matchesId("cycle", "cycle:a")).toBe(false);
  });
});

describe("renderArchitectureMarkdown", () => {
  test("summary, cycles, violations with evidence and the package table", () => {
    const report = analyzeArchitecture(
      input({ manifests: { packages: [WEB, m("packages/ui", "@x/ui", { main: "x" }), CORE] } }),
    );
    const md = renderArchitectureMarkdown(report);
    expect(md).toContain("| 95 | 3 | 1 | 3 | 0 | 1 | 0 | 0 |");
    expect(md).toContain("No package depends on itself through others.");
    expect(md).toContain(
      "- **undeclared** @x/ui imports the workspace package @x/core without declaring it in package.json — `packages/ui/src/button.ts` → `packages/core/src/money.ts`",
    );
    expect(md).toContain("| @x/web | app | — | 1 | @x/core, @x/ui | — |");
    expect(md).toContain("Every import resolved.");
  });
});

describe("renderArchitectureMarkdown: exceptions", () => {
  test("excepted violations are listed apart, with owner and expiry, and do not count", () => {
    const report = analyzeArchitecture(
      input({
        manifests: { packages: [WEB, m("packages/ui", "@x/ui", { main: "x" }), CORE] },
        policy: policy({
          exceptions: [
            { violation: "undeclared:*", reason: "migrating", owner: "@team", expires: "2026-12-31" },
          ],
        }),
      }),
    );
    const md = renderArchitectureMarkdown(report);
    expect(md).toContain("## Violations\n\nNone.");
    expect(md).toContain("### Excepted (1)");
    expect(md).toContain("  - excepted until 2026-12-31 by @team: migrating");
  });
});

describe("AnalyzeArchitecture", () => {
  const facts = (raw: Partial<ArchitectureInput> = {}) => ({ gather: async () => ok(input(raw)) });

  test("writes the report as a versioned JSON document, as Markdown and as HTML", async () => {
    const fs = new InMemoryFileSystem();
    const analyzed = (await new AnalyzeArchitecture(facts(), fs, DEFAULT_PATHS).execute())._unsafeUnwrap();
    expect(analyzed.files).toEqual({
      json: ".metator/arch/report.json",
      markdown: ".metator/arch/report.md",
      html: ".metator/arch/report.html",
    });
    expect((await fs.read(".metator/arch/report.html"))._unsafeUnwrap()).toStartWith("<!doctype html>");
    const json = JSON.parse((await fs.read(".metator/arch/report.json"))._unsafeUnwrap());
    expect([json.kind, json.schemaVersion, json.summary.score]).toEqual(["ArchitectureReport", 2, 100]);
    expect((await fs.read(".metator/arch/report.md"))._unsafeUnwrap()).toStartWith("# Architecture report");
  });

  test("facts: the graph, manifests, policy and today's date", async () => {
    const fs = new InMemoryFileSystem({
      "metator/architecture.yml":
        "kind: ArchitecturePolicy\nschemaVersion: 1\nlayers:\n  - name: apps\n    packages: [apps/*]\n",
    });
    const graph = {
      execute: async () =>
        ok({
          files: ["a.ts"],
          edges: [],
          packages: [],
          externals: [],
          externalUses: [{ from: "a.ts", name: "zod", typeOnly: false }],
          imports: [imp("a.ts", "b.ts")],
          unresolved: [],
          stats: { parsed: 1, reused: 0, failed: 0 },
          parseErrors: [],
        }),
    };
    const gathered = (
      await new ArchitectureFacts(
        graph,
        { manifests: async () => ok({ packages: [CORE] }) },
        new ArchitecturePolicyCatalog(fs, "metator/architecture.yml"),
        { now: () => new Date("2026-10-29T23:00:00Z") },
      ).gather()
    )._unsafeUnwrap();
    expect(gathered).toMatchObject({
      files: ["a.ts"],
      imports: [imp("a.ts", "b.ts")],
      externals: [ext("a.ts", "zod")],
      manifests: { packages: [CORE] },
      policySource: "metator/architecture.yml",
      today: "2026-10-29",
    });
    expect(gathered.policy.layers.map((l) => l.name)).toEqual(["apps"]);
  });
});

describe("ArchitecturePolicyCatalog", () => {
  test("no file is the defaults", async () => {
    const loaded = (
      await new ArchitecturePolicyCatalog(new InMemoryFileSystem(), "p.yml").load()
    )._unsafeUnwrap();
    expect(loaded).toEqual({ policy: EMPTY_POLICY, source: null });
  });

  test("an invalid policy is INVALID_CONFIG with the first problem", async () => {
    const fs = new InMemoryFileSystem({
      "p.yml": "kind: ArchitecturePolicy\nschemaVersion: 1\npackages:\n  - packages: [a]\n    layer: nope\n",
    });
    const e = (await new ArchitecturePolicyCatalog(fs, "p.yml").load())._unsafeUnwrapErr();
    expect([e.code, e.message]).toEqual([
      "INVALID_CONFIG",
      "p.yml: packages a name the layer nope, which is not in layers",
    ]);
    const bad = new InMemoryFileSystem({
      "p.yml": "kind: ArchitecturePolicy\nschemaVersion: 1\nlayers: 3\n",
    });
    expect((await new ArchitecturePolicyCatalog(bad, "p.yml").load())._unsafeUnwrapErr().code).toBe(
      "INVALID_CONFIG",
    );
  });
});
