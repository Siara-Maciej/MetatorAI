import { DependencyGraph, type Edge } from "./graph.ts";
import { type PackageRef, packageOf } from "./import-index.ts";

/**
 * `graph diff` (ADR-0036): how a change reshapes the import graph. Besides added and removed
 * edges it names what a gate cares about: a package that now depends on a package it did not
 * depend on before, and import cycles that an added edge closes.
 */
export interface GraphDiff {
  readonly added: readonly Edge[];
  readonly removed: readonly Edge[];
  readonly newPackageDependencies: readonly {
    readonly from: string;
    readonly to: string;
    readonly via: string;
  }[];
  readonly newCycles: readonly (readonly string[])[];
}

const key = (e: { readonly from: string; readonly to: string }) => `${e.from}\u0000${e.to}`;
const byEdge = (a: Edge, b: Edge) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to);

function packageEdges(edges: readonly Edge[], packages: readonly PackageRef[]): Map<string, Edge> {
  const out = new Map<string, Edge>();
  for (const e of edges) {
    if (e.kind !== "cross-package") continue;
    const from = packageOf(e.from, packages)?.name ?? "(root)";
    const to = packageOf(e.to, packages)?.name ?? "(root)";
    if (from !== to && !out.has(`${from}\u0000${to}`)) out.set(`${from}\u0000${to}`, e);
  }
  return out;
}

export function diffGraphs(
  base: readonly Edge[],
  current: readonly Edge[],
  packages: readonly PackageRef[],
): GraphDiff {
  const internal = (edges: readonly Edge[]) => edges.filter((e) => e.kind !== "external");
  const before = new Set(internal(base).map(key));
  const after = new Set(internal(current).map(key));
  const added = internal(current)
    .filter((e) => !before.has(key(e)))
    .sort(byEdge);
  const removed = internal(base)
    .filter((e) => !after.has(key(e)))
    .sort(byEdge);

  const basePackages = packageEdges(base, packages);
  const newPackageDependencies = [...packageEdges(added, packages)]
    .filter(([k]) => !basePackages.has(k))
    .map(([k, e]) => {
      const [from, to] = k.split("\u0000") as [string, string];
      return { from, to, via: `${e.from} → ${e.to}` };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const baseCycles = new Set(new DependencyGraph(base).cycles().map((c) => c.join("\u0000")));
  const newCycles = new DependencyGraph(current)
    .cycles()
    .filter((c) => !baseCycles.has(c.join("\u0000")))
    .filter((c) => added.some((e) => c.includes(e.from) && c.includes(e.to)));
  return { added, removed, newPackageDependencies, newCycles };
}
