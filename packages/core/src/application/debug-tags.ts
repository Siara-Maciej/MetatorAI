import { type DebugTag, findDebugTags } from "../domain/debug-tags.ts";
import type { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ReadonlyFileSystem, Vcs } from "../ports/index.ts";

/**
 * `debug-tags check` (ADR-0044): no `[DEBUG-xxxx]` marker is left in the files changed against
 * a base, or in every tracked file with `all`. Markdown is skipped: instrumentation lives in code,
 * and documentation shows the tags as examples.
 */
const DOCS = ["**/*.md", "**/*.mdx"];
export class CheckDebugTags {
  constructor(
    private readonly vcs: Vcs,
    private readonly fs: ReadonlyFileSystem,
    private readonly ignore: readonly string[],
  ) {}

  async execute(input: {
    readonly base?: string;
  }): Promise<Result<{ readonly scanned: number; readonly tags: readonly DebugTag[] }, MetatorError>> {
    const files =
      input.base === undefined ? await this.vcs.listFiles() : await this.vcs.changedFiles(input.base);
    if (files.isErr()) return err(files.error);
    const tags: DebugTag[] = [];
    let scanned = 0;
    for (const file of files.value) {
      if (matchesAny(file, this.ignore) || matchesAny(file, DOCS)) continue;
      const text = await this.fs.read(file);
      if (text.isErr()) continue; // deleted on the branch
      scanned++;
      tags.push(...findDebugTags(file, text.value));
    }
    return ok({ scanned, tags });
  }
}
