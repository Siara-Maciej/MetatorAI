import { alg, Graph } from "@dagrejs/graphlib";
import type { ArchitecturePolicy } from "./architecture-policy.ts";
import type { ResolvedModule } from "./symbols.ts";

/**
 * Metrics and boundaries of the package graph (H3, ADR-0063): Martin's stability metrics and the
 * depth of each package; symbols nobody imports; groups of files inside a package that live
 * apart; packages that could merge; hubs; what changes together in git history; dependencies
 * between teams; and what each application pulls in.
 */

export interface PackageEdgeLike {
  readonly from: string;
  readonly to: string;
  readonly imports: number;
}

/** A use of an exported name: `${file}\u0000${name}`. */
const use = (file: string, name: string) => `${file}\u0000${name}`;

/**
 * Exported names a set of imports reaches, following re-exports (barrels, renames, `export *`)
 * back to the files that define them. A namespace import reaches every name of its module.
 * Work-list over (module, name) pairs, so each pair is visited once.
 */
export function reachedExports(
  modules: ReadonlyMap<string, ResolvedModule>,
  seeds: Iterable<{ readonly target: string; readonly imported: string }>,
): Set<string> {
  const reached = new Set<string>();
  const queue: { file: string; name: string }[] = [];
  const push = (file: string, name: string) => {
    const key = use(file, name);
    if (reached.has(key)) return;
    reached.add(key);
    queue.push({ file, name });
  };
  const all = (file: string) => {
    const m = modules.get(file);
    for (const e of m?.exports ?? []) push(file, e.name);
    for (const r of m?.reexports ?? []) push(file, r.exported === "*" ? `*${r.target}` : r.exported);
  };
  for (const s of seeds) {
    if (s.imported === "*") all(s.target);
    else push(s.target, s.imported);
  }
  while (queue.length > 0) {
    const { file, name } = queue.shift() as { file: string; name: string };
    for (const r of modules.get(file)?.reexports ?? []) {
      if (r.imported === "*" && r.exported === "*") {
        // `export * from`: every name but default passes; a `*<target>` marker means "all of it".
        if (name === `*${r.target}`) all(r.target);
        else if (name !== "default") push(r.target, name);
      } else if (r.imported === "*" && r.exported === name)
        all(r.target); // `export * as ns`
      else if (r.exported === name) push(r.target, r.imported);
    }
  }
  return reached;
}

/** The file that defines `name` as seen from `file` (through re-exports), or undefined. */
export function definitionOf(
  modules: ReadonlyMap<string, ResolvedModule>,
  file: string,
  name: string,
  depth = 0,
): string | undefined {
  const m = modules.get(file);
  if (!m || depth > 20) return undefined;
  if (m.exports.some((e) => e.name === name)) return file;
  for (const r of m.reexports) {
    if (r.exported === name && r.imported !== "*") {
      const found = definitionOf(modules, r.target, r.imported, depth + 1);
      if (found) return found;
    }
    if (r.imported === "*" && r.exported === "*" && name !== "default") {
      const found = definitionOf(modules, r.target, name, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Longest chain of dependencies below each package; packages in one cycle share a node. */
export function depths(packages: readonly string[], edges: readonly PackageEdgeLike[]): Map<string, number> {
  const graph = new Graph({ directed: true });
  for (const p of packages) graph.setNode(p);
  for (const e of edges) graph.setEdge(e.from, e.to);
  const component = new Map<string, number>();
  alg.tarjan(graph).forEach((c, i) => {
    for (const p of c) component.set(p, i);
  });
  const below = new Map<number, Set<number>>();
  for (const e of edges) {
    const a = component.get(e.from) as number;
    const b = component.get(e.to) as number;
    if (a === b) continue;
    const set = below.get(a) ?? new Set<number>();
    set.add(b);
    below.set(a, set);
  }
  const memo = new Map<number, number>();
  const depthOf = (c: number): number => {
    const known = memo.get(c);
    if (known !== undefined) return known;
    memo.set(c, 0); // the condensation is acyclic; this only guards malformed input
    const d = Math.max(-1, ...[...(below.get(c) ?? [])].map(depthOf)) + 1;
    memo.set(c, d);
    return d;
  };
  return new Map(packages.map((p) => [p, depthOf(component.get(p) as number)]));
}

export interface PackageMetrics {
  readonly ca: number;
  readonly ce: number;
  readonly instability: number;
  readonly abstractness: number;
  readonly distance: number;
  readonly depth: number;
  readonly exportsUsed: number | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function metricsOf(input: {
  readonly dependsOn: number;
  readonly dependents: number;
  readonly depth: number;
  readonly exports: number;
  readonly typeExports: number;
  readonly usedOutside: number;
}): PackageMetrics {
  const { dependsOn: ce, dependents: ca } = input;
  const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
  const abstractness = input.exports === 0 ? 0 : input.typeExports / input.exports;
  return {
    ca,
    ce,
    instability: round(instability),
    abstractness: round(abstractness),
    distance: round(Math.abs(abstractness + instability - 1)),
    depth: input.depth,
    exportsUsed: input.exports === 0 ? null : round(input.usedOutside / input.exports),
  };
}

/** Metric values over the policy's thresholds, as `metric value > limit`. */
export function overThresholds(
  thresholds: ArchitecturePolicy["thresholds"],
  values: {
    readonly distance: number;
    readonly fanOut: number;
    readonly fanIn: number;
    readonly files: number;
    readonly depth: number;
  },
): { metric: string; value: number; limit: number }[] {
  const out: { metric: string; value: number; limit: number }[] = [];
  for (const metric of ["distance", "fanOut", "fanIn", "files", "depth"] as const) {
    const limit = thresholds[metric];
    if (limit !== undefined && values[metric] > limit) out.push({ metric, value: values[metric], limit });
  }
  return out;
}

/** Groups of files that import each other (ignoring the barrels that tie a package together). */
export function fileClusters(
  files: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
): string[][] {
  const graph = new Graph({ directed: false });
  for (const f of files) graph.setNode(f);
  for (const e of edges)
    if (graph.hasNode(e.from) && graph.hasNode(e.to) && e.from !== e.to) graph.setEdge(e.from, e.to);
  return alg
    .components(graph)
    .map((c) => [...c].sort())
    .sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
}

/** Packages changed in the same commits, with how often relative to how often either changed. */
export function changeCoupling(
  commits: readonly (readonly string[])[],
  packageOfFile: (file: string) => string | undefined,
  options: {
    readonly minTogether?: number;
    readonly minRatio?: number;
    readonly maxPackagesPerCommit?: number;
  } = {},
): { a: string; b: string; together: number; ratio: number }[] {
  const minTogether = options.minTogether ?? 3;
  const minRatio = options.minRatio ?? 0.5;
  const maxPerCommit = options.maxPackagesPerCommit ?? 10;
  const touched = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const files of commits) {
    const pkgs = [...new Set(files.map(packageOfFile).filter((p): p is string => p !== undefined))].sort();
    if (pkgs.length === 0 || pkgs.length > maxPerCommit) continue; // a sweeping change says nothing about coupling
    for (const p of pkgs) touched.set(p, (touched.get(p) ?? 0) + 1);
    for (let i = 0; i < pkgs.length; i++)
      for (let j = i + 1; j < pkgs.length; j++) {
        const key = `${pkgs[i]}\u0000${pkgs[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
  }
  return [...pairs.entries()]
    .map(([key, together]) => {
      const [a, b] = key.split("\u0000") as [string, string];
      const either = (touched.get(a) ?? 0) + (touched.get(b) ?? 0) - together;
      return { a, b, together, ratio: round(together / either) };
    })
    .filter((c) => c.together >= minTogether && c.ratio >= minRatio)
    .sort(
      (x, y) =>
        y.ratio - x.ratio || y.together - x.together || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
    );
}

/** Every package each application reaches, and for each package the applications it reaches. */
export function appReach(
  apps: readonly string[],
  edges: readonly PackageEdgeLike[],
): { closure: { app: string; packages: string[] }[]; blastRadius: { package: string; apps: string[] }[] } {
  const graph = new Graph({ directed: true });
  for (const e of edges) graph.setEdge(e.from, e.to);
  const closure = apps.map((app) => ({
    app,
    packages: graph.hasNode(app)
      ? alg
          .preorder(graph, [app])
          .filter((p) => p !== app)
          .sort()
      : [],
  }));
  const reach = new Map<string, string[]>();
  for (const c of closure) for (const p of c.packages) reach.set(p, [...(reach.get(p) ?? []), c.app]);
  const blastRadius = [...reach.entries()]
    .map(([pkg, list]) => ({ package: pkg, apps: [...list].sort() }))
    .sort((a, b) => b.apps.length - a.apps.length || a.package.localeCompare(b.package));
  return { closure, blastRadius };
}
