import { join } from "node:path";
import { err, MetatorError, ok, type ProcessRunner, type Result, type WorkingTree } from "@metator/core";

/**
 * WorkingTree on the git CLI through the ProcessRunner: three plain questions (`merge-base` and
 * `diff`, `status --porcelain`, `symbolic-ref`) whose exit codes are the answer.
 */
export class GitWorkingTree implements WorkingTree {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
    /** Path prefixes that are never a change (MetatorAI's own state, before it is gitignored). */
    private readonly own: readonly string[] = [],
  ) {}

  async worktreeChanges(path: string): Promise<Result<readonly string[], MetatorError>> {
    const dir = join(this.root, path);
    const git = (argv: string[], cwd: string) => this.runner.run({ argv: ["git", ...argv], cwd });
    const head = (await git(["rev-parse", "HEAD"], this.root)).stdout.trim();
    const fork = await git(["merge-base", "HEAD", head], dir);
    if (fork.exitCode !== 0)
      return err(new MetatorError("COMMAND_FAILED", `git merge-base in ${dir}: ${fork.stderr.trim()}`));
    const committed = await git(["diff", "--name-only", fork.stdout.trim()], dir);
    const untracked = await git(["ls-files", "--others", "--exclude-standard"], dir);
    const files = `${committed.stdout}\n${untracked.stdout}`
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    return ok([...new Set(files)].sort());
  }

  async modifiedTracked(): Promise<readonly string[] | undefined> {
    // -z: names verbatim (no quoting of a space or a letter outside ASCII), one entry per NUL.
    const status = await this.runner.run({
      argv: ["git", "status", "--porcelain", "-z", "--untracked-files=no"],
      cwd: this.root,
    });
    if (status.exitCode !== 0) return undefined;
    const files: string[] = [];
    const entries = status.stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as string;
      if (entry.length <= 3) continue;
      files.push(entry.slice(3));
      // A rename or a copy is followed by the path it came from, which is not a change of its own.
      if (entry[0] === "R" || entry[0] === "C") i++;
    }
    return files.filter((f) => !this.own.some((p) => f.startsWith(p)));
  }

  async detachedHead(): Promise<boolean | undefined> {
    const head = await this.runner.run({ argv: ["git", "symbolic-ref", "-q", "HEAD"], cwd: this.root });
    if (head.exitCode === 0) return false;
    return head.exitCode === 1 ? true : undefined;
  }
}
