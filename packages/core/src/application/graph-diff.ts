import type { MetatorError } from "../domain/errors.ts";
import type { Edge } from "../domain/graph.ts";
import { diffGraphs, type GraphDiff } from "../domain/graph-diff.ts";
import { classifyEdge, resolveAmong } from "../domain/import-index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ImportAnalyzer, RevisionReader, Vcs } from "../ports/index.ts";
import { type BuildImportGraph, resolveImport } from "./import-graph.ts";

export interface GraphDiffReport extends GraphDiff {
  readonly base: string;
  readonly changed: number;
}

/**
 * `graph diff --base <ref>` (ADR-0036). Only changed files can have different imports, so the
 * base graph is the current graph with each changed file's edges replaced by those of its
 * version at the merge base (parsed and resolved like the current tree).
 */
export class DiffImportGraph {
  constructor(
    private readonly vcs: Vcs,
    private readonly history: RevisionReader,
    private readonly graph: Pick<BuildImportGraph, "execute">,
    private readonly analyzer: ImportAnalyzer,
  ) {}

  async execute(input: { readonly base: string }): Promise<Result<GraphDiffReport, MetatorError>> {
    const changed = await this.vcs.changedFiles(input.base);
    if (changed.isErr()) return err(changed.error);
    const current = await this.graph.execute();
    if (current.isErr()) return err(current.error);

    const sources = changed.value.filter((f) => this.analyzer.extensions.some((ext) => f.endsWith(ext)));
    const touched = new Set(sources);
    const base: Edge[] = current.value.edges.filter((e) => !touched.has(e.from));
    const packages = current.value.packages;
    const texts = new Map<string, string>();
    for (const file of sources) {
      const text = await this.history.readAt(input.base, file);
      if (text.isErr()) return err(text.error);
      if (text.value !== undefined) texts.set(file, text.value); // else added on the branch: no edges at the base
    }
    // Files only the base has (deleted or renamed on the branch): a base import of one resolves
    // to nothing in the current tree, and is still an edge the branch removed.
    const present = new Set(current.value.files);
    const baseOnly = new Set([...texts.keys()].filter((f) => !present.has(f)));
    const toDeleted = (from: string, specifier: string) =>
      resolveAmong(from, specifier, baseOnly, this.analyzer.extensions);
    for (const [file, text] of texts) {
      const imports = this.analyzer.parse(file, text);
      if (imports.isErr()) continue; // unparsable at the base: nothing to compare against
      for (const { specifier } of imports.value) {
        const target = resolveImport(this.analyzer, packages, file, specifier);
        const to = target.type === "file" ? target.path : toDeleted(file, specifier);
        if (to) base.push({ from: file, to, kind: classifyEdge(file, to, packages) });
      }
    }
    // An unchanged importer of a deleted file had that edge at the base too.
    for (const u of current.value.unresolved) {
      const to = touched.has(u.from) ? undefined : toDeleted(u.from, u.specifier);
      if (to) base.push({ from: u.from, to, kind: classifyEdge(u.from, to, packages) });
    }
    return ok({
      base: input.base,
      changed: changed.value.length,
      ...diffGraphs(base, current.value.edges, current.value.packages),
    });
  }
}
