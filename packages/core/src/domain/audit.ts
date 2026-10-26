import { alg, Graph } from "@dagrejs/graphlib";

/**
 * `meta audit` (F0, ADR-0039): inventory of agents, skills and prompts, canonical or hand-written
 * in a host directory, and the call graph between them. Findings are what the roadmap's audit
 * looks for: cycles, dead elements and delegation deeper than two levels.
 */
export const AUDIT_KINDS = ["agent", "skill", "prompt"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditNode {
  readonly id: string;
  readonly kind: AuditKind;
  readonly source: string;
  /** canonical (metator/…), generated (a host copy of the canon) or hand-written in a host directory. */
  readonly origin: "canonical" | "generated" | "host";
  /** A person can start it (a prompt, a user-invocable agent, a skill the host loads by description). */
  readonly entry: boolean;
  readonly references: readonly { readonly to: string; readonly via: "delegates" | "mentions" }[];
}

export interface Audit {
  readonly nodes: readonly AuditNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly via: string }[];
  readonly cycles: readonly (readonly string[])[];
  /** Nodes nothing reaches from an entry point. */
  readonly dead: readonly string[];
  /** Delegation chains from an entry longer than `maxDepth` (each listed once, longest first). */
  readonly tooDeep: readonly (readonly string[])[];
  readonly unknownReferences: readonly { readonly from: string; readonly to: string }[];
}

/** Names that look like agents or skills (`mt-scout`, `eq-logic-reviewer`) mentioned in a text. */
export function mentionedNames(text: string, known: ReadonlySet<string>, self: string): string[] {
  const out = new Set<string>();
  for (const [name] of text.matchAll(/\b[a-z][a-z0-9]*-[a-z0-9-]*[a-z0-9]\b/g))
    if (name !== self && known.has(name)) out.add(name);
  return [...out].sort();
}

export function auditGraph(nodes: readonly AuditNode[], maxDepth = 2): Audit {
  // Generated host copies are the canon again; the graph uses one node per id.
  const byId = new Map<string, AuditNode>();
  for (const n of nodes) {
    const seen = byId.get(n.id);
    if (!seen || (seen.origin === "generated" && n.origin !== "generated")) byId.set(n.id, n);
  }
  const g = new Graph({ directed: true });
  for (const id of byId.keys()) g.setNode(id);
  const edges: { from: string; to: string; via: string }[] = [];
  const unknownReferences: { from: string; to: string }[] = [];
  for (const n of byId.values()) {
    for (const r of n.references) {
      if (!byId.has(r.to)) unknownReferences.push({ from: n.id, to: r.to });
      else if (!g.hasEdge(n.id, r.to)) {
        g.setEdge(n.id, r.to, r.via);
        edges.push({ from: n.id, to: r.to, via: r.via });
      }
    }
  }

  // A mention ("started by mt-x") is a back-reference, not a call: cycles count delegations only.
  const delegation = new Graph({ directed: true });
  for (const e of edges) if (e.via === "delegates") delegation.setEdge(e.from, e.to);

  const entries = [...byId.values()].filter((n) => n.entry).map((n) => n.id);
  const reached = new Set(entries.length > 0 ? alg.preorder(g, entries) : []);
  const dead = [...byId.keys()].filter((id) => !reached.has(id)).sort();

  // Delegation depth: longest acyclic delegates-chain from each entry.
  const delegates = (id: string) =>
    (g.outEdges(id) ?? []).filter((e) => g.edge(e) === "delegates").map((e) => e.w);
  const chains: string[][] = [];
  const walk = (path: string[]) => {
    const next = delegates(path[path.length - 1] as string).filter((d) => !path.includes(d));
    if (next.length === 0) {
      if (path.length - 1 > maxDepth) chains.push(path);
      return;
    }
    for (const d of next) walk([...path, d]);
  };
  for (const e of entries) walk([e]);
  const tooDeep = chains
    .sort((a, b) => b.length - a.length || a.join().localeCompare(b.join()))
    .filter((c, i, all) => !all.slice(0, i).some((longer) => longer.join(">").includes(c.join(">"))));

  return {
    nodes: [...nodes].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.source.localeCompare(b.source),
    ),
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    cycles: alg.findCycles(delegation).map((c) => [...c].sort()),
    dead,
    tooDeep,
    unknownReferences: unknownReferences.sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    ),
  };
}
