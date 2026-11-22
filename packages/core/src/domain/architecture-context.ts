import { alg, Graph } from "@dagrejs/graphlib";
import {
  DEPENDENCY_FIELDS,
  declaredIn,
  type ManifestSet,
  type PackageManifest,
  ROOT_PACKAGE,
} from "./architecture-manifests.ts";
import {
  cheapestCut,
  depths,
  metricsOf,
  type PackageMetrics,
  reachedExports,
} from "./architecture-metrics.ts";
import { analyzeModules, type ModulesReport } from "./architecture-modules.ts";
import {
  ARCH_TEST_GLOBS,
  ARCH_TOOLING_GLOBS,
  type ArchitecturePolicy,
  layerOf,
  matchesPackage,
  tagsOf,
} from "./architecture-policy.ts";
import type { ArchCycle, ArchEdge, ArchPackage } from "./architecture-report.ts";
import { matchesAny } from "./glob.ts";
import { packageOf } from "./import-index.ts";
import type { ResolvedModule } from "./symbols.ts";

export interface ResolvedImport {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export interface ExternalImport {
  readonly from: string;
  /** Package name (`lodash`, `@scope/pkg`) or builtin (`node:fs`, `bun:test`). */
  readonly name: string;
  readonly typeOnly: boolean;
}

export interface ArchitectureInput {
  readonly files: readonly string[];
  readonly imports: readonly ResolvedImport[];
  readonly externals: readonly ExternalImport[];
  readonly unresolved: readonly { readonly from: string; readonly specifier: string }[];
  readonly manifests: ManifestSet;
  readonly policy: ArchitecturePolicy;
  readonly policySource: string | null;
  /** `YYYY-MM-DD`, for exceptions that expire. */
  readonly today: string;
  readonly owners?: ReadonlyMap<string, readonly string[]>;
  /** File → package, overriding directories (what a simulated move changes). */
  readonly placement?: ReadonlyMap<string, string>;
  /** Packages a simulated move creates. */
  readonly extraPackages?: readonly PackageManifest[];
  /** Exported and imported names of every source module (H3: metrics, dead exports, split). */
  readonly modules?: ReadonlyMap<string, ResolvedModule>;
  /** Files changed by each recent commit, newest first (H3: what changes together). */
  readonly history?: readonly (readonly string[])[];
}

/** A relative import that crosses a package boundary: evidence of reaching into a package. */
export interface RelativeImport {
  readonly file: string;
  readonly to: string;
  readonly specifier: string;
}

/**
 * Everything the analysis derives from its input once, before any rule looks at it: which package
 * a file is in, the package graph, the packages, their cycles and metrics, the modules inside
 * packages. Rules and the report's sections only read it.
 */
export interface ArchContext {
  readonly input: ArchitectureInput;
  readonly policy: ArchitecturePolicy;
  /** The workspace's packages, with those a simulated move creates. */
  readonly manifests: readonly PackageManifest[];
  readonly byPackage: ReadonlyMap<string, PackageManifest>;
  /** Left out of the analysis by the policy's `ignore`. */
  readonly ignored: (file: string) => boolean;
  readonly isTest: (file: string) => boolean;
  readonly pkgOf: (file: string) => string;
  /** Files that may use devDependencies: tests, tool configuration and tool packages. */
  readonly devOnly: (file: string) => boolean;
  /** Production code the analysis looks at: neither ignored nor dev-only. */
  readonly counted: (file: string) => boolean;
  /** Package → the dependency names (workspace and external) its files import. */
  readonly used: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every package edge, sorted by from, then to. */
  readonly edges: readonly ArchEdge[];
  /** The relative imports behind an edge (at most five). */
  readonly relativeOf: (edge: ArchEdge) => readonly RelativeImport[];
  /** Edges production code makes (not test-only). */
  readonly production: readonly ArchEdge[];
  /** Production edges between workspace packages (the root left out). */
  readonly wsEdges: readonly ArchEdge[];
  /** Every package, sorted by name, without its metrics. */
  readonly packages: readonly ArchPackage[];
  readonly pkg: ReadonlyMap<string, ArchPackage>;
  /** The packages but the root. */
  readonly workspace: readonly ArchPackage[];
  readonly cycles: readonly ArchCycle[];
  readonly modules: ReadonlyMap<string, ResolvedModule>;
  /** `file\0name` of every export used by some file, tests included, or part of a published API. */
  readonly usedAnywhere: ReadonlySet<string>;
  /** Package → its metrics (workspace packages only). */
  readonly metrics: ReadonlyMap<string, PackageMetrics>;
  /** The modules inside packages, when the policy names them (ADR-0074). */
  readonly inner: ModulesReport | undefined;
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** Modules the runtime provides, not a package: Node and Bun builtins, k6's modules in load tests. */
const isBuiltin = (name: string) =>
  name.startsWith("node:") || name.startsWith("bun:") || name === "bun" || name === "k6";

/** Whether an external import is of a package the analysis looks at: not ignored, not a builtin, a real name. */
export const importsPackage = (ctx: Pick<ArchContext, "ignored">, x: ExternalImport): boolean =>
  !(ctx.ignored(x.from) || isBuiltin(x.name) || !NPM_NAME.test(x.name));

interface EdgeAcc {
  imports: number;
  runtime: number;
  testOnly: boolean;
  samples: { from: string; to: string }[];
  relative: RelativeImport[];
}

export const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
const byName = (a: string, b: string) => a.localeCompare(b);

/** The context of one state of the repository: every lookup and derived fact, computed once. */
export function archContext(input: ArchitectureInput): ArchContext {
  const { policy } = input;
  const manifests = [...input.manifests.packages, ...(input.extraPackages ?? [])];
  const byPackage = new Map(manifests.map((m) => [m.name, m]));
  const refs = manifests.map((m) => ({ name: m.name, dir: m.dir }));
  const tests = policy.tests ?? ARCH_TEST_GLOBS;
  const ignored = (file: string) => policy.ignore.length > 0 && matchesAny(file, policy.ignore);
  const isTest = (file: string) => matchesAny(file, tests);
  const pkgOf = (file: string) => input.placement?.get(file) ?? packageOf(file, refs)?.name ?? ROOT_PACKAGE;
  // A workspace package every declaring package lists in devDependencies only (a shared lint or
  // TypeScript config) is a tool: its files run at check time, never in production.
  const declarers = [input.manifests.root, ...manifests].filter((m) => m !== undefined);
  const devTools = new Set(
    manifests
      .map((m) => m.name)
      .filter((name) => {
        const fields = declarers.flatMap((m) => DEPENDENCY_FIELDS.filter((f) => m[f][name] !== undefined));
        return fields.length > 0 && fields.every((f) => f === "devDependencies");
      }),
  );
  const devOnly = (file: string) =>
    isTest(file) || matchesAny(file, ARCH_TOOLING_GLOBS) || devTools.has(pkgOf(file));
  const counted = (file: string) => !ignored(file) && !devOnly(file);

  // Files per package.
  const files = new Map<string, { files: number; tests: number }>();
  for (const file of input.files) {
    if (ignored(file)) continue;
    const p = pkgOf(file);
    const entry = files.get(p) ?? { files: 0, tests: 0 };
    entry.files++;
    if (isTest(file)) entry.tests++;
    files.set(p, entry);
  }

  // Package edges.
  const acc = new Map<string, EdgeAcc>();
  const used = new Map<string, Set<string>>();
  const use = (p: string, name: string) => {
    const set = used.get(p) ?? new Set<string>();
    set.add(name);
    used.set(p, set);
  };
  // A workspace package imported by name but not linked (no install yet) still is a dependency.
  const unlinked = input.externals.flatMap((x) => {
    const target = byPackage.get(x.name);
    return target
      ? [{ from: x.from, to: `${target.dir}/package.json`, specifier: x.name, typeOnly: x.typeOnly }]
      : [];
  });
  for (const imp of [...input.imports, ...unlinked]) {
    if (ignored(imp.from) || ignored(imp.to)) continue;
    const a = pkgOf(imp.from);
    const b = pkgOf(imp.to);
    if (a === b) continue;
    use(a, b);
    const key = pairKey(a, b);
    const e = acc.get(key) ?? { imports: 0, runtime: 0, testOnly: true, samples: [], relative: [] };
    acc.set(key, e);
    e.imports++;
    if (!imp.typeOnly) e.runtime++;
    if (!devOnly(imp.from)) e.testOnly = false;
    if (e.samples.length < 5 && !e.samples.some((s) => s.from === imp.from && s.to === imp.to))
      e.samples.push({ from: imp.from, to: imp.to });
    if (imp.specifier.startsWith(".") && e.relative.length < 5)
      e.relative.push({ file: imp.from, to: imp.to, specifier: imp.specifier });
  }
  // External packages count as used by the package whose file imports them.
  for (const x of input.externals) if (importsPackage({ ignored }, x)) use(pkgOf(x.from), x.name);

  const edges: ArchEdge[] = [...acc.entries()]
    .map(([key, e]) => {
      const [from, to] = key.split("\u0000") as [string, string];
      return {
        from,
        to,
        imports: e.imports,
        runtime: e.runtime,
        testOnly: e.testOnly,
        declared: (declaredIn(byPackage.get(from), to) ?? "none") as ArchEdge["declared"],
        samples: e.samples,
      };
    })
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  const production = edges.filter((e) => !e.testOnly);

  // Packages.
  const names = new Set([...manifests.map((m) => m.name), ...files.keys()]);
  const dependsOn = (p: string) => production.filter((e) => e.from === p).map((e) => e.to);
  const dependents = (p: string) => production.filter((e) => e.to === p).map((e) => e.from);
  const packages: ArchPackage[] = [...names]
    .filter((n) => n !== ROOT_PACKAGE || (files.get(n)?.files ?? 0) > 0)
    .sort(byName)
    .map((name) => {
      const m = byPackage.get(name);
      const dir = m?.dir ?? ".";
      const tags = m ? tagsOf(policy, m) : [];
      const layer = m ? layerOf(policy, m, tags) : undefined;
      return {
        name,
        dir,
        kind: kindOf(policy, m, dependents(name).filter((d) => d !== ROOT_PACKAGE).length),
        tags,
        ...(layer === undefined ? {} : { layer: policy.layers[layer]?.name as string }),
        files: files.get(name)?.files ?? 0,
        testFiles: files.get(name)?.tests ?? 0,
        owners: [...(input.owners?.get(name) ?? [])],
        dependsOn: dependsOn(name).sort(byName),
        dependents: dependents(name).sort(byName),
      };
    });
  const workspace = packages.filter((p) => p.kind !== "root");
  const wsEdges = production.filter((e) => e.from !== ROOT_PACKAGE && e.to !== ROOT_PACKAGE);
  const modules = input.modules ?? new Map<string, ResolvedModule>();
  const base = { input, manifests, byPackage, ignored, pkgOf, counted, modules };
  const usage = exportUsage(base);

  return {
    ...base,
    policy,
    isTest,
    devOnly,
    used,
    edges,
    relativeOf: (e) => acc.get(pairKey(e.from, e.to))?.relative ?? [],
    production,
    wsEdges,
    packages,
    pkg: new Map(packages.map((p) => [p.name, p])),
    workspace,
    // Cycles between packages (test-only edges never make one).
    cycles: packageCycles(wsEdges),
    usedAnywhere: usage.anywhere,
    metrics: packageMetrics(workspace, wsEdges, usage.counts),
    // Modules inside packages: the units of a modular monolith (ADR-0074).
    inner: policy.modules
      ? analyzeModules({
          policy: policy.modules,
          files: input.files.filter((f) => !ignored(f)),
          imports: input.imports.filter((i) => !ignored(i.from) && !ignored(i.to)),
          isTest,
          packageOf: (dir) => pkgOf(`${dir}/x`),
        })
      : undefined,
  };
}

interface ExportCounts {
  total: number;
  types: number;
  used: number;
}

/** Which exports are used: by other packages (counted per package), and by anything at all. */
function exportUsage(
  ctx: Pick<ArchContext, "input" | "manifests" | "byPackage" | "ignored" | "pkgOf" | "counted" | "modules">,
): { readonly counts: ReadonlyMap<string, ExportCounts>; readonly anywhere: ReadonlySet<string> } {
  const { input, manifests, byPackage, ignored, pkgOf, counted, modules } = ctx;
  // Imports of a workspace package by name that is not linked (no install): its entry files,
  // wholly, since the names imported were not resolved.
  const unlinkedSeeds = input.externals.flatMap((x) =>
    (byPackage.get(x.name)?.entries ?? [])
      .filter((f) => modules.has(f))
      .map((target) => ({ from: x.from, target, imported: "*" })),
  );
  const seedsFrom = (keep: (from: string, target: string) => boolean, tests = false) => {
    const usable = (from: string) => counted(from) || (tests && !ignored(from));
    return [
      ...[...modules.entries()].flatMap(([from, m]) =>
        usable(from)
          ? m.imports
              .filter((i) => keep(from, i.target))
              .map((i) => ({ target: i.target, imported: i.imported }))
          : [],
      ),
      ...unlinkedSeeds
        .filter((s) => usable(s.from) && keep(s.from, s.target))
        .map((s) => ({ target: s.target, imported: s.imported })),
    ];
  };
  const usedOutside = reachedExports(
    modules,
    seedsFrom((from, target) => pkgOf(from) !== pkgOf(target)),
  );
  // The public API of a published package counts as used: its users live outside the repository.
  const publicApi = manifests
    .filter((m) => !m.private)
    .flatMap((m) => m.entries.filter((f) => modules.has(f)).map((target) => ({ target, imported: "*" })));
  // Tests count as users here (an export for a test is not dead), not for use by other packages.
  const anywhere = reachedExports(modules, [...seedsFrom(() => true, true), ...publicApi]);
  const counts = new Map<string, ExportCounts>();
  for (const [file, m] of modules) {
    if (!counted(file)) continue;
    const c = counts.get(pkgOf(file)) ?? { total: 0, types: 0, used: 0 };
    for (const e of m.exports) {
      c.total++;
      if (e.typeOnly) c.types++;
      if (usedOutside.has(`${file}\u0000${e.name}`)) c.used++;
    }
    counts.set(pkgOf(file), c);
  }
  return { counts, anywhere };
}

/** The metrics of every workspace package: coupling, depth, and how much of its API others use. */
function packageMetrics(
  workspace: readonly ArchPackage[],
  wsEdges: readonly ArchEdge[],
  counts: ReadonlyMap<string, ExportCounts>,
): Map<string, PackageMetrics> {
  const depthOf = depths(
    workspace.map((p) => p.name),
    wsEdges,
  );
  return new Map(
    workspace.map((p) => {
      const c = counts.get(p.name) ?? { total: 0, types: 0, used: 0 };
      return [
        p.name,
        metricsOf({
          dependsOn: wsEdges.filter((e) => e.from === p.name).length,
          dependents: wsEdges.filter((e) => e.to === p.name).length,
          depth: depthOf.get(p.name) ?? 0,
          exports: c.total,
          typeExports: c.types,
          usedOutside: c.used,
        }),
      ];
    }),
  );
}

function kindOf(
  policy: ArchitecturePolicy,
  m: PackageManifest | undefined,
  dependents: number,
): ArchPackage["kind"] {
  if (!m) return "root";
  for (const rule of policy.packages)
    if (rule.kind && rule.packages.some((p) => matchesPackage(p, m))) return rule.kind;
  if (m.projectType) return m.projectType === "application" ? "app" : "lib";
  if (m.dir === "apps" || m.dir.startsWith("apps/")) return "app";
  // A package others import is a library, even with a `bin` (a tool that is also a library, like
  // typescript); mark an imported application with `kind: app` in the policy to check app-import.
  if (dependents > 0) return "lib";
  const runnable = ["start", "dev", "serve"].some((s) => m.scripts[s] !== undefined);
  return m.bin || (runnable && !m.entry) ? "app" : "lib";
}

/** Strongly connected components of more than one package, with their inner edges. */
export function packageCycles(edges: readonly ArchEdge[]): ArchCycle[] {
  const graph = new Graph({ directed: true });
  const runtime = new Graph({ directed: true });
  for (const e of edges) {
    graph.setEdge(e.from, e.to);
    if (e.runtime > 0) runtime.setEdge(e.from, e.to);
  }
  const runtimeSets = alg.tarjan(runtime).map((c) => new Set(c));
  return alg
    .tarjan(graph)
    .filter((c) => c.length > 1)
    .map((c) => {
      const members = new Set(c);
      const inner = edges
        .filter((e) => members.has(e.from) && members.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, imports: e.imports, runtime: e.runtime }));
      // Type-only when no runtime cycle runs through it: a runtime SCC inside it is a runtime cycle.
      const typeOnly = !runtimeSets.some((r) => r.size > 1 && [...r].every((p) => members.has(p)));
      const packages = [...c].sort(byName);
      return { packages, edges: inner, typeOnly, cut: cheapestCut({ packages, edges: inner }) };
    })
    .sort((a, b) => (a.packages[0] ?? "").localeCompare(b.packages[0] ?? ""));
}
