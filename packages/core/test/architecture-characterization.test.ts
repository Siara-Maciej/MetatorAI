/**
 * Characterization of `analyzeArchitecture`: the complete report, byte for byte, for inputs that
 * together go through every phase of the analysis (edges, cycles, externals, unused declarations,
 * version ranges, layers and tags, metrics and boundaries, modules inside packages, exceptions).
 * The expected reports are the `ArchitectureReport` documents in `test/fixtures/architecture`;
 * they describe what the analysis does, and change only with a deliberate change of it
 * (`UPDATE_ARCH_FIXTURES=1 bun test packages/core/test/architecture-characterization.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { analyzeArchitecture } from "../src/domain/architecture.ts";
import type {
  ArchitectureInput,
  ExternalImport,
  ResolvedImport,
} from "../src/domain/architecture-context.ts";
import { manifestOf, type PackageManifest } from "../src/domain/architecture-manifests.ts";
import {
  ArchitecturePolicySchema,
  EMPTY_POLICY,
  VIOLATION_KINDS,
} from "../src/domain/architecture-policy.ts";
import { ArchitectureReportDocument } from "../src/domain/architecture-report.ts";
import type { ResolvedModule } from "../src/domain/symbols.ts";
import { serializeJsonDocument } from "../src/domain/versioned.ts";

const m = (dir: string, name: string, json: Record<string, unknown> = {}, extra = {}): PackageManifest =>
  manifestOf(dir, { name, ...json }, extra);
const imp = (from: string, to: string, specifier: string, typeOnly = false): ResolvedImport => ({
  from,
  to,
  specifier,
  typeOnly,
});
const ext = (from: string, name: string, typeOnly = false): ExternalImport => ({ from, name, typeOnly });
const policy = (raw: unknown) => ArchitecturePolicySchema.parse(raw);
const ws = "workspace:*";

/** modules({ file: { exports: [name | [name, typeOnly]], reexports: [[target, imported, exported]], imports: [[target, imported]] } }) */
function modules(
  spec: Record<
    string,
    {
      exports?: (string | [string, boolean])[];
      reexports?: [string, string, string][];
      imports?: [string, string][];
    }
  >,
): Map<string, ResolvedModule> {
  return new Map(
    Object.entries(spec).map(([file, s]) => [
      file,
      {
        exports: (s.exports ?? []).map((e, i) =>
          typeof e === "string"
            ? { name: e, line: i + 1, typeOnly: false }
            : { name: e[0], line: i + 1, typeOnly: e[1] },
        ),
        reexports: (s.reexports ?? []).map(([target, imported, exported], i) => ({
          specifier: `./${target}`,
          target,
          imported,
          exported,
          line: i + 1,
        })),
        imports: (s.imports ?? []).map(([target, imported], i) => ({
          specifier: `./${target}`,
          target,
          imported,
          local: imported,
          line: i + 1,
          typeOnly: false,
        })),
      },
    ]),
  );
}

/** Declarations and edges: every way a dependency can be wrong, exceptions, ignored and root files. */
function declarations(): ArchitectureInput {
  const root = m(".", "shop", {
    devDependencies: { hoisted: "^1.0.0", zod: "^3.0.0", typescript: "^5.0.0" },
  });
  const web = m("apps/web", "@shop/web", {
    private: true,
    scripts: { start: "node dist/main.js", lint: "scripted-tool ." },
    dependencies: {
      "@shop/ui": ws,
      "@shop/core": ws,
      zod: "^4.0.0",
      "scripted-tool": "^1.0.0",
      unused: "^1.0.0",
    },
    devDependencies: { "@shop/testing": ws, "dev-lib": "^2.0.0", "@types/express": "^5.0.0" },
  });
  const admin = m("apps/admin", "@shop/admin", { private: true, dependencies: { "@shop/web": ws } });
  const ui = m("packages/ui", "@shop/ui", {
    main: "src/index.ts",
    dependencies: { "@shop/core": ws, zod: "^3.0.0" },
    devDependencies: { "@shop/db": ws },
    optionalDependencies: { zod: "^3.0.0" },
  });
  const core = m("packages/core", "@shop/core", {
    main: "src/index.ts",
    dependencies: { "@shop/ui": ws },
    peerDependencies: { react: "^19.0.0" },
  });
  const db = m("packages/db", "@shop/db", {
    private: true,
    main: "src/index.ts",
    dependencies: { "@shop/types": ws },
  });
  const types = m("packages/types", "@shop/types", {
    main: "src/index.ts",
    dependencies: { "@shop/db": ws },
  });
  const testing = m("packages/testing", "@shop/testing", { private: true, main: "src/index.ts" });
  const config = m("tools/config", "@shop/config", { private: true });
  const lonely = m("packages/lonely", "@shop/lonely", { private: true, main: "src/index.ts" });
  return {
    files: [
      "scripts/release.ts",
      "apps/web/src/main.ts",
      "apps/web/src/page.ts",
      "apps/web/test/main.test.ts",
      "apps/web/vite.config.ts",
      "apps/web/generated/client.ts",
      "apps/admin/src/main.ts",
      "packages/ui/src/index.ts",
      "packages/ui/src/button.ts",
      "packages/ui/src/button.test.ts",
      "packages/core/src/index.ts",
      "packages/core/src/money.ts",
      "packages/db/src/index.ts",
      "packages/types/src/index.ts",
      "packages/testing/src/index.ts",
      "tools/config/index.ts",
      "packages/lonely/src/index.ts",
    ],
    imports: [
      imp("scripts/release.ts", "packages/core/src/index.ts", "@shop/core"),
      imp("apps/web/src/main.ts", "packages/ui/src/index.ts", "@shop/ui"),
      imp("apps/web/src/main.ts", "packages/ui/src/button.ts", "../../../packages/ui/src/button.ts"),
      imp("apps/web/src/page.ts", "packages/core/src/money.ts", "@shop/core", true),
      imp("apps/web/src/page.ts", "packages/db/src/index.ts", "@shop/db"),
      imp("apps/web/test/main.test.ts", "packages/testing/src/index.ts", "@shop/testing"),
      imp("apps/web/generated/client.ts", "packages/types/src/index.ts", "@shop/types"),
      imp("apps/admin/src/main.ts", "apps/web/src/page.ts", "@shop/web"),
      imp("packages/ui/src/button.ts", "packages/core/src/money.ts", "@shop/core"),
      imp("packages/ui/src/button.ts", "packages/db/src/index.ts", "@shop/db"),
      imp("packages/ui/src/button.test.ts", "packages/testing/src/index.ts", "@shop/testing"),
      imp("packages/core/src/money.ts", "packages/ui/src/index.ts", "@shop/ui"),
      imp("packages/core/src/index.ts", "packages/core/src/money.ts", "./money.ts"),
      imp("packages/db/src/index.ts", "packages/types/src/index.ts", "@shop/types", true),
      imp("packages/types/src/index.ts", "packages/db/src/index.ts", "@shop/db", true),
      imp("packages/core/src/money.ts", "scripts/release.ts", "../../../scripts/release.ts"),
    ],
    externals: [
      ext("apps/web/src/main.ts", "zod"),
      ext("apps/web/src/main.ts", "express", true),
      ext("apps/web/src/main.ts", "dev-lib"),
      ext("apps/web/src/main.ts", "hoisted"),
      ext("apps/web/src/main.ts", "node:fs"),
      ext("apps/web/src/main.ts", "Not A Package"),
      ext("apps/web/src/page.ts", "missing"),
      ext("apps/web/src/page.ts", "@shop/config"),
      ext("apps/web/test/main.test.ts", "dev-lib"),
      ext("apps/web/test/main.test.ts", "bun:test"),
      ext("apps/web/vite.config.ts", "dev-lib"),
      ext("apps/web/generated/client.ts", "ignored-lib"),
      ext("packages/ui/src/button.ts", "zod"),
      ext("packages/core/src/money.ts", "react", true),
      ext("scripts/release.ts", "typescript"),
      ext("tools/config/index.ts", "missing"),
    ],
    unresolved: [{ from: "apps/web/src/main.ts", specifier: "./gone.ts" }],
    manifests: { root, packages: [web, admin, ui, core, db, types, testing, config, lonely] },
    policy: policy({
      ignore: ["**/generated/**"],
      severity: { "root-only": "error", "unused-dependency": "off" },
      exceptions: [
        { violation: "cycle:*", reason: "being untangled", owner: "ann", expires: "2027-01-01" },
        { violation: "app-import:@shop/admin→@shop/web", reason: "old", owner: "bob", expires: "2026-01-01" },
        { violation: "layer:nothing", reason: "stale", owner: "cid", expires: "2027-01-01" },
      ],
    }),
    policySource: "metator/architecture.yml",
    today: "2026-10-29",
  };
}

/** Layers, tags, kinds, thresholds, metrics, boundaries, owners, history, a simulated placement. */
function boundaries(): ArchitectureInput {
  const app = m("apps/shop", "@b/shop", {
    private: true,
    dependencies: { "@b/feature": ws, "@b/data": ws, "@b/kit": ws },
  });
  const cli = m("tools/cli", "@b/cli", {
    private: true,
    bin: { b: "bin.js" },
    dependencies: { "@b/kit": ws, "@b/data": ws },
  });
  const feature = m(
    "libs/feature",
    "@b/feature",
    { private: true, main: "src/index.ts", dependencies: { "@b/data": ws, "@b/kit": ws, "@b/util": ws } },
    { tags: ["scope:shop", "type:feature"], projectType: "library" },
  );
  const data = m(
    "libs/data",
    "@b/data",
    { private: true, main: "src/index.ts", dependencies: { "@b/kit": ws, "@b/util": ws, "@b/feature": ws } },
    { tags: ["type:data"] },
  );
  const kit = m("libs/kit", "@b/kit", {
    main: "src/index.ts",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@b/util": ws },
  });
  const util = m("libs/util", "@b/util", { private: true, main: "src/index.ts" });
  const helper = m("libs/helper", "@b/helper", { private: true, main: "src/index.ts" });
  const orphan = m("libs/orphan", "@b/orphan", { private: true, main: "src/index.ts" });
  const extra = m("libs/extracted", "@b/extracted", { private: true, main: "src/index.ts" });
  const kitFiles = ["a1", "a2", "a3", "b1", "b2", "b3", "c1"].map((f) => `libs/kit/src/${f}.ts`);
  return {
    files: [
      "apps/shop/src/main.ts",
      "apps/shop/src/routes.ts",
      "tools/cli/src/main.ts",
      "libs/feature/src/index.ts",
      "libs/feature/src/cart.ts",
      "libs/feature/src/cart.spec.ts",
      "libs/data/src/index.ts",
      "libs/data/src/repo.ts",
      "libs/kit/src/index.ts",
      ...kitFiles,
      "libs/util/src/index.ts",
      "libs/helper/src/index.ts",
      "libs/orphan/src/index.ts",
      "libs/data/src/moved.ts",
    ],
    imports: [
      imp("apps/shop/src/main.ts", "libs/feature/src/index.ts", "@b/feature"),
      imp("apps/shop/src/main.ts", "apps/shop/src/routes.ts", "./routes.ts"),
      imp("apps/shop/src/routes.ts", "libs/data/src/index.ts", "@b/data"),
      imp("apps/shop/src/routes.ts", "libs/kit/src/a1.ts", "@b/kit/a1"),
      imp("tools/cli/src/main.ts", "libs/kit/src/b1.ts", "@b/kit/b1"),
      imp("tools/cli/src/main.ts", "libs/data/src/index.ts", "@b/data"),
      imp("libs/feature/src/index.ts", "libs/feature/src/cart.ts", "./cart.ts"),
      imp("libs/feature/src/cart.ts", "libs/data/src/repo.ts", "@b/data"),
      imp("libs/feature/src/cart.ts", "libs/kit/src/index.ts", "@b/kit"),
      imp("libs/feature/src/cart.ts", "libs/util/src/index.ts", "@b/util"),
      imp("libs/feature/src/cart.spec.ts", "libs/helper/src/index.ts", "@b/helper"),
      imp("libs/data/src/index.ts", "libs/data/src/repo.ts", "./repo.ts"),
      imp("libs/data/src/repo.ts", "libs/kit/src/a2.ts", "@b/kit/a2"),
      imp("libs/data/src/repo.ts", "libs/util/src/index.ts", "@b/util"),
      imp("libs/data/src/repo.ts", "libs/feature/src/cart.ts", "@b/feature", true),
      imp("libs/kit/src/index.ts", "libs/kit/src/a1.ts", "./a1.ts"),
      imp("libs/kit/src/a1.ts", "libs/kit/src/a2.ts", "./a2.ts"),
      imp("libs/kit/src/a2.ts", "libs/kit/src/a3.ts", "./a3.ts"),
      imp("libs/kit/src/b1.ts", "libs/kit/src/b2.ts", "./b2.ts"),
      imp("libs/kit/src/b2.ts", "libs/kit/src/b3.ts", "./b3.ts"),
      imp("libs/kit/src/a3.ts", "libs/util/src/index.ts", "@b/util"),
      imp("libs/data/src/moved.ts", "libs/util/src/index.ts", "@b/util"),
    ],
    externals: [],
    unresolved: [],
    manifests: { packages: [app, cli, feature, data, kit, util, helper, orphan] },
    extraPackages: [extra],
    placement: new Map([["libs/data/src/moved.ts", "@b/extracted"]]),
    policy: policy({
      packages: [
        { packages: ["@b/kit"], tags: ["type:kit"], kind: "lib" },
        { packages: ["libs/util"], tags: ["type:util"] },
        { packages: ["@b/shop"], tags: ["type:app"] },
      ],
      layers: [
        { name: "apps", packages: ["apps/*", "tools/*"] },
        { name: "features", tags: ["type:feature"] },
        { name: "data", tags: ["type:data"] },
        { name: "shared", tags: ["type:kit", "type:util"] },
      ],
      rules: [
        { from: "type:data", deny: ["type:feature"] },
        { to: "type:util", allow: ["type:feature", "type:kit"] },
      ],
      thresholds: { fanOut: 2, fanIn: 2, files: 5, depth: 2, distance: 0.5 },
    }),
    policySource: null,
    today: "2026-10-29",
    owners: new Map([
      ["@b/shop", ["@team/shop"]],
      ["@b/feature", ["@team/shop"]],
      ["@b/data", ["@team/data", "@team/core"]],
      ["@b/kit", ["@team/core"]],
    ]),
    history: [
      ["libs/feature/src/cart.ts", "libs/data/src/repo.ts"],
      ["libs/feature/src/cart.ts", "libs/data/src/repo.ts", "README.md"],
      ["libs/feature/src/cart.ts", "libs/data/src/repo.ts", "libs/kit/src/a1.ts"],
      ["libs/kit/src/a1.ts", "libs/util/src/index.ts"],
      ["libs/kit/src/a2.ts", "libs/util/src/index.ts"],
      ["libs/kit/src/a3.ts", "libs/util/src/index.ts", "libs/orphan/src/index.ts"],
    ],
    modules: modules({
      "apps/shop/src/main.ts": {
        exports: ["default", "boot"],
        imports: [["libs/feature/src/index.ts", "cart"]],
      },
      "apps/shop/src/routes.ts": {
        exports: ["routes", "unusedRoute"],
        imports: [
          ["libs/data/src/index.ts", "repo"],
          ["libs/kit/src/a1.ts", "a1"],
        ],
      },
      "tools/cli/src/main.ts": { imports: [["libs/kit/src/b1.ts", "b1"]] },
      "libs/feature/src/index.ts": { reexports: [["libs/feature/src/cart.ts", "cart", "cart"]] },
      "libs/feature/src/cart.ts": {
        exports: ["cart", ["CartOptions", true], "internalOnly"],
        imports: [
          ["libs/data/src/repo.ts", "repo"],
          ["libs/kit/src/index.ts", "a1"],
          ["libs/util/src/index.ts", "*"],
        ],
      },
      "libs/feature/src/cart.spec.ts": { imports: [["libs/feature/src/cart.ts", "internalOnly"]] },
      "libs/data/src/index.ts": { reexports: [["libs/data/src/repo.ts", "*", "*"]] },
      "libs/data/src/repo.ts": { exports: ["repo", "deadRepo"], imports: [["libs/kit/src/a2.ts", "a2"]] },
      "libs/kit/src/index.ts": { reexports: [["libs/kit/src/a1.ts", "a1", "a1"]] },
      "libs/kit/src/a1.ts": { exports: ["a1"], imports: [["libs/kit/src/a2.ts", "a2"]] },
      "libs/kit/src/a2.ts": { exports: ["a2"], imports: [["libs/kit/src/a3.ts", "a3"]] },
      "libs/kit/src/a3.ts": { exports: ["a3", "a3unused"] },
      "libs/kit/src/b1.ts": { exports: ["b1"], imports: [["libs/kit/src/b2.ts", "b2"]] },
      "libs/kit/src/b2.ts": { exports: ["b2"], imports: [["libs/kit/src/b3.ts", "b3"]] },
      "libs/kit/src/b3.ts": { exports: ["b3"] },
      "libs/kit/src/c1.ts": { exports: ["c1"] },
      "libs/util/src/index.ts": { exports: ["sum", ["Num", true]] },
      "libs/orphan/src/index.ts": { exports: ["orphan"] },
    }),
  };
}

/** A modular monolith: modules inside one package, their public parts and cycles; nothing else set. */
function monolith(): ArchitectureInput {
  const M = "apps/api/src/module";
  const api = m("apps/api", "@m/api", {
    private: true,
    scripts: { start: "nest start" },
    dependencies: { "@m/lib": ws, "left-pad": "^1.0.0" },
  });
  const lib = m("packages/lib", "@m/lib", {
    private: true,
    main: "src/index.ts",
    devDependencies: { "@m/api": ws },
  });
  return {
    files: [
      "apps/api/src/main.ts",
      `${M}/users/users.service.ts`,
      `${M}/users/contracts/get-user.query.ts`,
      `${M}/users/users.service.spec.ts`,
      `${M}/auth/auth.service.ts`,
      `${M}/orders/orders.service.ts`,
      `${M}/orders/order.entity.ts`,
      `${M}/mail/mail.service.ts`,
      `${M}/billing/billing.service.ts`,
      `${M}/ledger/ledger.service.ts`,
      "packages/lib/src/index.ts",
      "packages/lib/test/lib.test.ts",
    ],
    imports: [
      imp("apps/api/src/main.ts", `${M}/mail/mail.service.ts`, "./module/mail/mail.service"),
      imp(`${M}/auth/auth.service.ts`, `${M}/users/users.service.ts`, "../users/users.service"),
      imp(`${M}/users/users.service.ts`, `${M}/auth/auth.service.ts`, "../auth/auth.service"),
      imp(`${M}/users/users.service.ts`, `${M}/orders/orders.service.ts`, "../orders/orders.service", true),
      imp(
        `${M}/orders/orders.service.ts`,
        `${M}/users/contracts/get-user.query.ts`,
        "../users/contracts/get-user.query",
      ),
      imp(`${M}/orders/orders.service.ts`, `${M}/orders/order.entity.ts`, "./order.entity"),
      imp(`${M}/users/users.service.spec.ts`, `${M}/mail/mail.service.ts`, "../mail/mail.service"),
      imp(
        `${M}/billing/billing.service.ts`,
        `${M}/ledger/ledger.service.ts`,
        "../ledger/ledger.service",
        true,
      ),
      imp(
        `${M}/ledger/ledger.service.ts`,
        `${M}/billing/billing.service.ts`,
        "../billing/billing.service",
        true,
      ),
      imp(`${M}/mail/mail.service.ts`, "packages/lib/src/index.ts", "@m/lib"),
      imp("packages/lib/test/lib.test.ts", "apps/api/src/main.ts", "@m/api"),
    ],
    externals: [ext(`${M}/mail/mail.service.ts`, "nodemailer")],
    unresolved: [],
    manifests: { packages: [api, lib] },
    policy: policy({
      modules: { globs: [`${M}/*`], public: ["contracts/**"] },
      tests: ["**/*.spec.ts", "**/test/**"],
    }),
    policySource: "metator/architecture.yml",
    today: "2026-10-29",
  };
}

/** The smallest input: no packages at all, files at the repository root only. */
function bare(): ArchitectureInput {
  return {
    files: ["index.ts", "lib.ts"],
    imports: [imp("index.ts", "lib.ts", "./lib.ts")],
    externals: [ext("index.ts", "lodash")],
    unresolved: [],
    manifests: { packages: [] },
    policy: EMPTY_POLICY,
    policySource: null,
    today: "2026-10-29",
  };
}

const CASES = { declarations, boundaries, monolith, bare } as const;
const fixture = (name: string) => join(import.meta.dir, "fixtures", "architecture", `${name}.report.json`);
const reportText = (input: ArchitectureInput) =>
  serializeJsonDocument(ArchitectureReportDocument.stamp(analyzeArchitecture(input)));

describe("analyzeArchitecture: the whole report is pinned", () => {
  for (const [name, input] of Object.entries(CASES)) {
    test(`${name}: every field of the report, in order`, async () => {
      const text = reportText(input());
      if (process.env.UPDATE_ARCH_FIXTURES === "1") await Bun.write(fixture(name), text);
      // The fixture's own layout is the formatter's; its keys, their order and every value are compared.
      expect(text).toBe(serializeJsonDocument(await Bun.file(fixture(name)).json()));
    });
  }

  test("the same input gives the same report twice (no hidden state)", () => {
    expect(reportText(boundaries())).toBe(reportText(boundaries()));
  });

  test("together the cases raise every kind of violation and fill every optional section", () => {
    const reports = Object.values(CASES).map((input) => analyzeArchitecture(input()));
    const kinds = new Set(reports.flatMap((r) => r.violations.map((v) => v.kind)));
    // `unused-dependency` is switched off in one case and raised in the others.
    expect(VIOLATION_KINDS.filter((k) => !kinds.has(k))).toEqual([]);
    const some = <T>(pick: (r: (typeof reports)[number]) => T | undefined) => reports.some((r) => pick(r));
    expect([
      some((r) => r.coupling?.length),
      some((r) => r.teams?.edges.length),
      some((r) => r.teams?.unowned.length),
      some((r) => r.apps?.closure.length),
      some((r) => r.modules?.cycles.length),
      some((r) => r.cycles.some((c) => c.typeOnly)),
      some((r) => r.cycles.some((c) => !c.typeOnly)),
      some((r) => r.boundaries?.split.length),
      some((r) => r.boundaries?.merge.length),
      some((r) => r.boundaries?.hubs.length),
      some((r) => r.boundaries?.deadExports.length),
      some((r) => r.boundaries?.deadPackages.length),
      some((r) => r.violations.some((v) => v.exception)),
      some((r) => r.unresolved.count > 0),
      some((r) => r.edges.some((e) => e.testOnly)),
      some((r) => r.packages.some((p) => p.kind === "root")),
    ]).toEqual(Array.from({ length: 16 }, () => true));
  });
});

test("a manifest is private only when it says so; a nameless one is named after its directory", () => {
  expect([
    manifestOf("libs/a", { name: "a" }).private,
    manifestOf("libs/a", { name: "a", private: true }).private,
    manifestOf("libs/a", { name: "a", private: "yes" }).private,
  ]).toEqual([false, true, false]);
  expect([manifestOf("libs/a", {}).name, manifestOf(".", null).name]).toEqual(["libs/a", "(root)"]);
});
