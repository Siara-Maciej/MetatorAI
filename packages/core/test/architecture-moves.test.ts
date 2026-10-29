import { describe, expect, test } from "bun:test";
import { SimulateArchitecture } from "../src/application/architecture.ts";
import {
  type ArchitectureInput,
  analyzeArchitecture,
  manifestOf,
  type ResolvedImport,
} from "../src/domain/architecture.ts";
import { cheapestCut } from "../src/domain/architecture-metrics.ts";
import { applyMoves, checkMoves, MoveSchema, simulateMoves } from "../src/domain/architecture-moves.ts";
import { EMPTY_POLICY } from "../src/domain/architecture-policy.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const imp = (from: string, to: string, specifier = "@x/p"): ResolvedImport => ({
  from,
  to,
  specifier,
  typeOnly: false,
});

/** web → cart → pricing → cart (a cycle through pricing/src/rules.ts), pricing → zod. */
function input(over: Partial<ArchitectureInput> = {}): ArchitectureInput {
  return {
    files: [
      "apps/web/src/main.ts",
      "packages/cart/src/index.ts",
      "packages/cart/src/total.ts",
      "packages/pricing/src/index.ts",
      "packages/pricing/src/rules.ts",
    ],
    imports: [
      imp("apps/web/src/main.ts", "packages/cart/src/index.ts"),
      imp("packages/cart/src/index.ts", "packages/pricing/src/index.ts"),
      imp("packages/cart/src/total.ts", "packages/pricing/src/index.ts"),
      imp("packages/pricing/src/rules.ts", "packages/cart/src/total.ts"),
    ],
    externals: [{ from: "packages/pricing/src/rules.ts", name: "zod", typeOnly: false }],
    unresolved: [],
    manifests: {
      packages: [
        manifestOf("apps/web", { name: "@x/web", dependencies: { "@x/cart": "*" } }),
        manifestOf("packages/cart", {
          name: "@x/cart",
          private: true,
          main: "src/index.ts",
          dependencies: { "@x/pricing": "*" },
        }),
        manifestOf("packages/pricing", {
          name: "@x/pricing",
          private: true,
          main: "src/index.ts",
          dependencies: { "@x/cart": "*", zod: "^4" },
        }),
      ],
    },
    policy: EMPTY_POLICY,
    policySource: null,
    today: "2026-10-29",
    ...over,
  };
}

describe("moves", () => {
  test("the schema knows every kind and refuses unknown ones", () => {
    expect(MoveSchema.parse({ type: "merge", from: "a", into: "b" })).toEqual({
      type: "merge",
      from: "a",
      into: "b",
    });
    expect(() => MoveSchema.parse({ type: "teleport" })).toThrow();
    expect(() => MoveSchema.parse({ type: "move", files: [], to: "a" })).toThrow();
  });

  test("check: unknown packages, existing names for new packages, files that match nothing", () => {
    expect(
      checkMoves(input(), [
        { type: "move", files: ["nope/**"], to: "@x/ghost" },
        { type: "extract", files: ["packages/cart/**"], package: { name: "@x/cart", dir: "packages/cart2" } },
        { type: "merge", from: "@x/web", into: "@x/nope" },
        { type: "invert", from: "@x/a", to: "@x/cart" },
        { type: "declare", package: "@x/b", dependency: "zod" },
      ]),
    ).toEqual([
      "move nope/** to @x/ghost: there is no package @x/ghost",
      "move nope/** to @x/ghost: no source file matches",
      "extract packages/cart/** into @x/cart: @x/cart already exists",
      "merge @x/web into @x/nope: there is no package @x/nope",
      "invert @x/a → @x/cart: there is no package @x/a",
      "declare zod in @x/b: there is no package @x/b",
    ]);
    expect(
      checkMoves(input(), [
        {
          type: "extract",
          files: ["packages/pricing/src/rules.ts"],
          package: { name: "@x/rules", dir: "packages/rules" },
        },
        { type: "move", files: ["packages/cart/src/total.ts"], to: "@x/rules" },
      ]),
    ).toEqual([]);
  });

  test("move: the file belongs to the receiving package, which declares what it imports", () => {
    const moved = applyMoves(input(), [
      { type: "move", files: ["packages/pricing/src/rules.ts"], to: "@x/cart" },
    ]);
    expect(moved.input.placement?.get("packages/pricing/src/rules.ts")).toBe("@x/cart");
    expect(moved.declared).toEqual([{ package: "@x/cart", dependency: "zod" }]);
    expect(moved.input.manifests.packages.find((p) => p.name === "@x/cart")?.dependencies).toEqual({
      "@x/pricing": "*",
      zod: "^4",
    });
  });

  test("a dependency the receiving package already declares is not declared again", () => {
    const moved = applyMoves(input(), [
      { type: "move", files: ["packages/pricing/src/rules.ts"], to: "@x/web" },
    ]);
    expect(moved.declared).toEqual([{ package: "@x/web", dependency: "zod" }]);
  });

  test("merge: the package disappears and its dependents declare the one it went into", () => {
    const withAdmin = input({
      manifests: {
        packages: [
          ...input().manifests.packages,
          manifestOf("apps/admin", { name: "@x/admin", dependencies: { "@x/cart": "1" } }),
        ],
      },
    });
    const moved = applyMoves(withAdmin, [{ type: "merge", from: "@x/cart", into: "@x/pricing" }]);
    const names = moved.input.manifests.packages.map((p) => p.name);
    expect(names).toEqual(["@x/web", "@x/pricing", "@x/admin"]);
    // A package that only declares the merged one (no import) declares its new home too.
    expect(moved.input.manifests.packages[2]?.dependencies).toEqual({ "@x/pricing": "workspace:*" });
    expect(moved.input.manifests.packages[0]?.dependencies).toEqual({ "@x/pricing": "workspace:*" });
    expect(moved.input.manifests.packages[1]?.dependencies).toEqual({ zod: "^4" });
    const r = analyzeArchitecture(moved.input);
    expect([r.cycles, r.violations.filter((v) => v.severity === "error")]).toEqual([[], []]);
  });

  test("extract: a new package with the files; importers declare it", () => {
    const moved = applyMoves(input(), [
      {
        type: "extract",
        files: ["packages/cart/src/total.ts"],
        package: { name: "@x/total", dir: "packages/total" },
      },
    ]);
    expect(moved.input.extraPackages?.map((p) => [p.name, p.dir, p.private])).toEqual([
      ["@x/total", "packages/total", true],
    ]);
    expect(moved.declared).toEqual([
      { package: "@x/total", dependency: "@x/pricing" },
      { package: "@x/pricing", dependency: "@x/total" },
    ]);
    expect(analyzeArchitecture(moved.input).packages.map((p) => p.name)).toContain("@x/total");
  });

  test("invert: the dependency points the other way", () => {
    const moved = applyMoves(input(), [{ type: "invert", from: "@x/pricing", to: "@x/cart" }]);
    expect(
      moved.input.imports.filter(
        (i) => i.from.startsWith("packages/pricing") && i.to.startsWith("packages/cart"),
      ),
    ).toEqual([]);
    expect(moved.input.imports.at(-1)).toEqual({
      from: "packages/cart/src/index.ts",
      to: "packages/pricing/src/index.ts",
      specifier: "@x/pricing",
      typeOnly: false,
    });
    const unlinked = input({
      imports: input().imports.slice(0, 3),
      externals: [{ from: "packages/pricing/src/rules.ts", name: "@x/cart", typeOnly: false }],
    });
    expect(analyzeArchitecture(unlinked).cycles).toHaveLength(1);
    const inverted = applyMoves(unlinked, [{ type: "invert", from: "@x/pricing", to: "@x/cart" }]);
    expect([inverted.input.externals, analyzeArchitecture(inverted.input).cycles]).toEqual([[], []]);
    // An unrelated missing declaration stays missing: only what the move touches is declared.
    const undeclared = input({
      manifests: {
        packages: input().manifests.packages.map((p) =>
          p.name === "@x/web" ? { ...p, dependencies: {} } : p,
        ),
      },
    });
    const s = simulateMoves(undeclared, [{ type: "invert", from: "@x/pricing", to: "@x/cart" }]);
    expect(s.effect.fixed).toEqual(["cycle:@x/cart,@x/pricing"]);
    expect(s.effect.rewrites).toBe(1);
    expect(s.report.violations.map((v) => v.id)).toContain("undeclared:@x/web→@x/cart");
    const nothing = applyMoves(input(), [{ type: "invert", from: "@x/web", to: "@x/pricing" }]);
    expect(nothing.input.imports).toEqual(input().imports);
  });

  test("declare: adds the dependency once, in the field asked for", () => {
    const moved = applyMoves(input(), [
      { type: "declare", package: "@x/web", dependency: "lodash", field: "devDependencies" },
      { type: "declare", package: "@x/web", dependency: "@x/cart" },
    ]);
    const web = moved.input.manifests.packages.find((p) => p.name === "@x/web");
    expect([web?.devDependencies, web?.dependencies]).toEqual([
      { lodash: "workspace:*" },
      { "@x/cart": "*" },
    ]);
  });
});

describe("simulateMoves", () => {
  test("moving the file that closes a cycle fixes it: before, after, fixed, rewrites", () => {
    const s = simulateMoves(input(), [
      { type: "move", files: ["packages/pricing/src/rules.ts"], to: "@x/cart" },
    ]);
    expect([s.effect.before.cycles, s.effect.after.cycles]).toEqual([1, 0]);
    expect(s.effect.fixed).toEqual(["cycle:@x/cart,@x/pricing"]);
    expect(s.effect.rewrites).toBe(1);
    const internal = input({
      imports: [
        ...input().imports,
        imp("packages/cart/src/index.ts", "packages/cart/src/total.ts", "./total.ts"),
      ],
    });
    const same = simulateMoves(internal, [
      { type: "move", files: ["packages/pricing/src/rules.ts"], to: "@x/cart" },
    ]);
    expect(same.effect.rewrites).toBe(1); // the import inside cart stays inside cart
    expect(s.effect.added.map((v) => v.id)).toEqual([
      "unused-dependency:@x/pricing→@x/cart",
      "unused-dependency:@x/pricing→zod",
    ]);
    expect(s.report.cycles).toEqual([]);
  });

  test("a move that makes things worse says so", () => {
    const acyclic = input({ imports: input().imports.slice(0, 3) });
    const s = simulateMoves(acyclic, [{ type: "move", files: ["apps/web/src/main.ts"], to: "@x/pricing" }]);
    expect(s.effect.added.map((v) => v.id)).toContain("cycle:@x/cart,@x/pricing");
    expect(s.effect.after.score).toBeLessThanOrEqual(s.effect.before.score);
  });

  test("SimulateArchitecture refuses impossible moves and passes facts errors on", async () => {
    const sim = new SimulateArchitecture({ gather: async () => ok(input()) });
    const bad = (
      await sim.execute({ moves: [{ type: "merge", from: "@x/a", into: "@x/cart" }] })
    )._unsafeUnwrapErr();
    expect([bad.code, bad.message]).toEqual(["USAGE", "merge @x/a into @x/cart: there is no package @x/a"]);
    const good = (
      await sim.execute({ moves: [{ type: "invert", from: "@x/pricing", to: "@x/cart" }] })
    )._unsafeUnwrap();
    expect([good.effect.fixed, good.cycles]).toEqual([["cycle:@x/cart,@x/pricing"], []]);
    const failing = new SimulateArchitecture({
      gather: async () => err(new MetatorError("INTERNAL", "no facts")),
    });
    expect((await failing.execute({ moves: [] }))._unsafeUnwrapErr().message).toBe("no facts");
  });
});

describe("cheapestCut", () => {
  test("exact: the fewest imports that leave no cycle", () => {
    expect(
      cheapestCut({
        packages: ["a", "b", "c"],
        edges: [
          { from: "a", to: "b", imports: 9 },
          { from: "b", to: "c", imports: 7 },
          { from: "c", to: "a", imports: 2 },
          { from: "b", to: "a", imports: 3 },
        ],
      }),
    ).toEqual([
      { from: "b", to: "a", imports: 3 },
      { from: "c", to: "a", imports: 2 },
    ]);
  });

  test("exact where the ordering heuristic is not (cost 6, not 10)", () => {
    const edges = [
      { from: "p0", to: "p4", imports: 3 },
      { from: "p1", to: "p2", imports: 8 },
      { from: "p2", to: "p4", imports: 6 },
      { from: "p3", to: "p2", imports: 7 },
      { from: "p4", to: "p1", imports: 3 },
      { from: "p4", to: "p2", imports: 1 },
      { from: "p4", to: "p3", imports: 6 },
    ];
    const cut = cheapestCut({ packages: ["p0", "p1", "p2", "p3", "p4"], edges });
    expect(cut.reduce((s, e) => s + e.imports, 0)).toBe(6);
  });

  test("the heuristic places sinks last (cost 11 on this graph of eight)", () => {
    const edges = [
      { from: "p0", to: "p2", imports: 7 },
      { from: "p0", to: "p3", imports: 9 },
      { from: "p2", to: "p0", imports: 9 },
      { from: "p3", to: "p7", imports: 4 },
      { from: "p5", to: "p2", imports: 7 },
      { from: "p6", to: "p0", imports: 8 },
      { from: "p6", to: "p1", imports: 5 },
      { from: "p6", to: "p2", imports: 5 },
      { from: "p6", to: "p4", imports: 5 },
      { from: "p7", to: "p6", imports: 9 },
    ];
    const packages = Array.from({ length: 8 }, (_, i) => `p${i}`);
    expect(cheapestCut({ packages, edges }).reduce((s, e) => s + e.imports, 0)).toBe(11);
  });

  test("heuristic above seven packages still leaves no cycle", () => {
    const n = 9;
    const packages = Array.from({ length: n }, (_, i) => `p${i}`);
    const edges = packages.map((p, i) => ({
      from: p,
      to: packages[(i + 1) % n] as string,
      imports: i === 4 ? 1 : 5,
    }));
    edges.push({ from: "p2", to: "p0", imports: 1 });
    const cut = cheapestCut({ packages, edges });
    expect(cut.reduce((s, e) => s + e.imports, 0)).toBeLessThanOrEqual(2);
    const left = edges.filter((e) => !cut.some((c) => c.from === e.from && c.to === e.to));
    // The remaining graph is acyclic: a topological order reaches every package.
    const indegree = new Map(packages.map((p) => [p, 0]));
    for (const e of left) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const queue = packages.filter((p) => indegree.get(p) === 0);
    let seen = 0;
    while (queue.length > 0) {
      const p = queue.shift() as string;
      seen++;
      for (const e of left.filter((x) => x.from === p)) {
        indegree.set(e.to, (indegree.get(e.to) ?? 0) - 1);
        if (indegree.get(e.to) === 0) queue.push(e.to);
      }
    }
    expect(seen).toBe(n);
  });
});
