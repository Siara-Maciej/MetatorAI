export type EdgeKind = "internal" | "cross-package" | "external";

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

/** File-level dependency graph. Pure: built from edges produced by an ImportGraphReader adapter. */
export class DependencyGraph {
  private readonly forward = new Map<string, Set<string>>();
  private readonly reverse = new Map<string, Set<string>>();

  constructor(readonly edges: readonly Edge[]) {
    for (const edge of edges) {
      if (edge.kind === "external") continue;
      addTo(this.forward, edge.from, edge.to);
      addTo(this.reverse, edge.to, edge.from);
    }
  }

  dependenciesOf(file: string): ReadonlySet<string> {
    return this.forward.get(file) ?? new Set();
  }

  dependentsOf(file: string): ReadonlySet<string> {
    return this.reverse.get(file) ?? new Set();
  }

  /** Changed files plus everything that (transitively) depends on them. Cycle-safe. */
  affected(changed: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...changed];
    while (stack.length > 0) {
      const file = stack.pop() as string;
      if (out.has(file)) continue;
      out.add(file);
      for (const dependent of this.dependentsOf(file)) stack.push(dependent);
    }
    return out;
  }
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}
