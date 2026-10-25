import { existsSync } from "node:fs";
import { err, MetatorError, ok, type Result, type Vcs } from "@metator/core";
import { type SimpleGit, simpleGit } from "simple-git";

/**
 * Vcs adapter on simple-git (ADR-0019): the library spawns git, parses `status -z` and turns
 * failures into errors; this class only maps them to MetatorError. "Changed" means everything
 * that differs from the merge base with `base`: committed on the branch, staged, unstaged,
 * deleted and untracked (non-ignored) files. Paths are repo-relative.
 */
export class GitVcs implements Vcs {
  private client: SimpleGit | undefined;

  constructor(private readonly root: string) {}

  async changedFiles(base: string): Promise<Result<readonly string[], MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      if (!(await this.hasCommits(git.value))) {
        return ok(sortedUnique(splitZ(await git.value.raw([...LS_FILES, "--cached", "--others"]))));
      }
      let ref = "HEAD";
      if (base !== "HEAD") {
        const mergeBase = await git.value.raw(["merge-base", base, "HEAD"]).catch(() => undefined);
        if (!mergeBase?.trim()) {
          return err(
            MetatorError.usage(
              `Unknown base ref "${base}"`,
              "Use a branch, tag or commit that shares history with HEAD.",
            ),
          );
        }
        ref = mergeBase.trim();
      }
      // --no-renames: a rename counts under both paths, the old path's importers are affected too.
      const diff = splitZ(await git.value.diff(["--name-only", "--no-renames", "-z", ref]));
      const untracked = (await git.value.status()).not_added;
      return ok(sortedUnique([...diff, ...untracked]));
    });
  }

  async listFiles(): Promise<Result<readonly string[], MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const files = splitZ(await git.value.raw([...LS_FILES, "--cached", "--others"]));
      // Tracked files deleted in the working tree are still listed by --cached; drop them.
      const gone = new Set(splitZ(await git.value.raw([...LS_FILES, "--deleted"])));
      return ok(sortedUnique(files.filter((f) => !gone.has(f))));
    });
  }

  private async repo(): Promise<Result<SimpleGit, MetatorError>> {
    const notFound = () =>
      err(
        new MetatorError("NOT_FOUND", `Not a git repository: ${this.root}`, {
          hint: "Run inside a git checkout.",
        }),
      );
    // simple-git refuses to start in a missing directory; that is "not a repository" too.
    if (!existsSync(this.root)) return notFound();
    this.client ??= simpleGit({
      baseDir: this.root,
      config: ["core.quotepath=false"],
      timeout: { block: 30_000 },
    });
    const inside = await this.client.checkIsRepo().catch(() => false);
    return inside ? ok(this.client) : notFound();
  }

  private async hasCommits(git: SimpleGit): Promise<boolean> {
    // Not `--quiet`: git would then fail without stderr, which simple-git reports as success.
    return git
      .revparse(["--verify", "HEAD"])
      .then(() => true)
      .catch(() => false);
  }

  private async attempt<T>(work: () => Promise<Result<T, MetatorError>>): Promise<Result<T, MetatorError>> {
    try {
      return await work();
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `git failed: ${(e as Error).message.trim().slice(0, 500)}`),
      );
    }
  }
}

const LS_FILES = ["ls-files", "-z", "--exclude-standard"];

function splitZ(out: string): string[] {
  return out.split("\0").filter((p) => p !== "");
}

function sortedUnique(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort();
}
