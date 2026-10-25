import type { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { DependencyGraph } from "../domain/graph.ts";
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
  ) {}

  async execute(input: ComputeAffectedInput): Promise<Result<AffectedSet, MetatorError>> {
    const changed = input.changed ? ok(input.changed) : await this.vcs.changedFiles(input.base ?? "HEAD");
    if (changed.isErr()) return err(changed.error);

    const edges = await this.graphReader.read();
    if (edges.isErr()) return err(edges.error);

    const files = [...new DependencyGraph(edges.value).affected(changed.value)].sort();
    return ok({
      changed: [...new Set(changed.value)].sort(),
      files,
      tests: files.filter((file) => matchesAny(file, this.testGlobs)),
    });
  }
}
