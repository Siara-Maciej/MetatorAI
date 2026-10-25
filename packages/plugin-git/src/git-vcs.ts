import { err, MetatorError, ok, type ProcessRunner, type Result, type Vcs } from "@metator/core";

/**
 * Vcs adapter on the git CLI (through the ProcessRunner port, so it is testable and swappable).
 * "Changed" means everything that differs from the merge base with `base`: committed on the
 * branch, staged, unstaged, deleted and untracked (non-ignored) files. Paths are repo-relative.
 */
export class GitVcs implements Vcs {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
  ) {}

  async changedFiles(base: string): Promise<Result<readonly string[], MetatorError>> {
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.isErr()) {
      return err(
        new MetatorError("NOT_FOUND", `Not a git repository: ${this.root}`, {
          hint: "Run inside a git checkout.",
        }),
      );
    }

    const hasCommits = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"])).isOk();
    if (!hasCommits) {
      return (await this.listZ(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).map(
        sortedUnique,
      );
    }

    let ref = "HEAD";
    if (base !== "HEAD") {
      const mergeBase = await this.git(["merge-base", base, "HEAD"]);
      if (mergeBase.isErr()) {
        return err(
          MetatorError.usage(
            `Unknown base ref "${base}"`,
            "Use a branch, tag or commit that shares history with HEAD.",
          ),
        );
      }
      ref = mergeBase.value.trim();
    }

    const diff = await this.listZ(["diff", "--name-only", "-z", ref]);
    if (diff.isErr()) return diff;
    const untracked = await this.listZ(["ls-files", "-z", "--others", "--exclude-standard"]);
    if (untracked.isErr()) return untracked;
    return ok(sortedUnique([...diff.value, ...untracked.value]));
  }

  private async listZ(args: string[]): Promise<Result<readonly string[], MetatorError>> {
    return (await this.git(args)).map((out) => out.split("\0").filter((p) => p !== ""));
  }

  private async git(args: string[]): Promise<Result<string, MetatorError>> {
    const r = await this.runner.run(
      { argv: ["git", "-c", "core.quotepath=false", ...args], cwd: this.root },
      { timeoutMs: 30_000 },
    );
    if (r.exitCode === 0) return ok(r.stdout);
    return err(
      new MetatorError("COMMAND_FAILED", `git ${args[0]} failed (exit ${r.exitCode})`, {
        details: { args, stderr: r.stderr.trim().slice(0, 500) },
      }),
    );
  }
}

function sortedUnique(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort();
}
