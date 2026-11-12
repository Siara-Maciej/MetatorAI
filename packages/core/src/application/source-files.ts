import { isGeneratedHostFile } from "../domain/agent.ts";
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

/**
 * The files among `files` that `metator generate` wrote for the hosts: Markdown that carries its
 * marker, and everything beside a generated `SKILL.md` (a skill's references and scripts). They
 * are copies of the canon in `metator/`, so commands that read the repository's own documents
 * leave them out.
 */
export async function generatedHostFiles(
  fs: ReadonlyFileSystem,
  files: readonly string[],
): Promise<ReadonlySet<string>> {
  const generated = new Set<string>();
  const skills: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const text = await fs.read(file);
    if (text.isErr() || !isGeneratedHostFile(text.value)) continue;
    generated.add(file);
    if (file.endsWith("/SKILL.md")) skills.push(file.slice(0, -"SKILL.md".length));
  }
  for (const file of files) if (skills.some((dir) => file.startsWith(dir))) generated.add(file);
  return generated;
}
