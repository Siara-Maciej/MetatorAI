import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import {
  ArchitectureFacts,
  ArchitecturePolicyCatalog,
  StyleImports,
} from "../src/application/architecture.ts";
import {
  type ArchitectureInput,
  analyzeArchitecture,
  manifestOf,
  type PackageManifest,
  type ResolvedImport,
} from "../src/domain/architecture.ts";
import {
  appReach,
  changeCoupling,
  definitionOf,
  depths,
  fileClusters,
  metricsOf,
  overThresholds,
  reachedExports,
} from "../src/domain/architecture-metrics.ts";
import { ArchitecturePolicySchema, EMPTY_POLICY } from "../src/domain/architecture-policy.ts";
import {
  renderArchitectureHtml,
  renderArchitectureMarkdown,
  renderPackageSvg,
} from "../src/domain/architecture-render.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import { stylePackages } from "../src/domain/style-imports.ts";
import type { ResolvedModule } from "../src/domain/symbols.ts";

type Mod = {
  exports?: [string, boolean?][];
  reexports?: [string, string, string][];
  imports?: [string, string][];
};
/** modules({ "a.ts": { exports: [["x"]], reexports: [[target, imported, exported]], imports: [[target, imported]] } }) */
function modules(spec: Record<string, Mod>): Map<string, ResolvedModule> {
  return new Map(
    Object.entries(spec).map(([file, m]) => [
      file,
      {
        exports: (m.exports ?? []).map(([name, typeOnly]) => ({
          name,
          line: 1,
          typeOnly: typeOnly ?? false,
        })),
        reexports: (m.reexports ?? []).map(([target, imported, exported]) => ({
          specifier: target,
          target,
          imported,
          exported,
          line: 1,
        })),
        imports: (m.imports ?? []).map(([target, imported]) => ({
          specifier: target,
          target,
          imported,
          local: imported,
          line: 1,
          typeOnly: false,
        })),
      },
    ]),
  );
}
const has = (set: Set<string>, file: string, name: string) => set.has(`${file}\u0000${name}`);

describe("reachedExports", () => {
  const mods = modules({
    "lib/a.ts": { exports: [["a"], ["b"], ["default"]] },
    "lib/c.ts": { exports: [["c"]] },
    "lib/index.ts": {
      reexports: [
        ["lib/a.ts", "*", "*"],
        ["lib/c.ts", "c", "renamed"],
      ],
    },
    "lib/ns.ts": { reexports: [["lib/c.ts", "*", "cs"]] },
  });

  test("a named import through a barrel reaches the defining file; export * passes all but default", () => {
    const r = reachedExports(mods, [{ target: "lib/index.ts", imported: "a" }]);
    expect(has(r, "lib/a.ts", "a")).toBe(true);
    expect(has(r, "lib/a.ts", "b")).toBe(false);
    expect(
      has(reachedExports(mods, [{ target: "lib/index.ts", imported: "default" }]), "lib/a.ts", "default"),
    ).toBe(false);
  });

  test("renames are followed; `export * as ns` and namespace imports reach everything", () => {
    expect(
      has(reachedExports(mods, [{ target: "lib/index.ts", imported: "renamed" }]), "lib/c.ts", "c"),
    ).toBe(true);
    expect(has(reachedExports(mods, [{ target: "lib/ns.ts", imported: "cs" }]), "lib/c.ts", "c")).toBe(true);
    const all = reachedExports(mods, [{ target: "lib/index.ts", imported: "*" }]);
    expect([has(all, "lib/a.ts", "a"), has(all, "lib/a.ts", "b"), has(all, "lib/c.ts", "c")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("definitionOf follows re-exports to the defining file", () => {
    expect(definitionOf(mods, "lib/index.ts", "b")).toBe("lib/a.ts");
    expect(definitionOf(mods, "lib/index.ts", "renamed")).toBe("lib/c.ts");
    expect(definitionOf(mods, "lib/index.ts", "nope")).toBeUndefined();
    expect(definitionOf(mods, "missing.ts", "a")).toBeUndefined();
    const loop = modules({
      "x.ts": { reexports: [["y.ts", "*", "*"]] },
      "y.ts": { reexports: [["x.ts", "*", "*"]] },
    });
    expect(definitionOf(loop, "x.ts", "a")).toBeUndefined();
  });
});

describe("metrics", () => {
  test("depth is the longest chain below; a cycle counts as one node", () => {
    const d = depths(
      ["app", "a", "b", "c", "leaf"],
      [
        { from: "app", to: "a", imports: 1 },
        { from: "a", to: "b", imports: 1 },
        { from: "b", to: "a", imports: 1 },
        { from: "b", to: "c", imports: 1 },
        { from: "c", to: "leaf", imports: 1 },
      ],
    );
    expect(Object.fromEntries(d)).toEqual({ app: 3, a: 2, b: 2, c: 1, leaf: 0 });
  });

  test("Martin: instability, abstractness, distance; exports used outside", () => {
    expect(
      metricsOf({ dependsOn: 1, dependents: 3, depth: 2, exports: 4, typeExports: 1, usedOutside: 2 }),
    ).toEqual({
      ca: 3,
      ce: 1,
      instability: 0.25,
      abstractness: 0.25,
      distance: 0.5,
      depth: 2,
      exportsUsed: 0.5,
    });
    expect(
      metricsOf({ dependsOn: 0, dependents: 0, depth: 0, exports: 0, typeExports: 0, usedOutside: 0 }),
    ).toMatchObject({
      instability: 0,
      abstractness: 0,
      distance: 1,
      exportsUsed: null,
    });
  });

  test("thresholds: only the metrics set and exceeded", () => {
    expect(
      overThresholds({ fanOut: 2, depth: 5 }, { distance: 0.9, fanOut: 3, fanIn: 9, files: 9, depth: 5 }),
    ).toEqual([{ metric: "fanOut", value: 3, limit: 2 }]);
    expect(overThresholds({}, { distance: 1, fanOut: 99, fanIn: 99, files: 999, depth: 99 })).toEqual([]);
  });

  test("file clusters: connected groups, largest first; unknown files and self-edges are ignored", () => {
    expect(
      fileClusters(
        ["a", "b", "c", "d", "e"],
        [
          { from: "a", to: "b" },
          { from: "c", to: "d" },
          { from: "d", to: "e" },
          { from: "a", to: "zzz" },
          { from: "a", to: "a" },
        ],
      ),
    ).toEqual([
      ["c", "d", "e"],
      ["a", "b"],
    ]);
  });

  test("change coupling: together over either, sweeping commits ignored, thresholds", () => {
    const pkg = (f: string) => (f.startsWith("root") ? undefined : f.split("/")[0]);
    const commits = [
      ["a/1", "b/1"],
      ["a/2", "b/2", "root"],
      ["a/3", "b/3"],
      ["a/4"],
      ["c/1", "a/5"],
      ["root/x"],
    ];
    expect(changeCoupling(commits, pkg)).toEqual([{ a: "a", b: "b", together: 3, ratio: 0.6 }]);
    expect(changeCoupling(commits, pkg, { minTogether: 1, minRatio: 0 }).map((c) => `${c.a}-${c.b}`)).toEqual(
      ["a-b", "a-c"],
    );
    const sweeping = [
      ["a/1", "b/1", "c/1"],
      ["a/2", "b/2", "c/2"],
      ["a/3", "b/3", "c/3"],
    ];
    expect(changeCoupling(sweeping, pkg, { maxPackagesPerCommit: 2 })).toEqual([]);
  });

  test("application reach: closure per app and blast radius per package, widest first", () => {
    const edges = [
      { from: "web", to: "ui", imports: 1 },
      { from: "ui", to: "core", imports: 1 },
      { from: "admin", to: "core", imports: 1 },
    ];
    expect(appReach(["admin", "web", "ghost"], edges)).toEqual({
      closure: [
        { app: "admin", packages: ["core"] },
        { app: "web", packages: ["core", "ui"] },
        { app: "ghost", packages: [] },
      ],
      blastRadius: [
        { package: "core", apps: ["admin", "web"] },
        { package: "ui", apps: ["web"] },
      ],
    });
  });
});

// ---------------------------------------------------------------------------------------------

const imp = (from: string, to: string): ResolvedImport => ({ from, to, specifier: "@x/p", typeOnly: false });
const m = (dir: string, name: string, json: Record<string, unknown> = {}): PackageManifest =>
  manifestOf(dir, { name, private: true, main: "src/index.ts", ...json });

/** web → kit (both halves used: ui by web, charts by admin), admin → kit, web → cart → money. */
function world(over: Partial<ArchitectureInput> = {}): ArchitectureInput {
  const files = [
    "apps/web/src/main.ts",
    "apps/admin/src/main.ts",
    "packages/kit/src/index.ts",
    "packages/kit/src/ui/button.ts",
    "packages/kit/src/ui/theme.ts",
    "packages/kit/src/ui/icon.ts",
    "packages/kit/src/charts/chart.ts",
    "packages/kit/src/charts/axis.ts",
    "packages/kit/src/charts/legend.ts",
    "packages/kit/test/kit.test.ts",
    "packages/cart/src/index.ts",
    "packages/money/src/index.ts",
  ];
  const mods = modules({
    "apps/web/src/main.ts": {
      exports: [["page"], ["default"]],
      imports: [
        ["packages/kit/src/index.ts", "button"],
        ["packages/cart/src/index.ts", "cart"],
      ],
    },
    "apps/admin/src/main.ts": { imports: [["packages/kit/src/index.ts", "chart"]] },
    "packages/kit/src/index.ts": {
      reexports: [
        ["packages/kit/src/ui/button.ts", "*", "*"],
        ["packages/kit/src/charts/chart.ts", "*", "*"],
      ],
    },
    "packages/kit/src/ui/button.ts": {
      exports: [["button"], ["ButtonProps", true]],
      imports: [["packages/kit/src/ui/theme.ts", "theme"]],
    },
    "packages/kit/src/ui/theme.ts": { exports: [["theme"], ["unused"]] },
    "packages/kit/src/ui/icon.ts": {
      exports: [["icon"]],
      imports: [["packages/kit/src/ui/theme.ts", "theme"]],
    },
    "packages/kit/src/charts/chart.ts": {
      exports: [["chart"]],
      imports: [["packages/kit/src/charts/axis.ts", "axis"]],
    },
    "packages/kit/src/charts/axis.ts": { exports: [["axis"]] },
    "packages/kit/src/charts/legend.ts": {
      exports: [["legend"]],
      imports: [["packages/kit/src/charts/axis.ts", "axis"]],
    },
    "packages/kit/test/kit.test.ts": { imports: [["packages/kit/src/ui/icon.ts", "icon"]] },
    "packages/cart/src/index.ts": { exports: [["cart"]], imports: [["packages/money/src/index.ts", "add"]] },
    "packages/money/src/index.ts": { exports: [["add"], ["Money", true]] },
  });
  return {
    files,
    imports: [
      imp("apps/web/src/main.ts", "packages/kit/src/index.ts"),
      imp("apps/web/src/main.ts", "packages/cart/src/index.ts"),
      imp("apps/admin/src/main.ts", "packages/kit/src/index.ts"),
      imp("packages/kit/src/index.ts", "packages/kit/src/ui/button.ts"),
      imp("packages/kit/src/index.ts", "packages/kit/src/charts/chart.ts"),
      imp("packages/kit/src/ui/button.ts", "packages/kit/src/ui/theme.ts"),
      imp("packages/kit/src/ui/icon.ts", "packages/kit/src/ui/theme.ts"),
      imp("packages/kit/src/charts/chart.ts", "packages/kit/src/charts/axis.ts"),
      imp("packages/kit/src/charts/legend.ts", "packages/kit/src/charts/axis.ts"),
      imp("packages/kit/test/kit.test.ts", "packages/kit/src/ui/icon.ts"),
      imp("packages/cart/src/index.ts", "packages/money/src/index.ts"),
    ],
    externals: [],
    unresolved: [],
    manifests: {
      packages: [
        manifestOf("apps/web", { name: "@x/web", dependencies: { "@x/kit": "*", "@x/cart": "*" } }),
        manifestOf("apps/admin", { name: "@x/admin", dependencies: { "@x/kit": "*" } }),
        m("packages/kit", "@x/kit"),
        m("packages/cart", "@x/cart", { dependencies: { "@x/money": "*" } }),
        m("packages/money", "@x/money"),
      ],
    },
    policy: EMPTY_POLICY,
    policySource: null,
    today: "2026-10-29",
    modules: mods,
    ...over,
  };
}

describe("analyzeArchitecture: metrics and boundaries", () => {
  test("every workspace package has metrics; the root has none", () => {
    const r = analyzeArchitecture(world());
    const metrics = (n: string) => r.packages.find((p) => p.name === n)?.metrics;
    expect(metrics("@x/money")).toEqual({
      ca: 1,
      ce: 0,
      instability: 0,
      abstractness: 0.5,
      distance: 0.5,
      depth: 0,
      exportsUsed: 0.5,
    });
    expect(metrics("@x/web")).toMatchObject({ ca: 0, ce: 2, instability: 1, depth: 2 });
    expect(metrics("@x/kit")?.exportsUsed).toBe(0.25); // button and chart of 8 exports... of the counted ones
  });

  test("a threshold the policy sets becomes a warning", () => {
    const r = analyzeArchitecture(
      world({ policy: ArchitecturePolicySchema.parse({ thresholds: { fanOut: 1, files: 6 } }) }),
    );
    expect(
      r.violations.filter((v) => v.kind === "threshold").map((v) => [v.id, v.severity, v.message]),
    ).toEqual([
      ["threshold:@x/kit:files", "warning", "@x/kit: files 7 is over the threshold 6"],
      ["threshold:@x/web:fanOut", "warning", "@x/web: fanOut 2 is over the threshold 1"],
    ]);
  });

  test("split: two groups of files used by different packages, attributed through the barrel", () => {
    expect(analyzeArchitecture(world()).boundaries?.split).toEqual([
      {
        package: "@x/kit",
        clusters: [
          {
            files: 3,
            sample: [
              "packages/kit/src/charts/axis.ts",
              "packages/kit/src/charts/chart.ts",
              "packages/kit/src/charts/legend.ts",
            ],
            consumers: ["@x/admin"],
          },
          {
            files: 3,
            sample: [
              "packages/kit/src/ui/button.ts",
              "packages/kit/src/ui/icon.ts",
              "packages/kit/src/ui/theme.ts",
            ],
            consumers: ["@x/web"],
          },
        ],
      },
    ]);
  });

  test("no split when both groups serve the same packages", () => {
    const same = world();
    const mods = new Map(same.modules);
    const web = mods.get("apps/web/src/main.ts") as ResolvedModule;
    const chart = {
      ...(web.imports[0] as ResolvedModule["imports"][number]),
      imported: "chart",
      local: "chart",
    };
    mods.set("apps/web/src/main.ts", { ...web, imports: [...web.imports, chart] });
    const admin = mods.get("apps/admin/src/main.ts") as ResolvedModule;
    const button = {
      ...(admin.imports[0] as ResolvedModule["imports"][number]),
      imported: "button",
      local: "button",
    };
    mods.set("apps/admin/src/main.ts", { ...admin, imports: [...admin.imports, button] });
    expect(analyzeArchitecture({ ...same, modules: mods }).boundaries?.split).toEqual([]);
  });

  test("merge: a private library with one dependent, unless it is one of a family or in another layer", () => {
    expect(analyzeArchitecture(world()).boundaries?.merge).toEqual([
      { package: "@x/cart", into: "@x/web", reason: "only @x/web depends on it (1 files)" },
      { package: "@x/money", into: "@x/cart", reason: "only @x/cart depends on it (1 files)" },
    ]);
    const layered = ArchitecturePolicySchema.parse({
      layers: [
        { name: "a", packages: ["@x/web", "@x/admin", "@x/money"] },
        { name: "b", packages: ["@x/cart", "@x/kit"] },
      ],
    });
    expect(analyzeArchitecture(world({ policy: layered })).boundaries?.merge).toEqual([]);
    const family = world({
      files: [
        ...world().files,
        "packages/p1/src/index.ts",
        "packages/p2/src/index.ts",
        "packages/p3/src/index.ts",
      ],
      imports: [
        ...world().imports,
        imp("packages/cart/src/index.ts", "packages/p1/src/index.ts"),
        imp("packages/cart/src/index.ts", "packages/p2/src/index.ts"),
        imp("packages/cart/src/index.ts", "packages/p3/src/index.ts"),
      ],
      manifests: {
        packages: [
          ...world().manifests.packages,
          m("packages/p1", "@x/p1"),
          m("packages/p2", "@x/p2"),
          m("packages/p3", "@x/p3"),
        ],
      },
    });
    expect(analyzeArchitecture(family).boundaries?.merge.map((x) => x.package)).toEqual(["@x/cart"]);
  });

  test("dead exports: not imported by anything, tests count as users, barrels and app entry points do not", () => {
    expect(analyzeArchitecture(world()).boundaries?.deadExports).toEqual([
      { package: "@x/kit", file: "packages/kit/src/charts/legend.ts", name: "legend" },
      { package: "@x/kit", file: "packages/kit/src/ui/button.ts", name: "ButtonProps" },
      { package: "@x/kit", file: "packages/kit/src/ui/theme.ts", name: "unused" },
      { package: "@x/money", file: "packages/money/src/index.ts", name: "Money" },
    ]);
  });

  test("the public API of a published package is used by definition", () => {
    const published = world({
      manifests: {
        packages: world().manifests.packages.map((p) =>
          p.name === "@x/money" ? { ...p, private: false } : p,
        ),
      },
    });
    const dead = analyzeArchitecture(published).boundaries?.deadExports.map((d) => d.name);
    expect(dead).not.toContain("Money");
    expect(analyzeArchitecture(published).boundaries?.deadPackages).toEqual([]);
  });

  test("hubs and unused packages", () => {
    const r = analyzeArchitecture(
      world({
        files: [...world().files, "packages/lonely/src/index.ts"],
        manifests: { packages: [...world().manifests.packages, m("packages/lonely", "@x/lonely")] },
      }),
    );
    expect(r.boundaries?.deadPackages).toEqual(["@x/lonely"]);
    expect(r.boundaries?.hubs).toEqual([]);
  });

  test("an unlinked monorepo (no install): imports by package name still use the package's exports", () => {
    const mods = new Map(world().modules);
    const cart = mods.get("packages/cart/src/index.ts") as ResolvedModule;
    mods.set("packages/cart/src/index.ts", { ...cart, imports: [] });
    const unlinked = world({
      modules: mods,
      imports: world().imports.filter((i) => i.from !== "packages/cart/src/index.ts"),
      externals: [{ from: "packages/cart/src/index.ts", name: "@x/money", typeOnly: false }],
      manifests: {
        packages: world().manifests.packages.map((p) =>
          p.name === "@x/money" ? { ...p, entries: ["packages/money/src/index.ts"] } : p,
        ),
      },
    });
    const r = analyzeArchitecture(unlinked);
    expect(r.boundaries?.deadExports.map((d) => d.package)).not.toContain("@x/money");
    expect(r.packages.find((p) => p.name === "@x/money")?.metrics?.exportsUsed).toBeGreaterThan(0);
  });

  test("a library only tests use (a testing library) is not dead", () => {
    const r = analyzeArchitecture(
      world({
        files: [...world().files, "packages/testing/src/index.ts"],
        imports: [...world().imports, imp("packages/kit/test/kit.test.ts", "packages/testing/src/index.ts")],
        manifests: { packages: [...world().manifests.packages, m("packages/testing", "@x/testing")] },
      }),
    );
    expect(r.boundaries?.deadPackages).toEqual([]);
  });

  test("without modules there are no dead exports and abstractness is 0", () => {
    const { modules: _, ...bare } = world();
    const r = analyzeArchitecture(bare);
    expect(r.boundaries?.deadExports).toEqual([]);
    expect(r.packages.find((p) => p.name === "@x/money")?.metrics).toMatchObject({
      abstractness: 0,
      exportsUsed: null,
    });
  });

  test("history, owners and applications fill their sections", () => {
    const r = analyzeArchitecture(
      world({
        history: [
          ["packages/cart/src/index.ts", "packages/money/src/index.ts"],
          ["packages/cart/src/index.ts", "packages/money/src/index.ts"],
          ["packages/cart/src/index.ts", "packages/money/src/index.ts", "README.md"],
          ["packages/kit/src/ui/theme.ts", "packages/money/src/index.ts"],
        ],
        owners: new Map([
          ["@x/web", ["@web"]],
          ["@x/admin", ["@web"]],
          ["@x/kit", ["@ui"]],
          ["@x/cart", ["@web"]],
          ["@x/money", []],
        ]),
      }),
    );
    expect(r.coupling).toEqual([
      { a: "@x/cart", b: "@x/money", together: 3, ratio: 0.75, dependency: "a-to-b" },
    ]);
    expect(r.teams).toEqual({
      edges: [
        { from: "@web", to: "@ui", imports: 2 },
        { from: "@web", to: "(no owner)", imports: 1 },
      ],
      unowned: ["@x/money"],
    });
    expect(r.apps?.closure).toEqual([
      { app: "@x/admin", packages: ["@x/kit"] },
      { app: "@x/web", packages: ["@x/cart", "@x/kit", "@x/money"] },
    ]);
    expect(analyzeArchitecture(world()).coupling).toBeUndefined();
    expect(analyzeArchitecture(world()).teams).toBeUndefined();
  });
});

describe("renderers", () => {
  const r = analyzeArchitecture(
    world({
      imports: [...world().imports, imp("packages/money/src/index.ts", "packages/cart/src/index.ts")],
      history: [
        ["packages/cart/src/index.ts", "packages/money/src/index.ts"],
        ["packages/cart/src/index.ts", "packages/money/src/index.ts"],
        ["packages/cart/src/index.ts", "packages/money/src/index.ts"],
      ],
      owners: new Map([["@x/web", ["@web"]]]),
    }),
  );

  test("the SVG puts applications on top and colors cycle edges", () => {
    const svg = renderPackageSvg(r);
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg.match(/class="node /g)).toHaveLength(5);
    expect(svg).toContain('<line class="cycle"');
    const y = (name: string) =>
      Number(
        new RegExp(`<rect x="[\\d.]+" y="([\\d.]+)"[^>]*/><text[^>]*>${name.replace("/", "\\/")}<`).exec(
          svg,
        )?.[1],
      );
    expect(y("@x/web")).toBeLessThan(y("@x/kit"));
  });

  test("the HTML page is self-contained, escapes names and has every section", () => {
    const html = renderArchitectureHtml({ ...r, policy: "<script>" });
    expect(html).toStartWith("<!doctype html>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    for (const h of [
      "Package graph",
      "Violations",
      "Cycles",
      "Packages",
      "Boundaries",
      "Changed together",
      "Teams",
      "Applications",
    ])
      expect(html).toContain(`<h2>${h}</h2>`);
  });

  test("Markdown shows metrics, boundaries, history, teams and applications", () => {
    const md = renderArchitectureMarkdown(r);
    expect(md).toContain("| Package | Kind | Layer | Files | Depends on | Dependents | I | A | D | Depth |");
    expect(md).toContain("- **Split @x/kit?** 2 groups");
    expect(md).toContain("## Changed together");
    expect(md).toContain("## Teams");
    expect(md).toContain("- **@x/web** pulls 3: @x/cart, @x/kit, @x/money");
  });
});

describe("ArchitectureFacts: modules, history and owners", () => {
  const graph = {
    execute: async () =>
      ok({
        files: [],
        edges: [],
        packages: [],
        externals: [],
        externalUses: [],
        imports: [],
        unresolved: [],
        stats: { parsed: 0, reused: 0, failed: 0 },
        parseErrors: [],
      }),
  };
  const manifests = { manifests: async () => ok({ packages: [m("packages/a", "@x/a"), m(".", "root")] }) };
  const policies = new ArchitecturePolicyCatalog(new InMemoryFileSystem(), "p.yml");
  const clock = { now: () => new Date("2026-10-29T10:00:00Z") };

  test("gathers modules, the last 500 commits and owners per package directory", async () => {
    const asked: unknown[] = [];
    const facts = new ArchitectureFacts(graph, manifests, policies, clock, {
      symbols: { resolvedModules: async () => ok(modules({ "a.ts": { exports: [["x"]] } })) },
      history: {
        commits: async (limit: number) => {
          asked.push(limit);
          return ok([["a.ts"]]);
        },
      },
      owners: {
        execute: async (input: { paths: readonly string[] }) => {
          asked.push(input.paths);
          return ok({
            source: ".github/CODEOWNERS",
            owners: [
              { path: "x", owners: ["@a"] },
              { path: "y", owners: [] },
            ],
          });
        },
      },
    });
    const i = (await facts.gather())._unsafeUnwrap();
    expect(asked).toEqual([500, ["packages/a/package.json", "package.json"]]);
    expect([...(i.modules?.keys() ?? [])]).toEqual(["a.ts"]);
    expect(i.history).toEqual([["a.ts"]]);
    expect(Object.fromEntries(i.owners ?? [])).toEqual({ "@x/a": ["@a"], root: [] });
  });

  test("no CODEOWNERS file means no owners; a failing source is the error", async () => {
    const none = new ArchitectureFacts(graph, manifests, policies, clock, {
      owners: { execute: async () => ok({ owners: [] }) },
    });
    expect((await none.gather())._unsafeUnwrap().owners).toBeUndefined();
    const failing = new ArchitectureFacts(graph, manifests, policies, clock, {
      history: { commits: async () => err(new MetatorError("COMMAND_FAILED", "git log failed")) },
    });
    expect((await failing.gather())._unsafeUnwrapErr().message).toBe("git log failed");
    const badSymbols = new ArchitectureFacts(graph, manifests, policies, clock, {
      symbols: { resolvedModules: async () => err(new MetatorError("INTERNAL", "no symbols")) },
    });
    expect((await badSymbols.gather())._unsafeUnwrapErr().message).toBe("no symbols");
  });
});

describe("stylesheets", () => {
  test("packages a stylesheet pulls in, not paths, URLs or comments", () => {
    expect(
      stylePackages(`
        @import "tailwindcss";
        @import 'tw-animate-css';
        @import url("@fontsource/inter/400.css");
        @import "@scope/theme/dist/vars.css" layer(base);
        @use "~bootstrap/scss/grid";
        @plugin "@tailwindcss/typography";
        @reference "../../ui/globals.css";
        @import "./local.css";
        @import "/abs.css";
        @import url("https://fonts.example.com/x.css");
        @source "../**/*.tsx";
        /* @import "commented-out"; */
        @import "@";
      `),
    ).toEqual([
      "@fontsource/inter",
      "@scope/theme",
      "@tailwindcss/typography",
      "bootstrap",
      "tailwindcss",
      "tw-animate-css",
    ]);
  });

  test("ArchitectureFacts counts them as build-time uses of the stylesheet's package", async () => {
    const fs = new InMemoryFileSystem({ "packages/a/src/app.css": '@import "tw-animate-css";', "x.css": "" });
    const sources = { list: async () => ok(["packages/a/src/app.css", "x.css", "gone.css"]) };
    const graph = {
      execute: async () =>
        ok({
          files: [],
          edges: [],
          packages: [],
          externals: [],
          externalUses: [{ from: "packages/a/src/i.ts", name: "zod", typeOnly: false }],
          imports: [],
          unresolved: [],
          stats: { parsed: 0, reused: 0, failed: 0 },
          parseErrors: [],
        }),
    };
    const facts = new ArchitectureFacts(
      graph,
      { manifests: async () => ok({ packages: [m("packages/a", "@x/a")] }) },
      new ArchitecturePolicyCatalog(new InMemoryFileSystem(), "p.yml"),
      { now: () => new Date("2026-10-29T10:00:00Z") },
      { styles: new StyleImports(sources, fs) },
    );
    expect((await facts.gather())._unsafeUnwrap().externals).toEqual([
      { from: "packages/a/src/i.ts", name: "zod", typeOnly: false },
      { from: "packages/a/src/app.css", name: "tw-animate-css", typeOnly: true },
    ]);
    const failing = new StyleImports(
      { list: async () => err(new MetatorError("COMMAND_FAILED", "no git")) },
      fs,
    );
    expect((await failing.uses())._unsafeUnwrapErr().message).toBe("no git");
  });
});

describe("manifestOf: entries", () => {
  test("string leaves of main, module, types and exports, relative to the package", () => {
    expect(
      manifestOf("packages/a", {
        main: "./dist/index.js",
        types: "src/index.ts",
        exports: {
          ".": { import: "./src/index.ts" },
          "./util": "./src/util.ts",
          "./*": "./src/*.ts",
          up: "../x.ts",
        },
      }).entries,
    ).toEqual(["packages/a/dist/index.js", "packages/a/src/index.ts", "packages/a/src/util.ts"]);
    expect(manifestOf(".", { main: "index.ts" }).entries).toEqual(["index.ts"]);
  });
});
