import type { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ReadonlyFileSystem, Vcs } from "../ports/index.ts";

/**
 * The repository's source files: git's view when available (respects .gitignore, includes
 * untracked files), the file system otherwise. Filtered by extension (all when omitted) and ignore globs.
 */
export class SourceFiles {
  constructor(
    private readonly vcs: Vcs,
    private readonly fs: ReadonlyFileSystem,
    private readonly ignores: readonly string[],
  ) {}

  async list(extensions?: readonly string[]): Promise<Result<readonly string[], MetatorError>> {
    const fromGit = await this.vcs.listFiles();
    let files: readonly string[];
    if (fromGit.isOk()) files = fromGit.value;
    else if (fromGit.error.code === "NOT_FOUND") files = await this.fs.glob(["**/*"]);
    else return err(fromGit.error);

    const ignored = (file: string) => this.ignores.length > 0 && matchesAny(file, this.ignores);
    return ok(
      files.filter((file) => (!extensions || extensions.some((ext) => file.endsWith(ext))) && !ignored(file)),
    );
  }
}
