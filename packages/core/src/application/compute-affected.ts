import type { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { DependencyGraph, type Edge } from "../domain/graph.ts";
import { resolveAmong } from "../domain/import-index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ImportGraphReader, Vcs } from "../ports/index.ts";

export interface ComputeAffectedInput {
  /** Git ref to diff against, or an explicit list of changed files. */
  readonly base?: string;
  readonly changed?: readonly string[];
}

export interface AffectedSet {
  readonly changed: readonly string[];
  readonly files: readonly string[];
  readonly tests: readonly string[];
}

export class ComputeAffected {
  constructor(
    private readonly vcs: Vcs,
    private readonly graphReader: ImportGraphReader,
    private readonly testGlobs: readonly string[],
    /** Source extensions, to match an import written without one to a deleted file. */
    private readonly extensions: readonly string[] = [],
  ) {}

  async execute(input: ComputeAffectedInput): Promise<Result<AffectedSet, MetatorError>> {
    const changed = input.changed ? ok(input.changed) : await this.vcs.changedFiles(input.base ?? "HEAD");
    if (changed.isErr()) return err(changed.error);

    const graph = this.graphReader.graph
      ? await this.graphReader.graph()
      : (await this.graphReader.read()).map((edges) => ({ edges, unresolved: [] }));
    if (graph.isErr()) return err(graph.error);

    // A deleted (or renamed) module is no node of the working tree's graph: its importers are
    // the files whose import of it resolves to nothing now.
    const changedSet = new Set(changed.value);
    const dangling: Edge[] = graph.value.unresolved.flatMap((u) => {
      const to = resolveAmong(u.from, u.specifier, changedSet, this.extensions);
      return to ? [{ from: u.from, to, kind: "internal" as const }] : [];
    });
    const files = [
      ...new DependencyGraph([...graph.value.edges, ...dangling]).affected(changed.value),
    ].sort();
    return ok({
      changed: [...new Set(changed.value)].sort(),
      files,
      tests: files.filter((file) => matchesAny(file, this.testGlobs)),
    });
  }
}
