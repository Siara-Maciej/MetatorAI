import { basename, dirname, resolve } from "node:path";
import { err, MetatorError, ok, type ProcessRunner, type RepositoryGit, type Result } from "@metator/core";

/**
 * RepositoryGit on the git CLI through the ProcessRunner (ADR-0105): `--version`, `rev-parse`,
 * `status --porcelain -z` and, for a setup's commit, `add` and `commit --only` with the paths
 * named, so nothing else staged goes into it.
 */
export class GitCliRepository implements RepositoryGit {
  constructor(
    private readonly runner: ProcessRunner,
    /** Path prefixes that are never uncommitted work (MetatorAI's own state, before it is gitignored). */
    private readonly own: readonly string[] = [".metator/"],
  ) {}

  private git(argv: readonly string[], cwd: string) {
    return this.runner.run({ argv: ["git", ...argv], cwd });
  }

  async version(): Promise<string | undefined> {
    const r = await this.git(["--version"], process.cwd());
    if (r.exitCode !== 0) return undefined;
    return /(\d+\.\d+(\.\d+)?)/.exec(r.stdout)?.[1] ?? r.stdout.trim();
  }

  async checkout(dir: string): Promise<{ readonly top: string; readonly main: string } | undefined> {
    // No --path-format=absolute: git before 2.31 (Debian 11 has 2.30) refuses it. --show-toplevel is
    // absolute anyway; --git-common-dir may be relative to `dir`, so it is resolved against it.
    const r = await this.git(["rev-parse", "--show-toplevel", "--git-common-dir"], dir);
    if (r.exitCode !== 0) return undefined;
    const [top, relativeCommon] = r.stdout.split("\n").map((l) => l.trim());
    if (!top || !relativeCommon) return undefined;
    const common = resolve(dir, relativeCommon);
    // A linked worktree shares the main checkout's `.git`: the main checkout is the folder that holds it.
    const main = basename(common) === ".git" ? dirname(common) : top;
    return { top: resolve(top), main: resolve(main) };
  }

  async uncommitted(root: string): Promise<Result<readonly string[], MetatorError>> {
    // -z: names verbatim (no quoting of a space or a letter outside ASCII), one entry per NUL.
    const r = await this.git(["status", "--porcelain", "-z", "--untracked-files=all"], root);
    if (r.exitCode !== 0)
      return err(new MetatorError("COMMAND_FAILED", `git status in ${root}: ${r.stderr.trim()}`));
    const files = new Set<string>();
    const entries = r.stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as string;
      if (entry.length <= 3) continue;
      files.add(entry.slice(3));
      // A rename or a copy is followed by the path it came from, which is not a change of its own.
      if (entry[0] === "R" || entry[0] === "C") i++;
    }
    return ok([...files].filter((f) => !this.own.some((p) => f.startsWith(p))).sort());
  }

  async commit(
    root: string,
    files: readonly string[],
    message: string,
  ): Promise<Result<string, MetatorError>> {
    if (files.length === 0) return err(MetatorError.usage("nothing to commit: no files named"));
    const added = await this.git(["add", "--", ...files], root);
    if (added.exitCode !== 0) return err(failed("git add", added.stderr));
    const committed = await this.git(["commit", "-m", message, "--only", "--", ...files], root);
    if (committed.exitCode !== 0)
      return err(failed("git commit", `${committed.stderr}\n${committed.stdout}`));
    const head = await this.git(["rev-parse", "HEAD"], root);
    if (head.exitCode !== 0) return err(failed("git rev-parse", head.stderr));
    return ok(head.stdout.trim());
  }
}

function failed(step: string, said: string): MetatorError {
  const text = said.trim();
  const identity = /user\.(name|email)|Please tell me who you are|empty ident/i.test(text);
  return new MetatorError("COMMAND_FAILED", `${step} failed: ${text.split("\n").slice(0, 3).join(" ")}`, {
    hint: identity
      ? 'git does not know who commits: git config --global user.name "Your Name" && git config --global user.email you@example.com'
      : "Run the same git command in the repository to see why.",
  });
}
