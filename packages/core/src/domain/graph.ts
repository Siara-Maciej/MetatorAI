import { alg, Graph } from "@dagrejs/graphlib";

export type EdgeKind = "internal" | "cross-package" | "external";

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

/**
 * File-level dependency graph on @dagrejs/graphlib (ADR-0012). Domain-specific queries only:
 * traversal, cycle detection and shortest paths come from graphlib's algorithms.
 */
export class DependencyGraph {
  private readonly graph = new Graph({ directed: true });
  private readonly reversed = new Graph({ directed: true });

  constructor(readonly edges: readonly Edge[]) {
    for (const edge of edges) {
      if (edge.kind === "external") continue;
      this.graph.setEdge(edge.from, edge.to);
      this.reversed.setEdge(edge.to, edge.from);
    }
  }

  dependenciesOf(file: string): ReadonlySet<string> {
    return new Set(this.graph.successors(file) ?? []);
  }

  dependentsOf(file: string): ReadonlySet<string> {
    return new Set(this.graph.predecessors(file) ?? []);
  }

  /** Changed files plus everything that (transitively) depends on them. Cycle-safe. */
  affected(changed: Iterable<string>): Set<string> {
    const files = [...changed];
    const known = files.filter((f) => this.reversed.hasNode(f));
    return new Set([...files, ...(known.length > 0 ? alg.preorder(this.reversed, known) : [])]);
  }

  /** Import cycles (strongly connected components with more than one file, or self-imports). */
  cycles(): string[][] {
    return alg.findCycles(this.graph).map((cycle) => [...cycle].sort());
  }

  /** Shortest dependency chain `from → … → to`, or undefined when `from` does not depend on `to`. */
  path(from: string, to: string): string[] | undefined {
    if (!this.graph.hasNode(from) || !this.graph.hasNode(to)) return undefined;
    const distances = alg.dijkstra(this.graph, from);
    if (distances[to]?.distance === Number.POSITIVE_INFINITY) return undefined;
    const chain = [to];
    let current = to;
    while (current !== from) {
      const previous = distances[current]?.predecessor;
      if (previous === undefined) return undefined;
      chain.unshift(previous);
      current = previous;
    }
    return chain;
  }
}
