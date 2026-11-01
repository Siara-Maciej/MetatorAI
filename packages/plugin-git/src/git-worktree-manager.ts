import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { err, MetatorError, ok, type Result, type WorktreeManager } from "@metator/core";
import { simpleGit } from "simple-git";

/** WorktreeManager on simple-git (`git worktree add|remove`, ADR-0050). Paths are repo-relative. */
export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly root: string) {}

  async add(
    path: string,
    branch: string,
    base: string,
    shared: readonly string[] = [],
    setup: readonly string[] = [],
  ): Promise<Result<void, MetatorError>> {
    return this.attempt(`git worktree add ${path}`, async () => {
      await simpleGit(this.root).raw(["worktree", "add", "-b", branch, path, base]);
      await this.linkSetup(path, setup, shared);
      if (shared.length === 0) return;
      // The links are not work: git ignores them (info/exclude is shared by every worktree), so a
      // worktree stays clean and `git add -A` never commits one.
      const common = (await simpleGit(this.root).revparse(["--git-common-dir"])).trim();
      const exclude = join(isAbsolute(common) ? common : join(this.root, common), "info", "exclude");
      const known = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      const missing = shared.map((d) => `/${d}`).filter((p) => !known.split("\n").includes(p));
      if (missing.length > 0) {
        mkdirSync(dirname(exclude), { recursive: true });
        appendFileSync(exclude, `${known === "" || known.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
      }
      for (const dir of shared) {
        const link = join(this.root, path, dir);
        if (existsSync(link)) continue;
        mkdirSync(join(this.root, dir), { recursive: true });
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(join(this.root, dir), link, "dir");
      }
    });
  }

  /**
   * Links each untracked file of this checkout under `setup` into the worktree, and ignores the
   * links there only (a per-worktree excludes file), with the directory that holds the `shared`
   * ones (`.metator/`: the worktree's own index and gate reports are no work either). The checkout
   * keeps showing the setup as untracked, so the person still sees a setup to commit.
   */
  private async linkSetup(path: string, setup: readonly string[], shared: readonly string[]): Promise<void> {
    const git = simpleGit(this.root);
    const untracked =
      setup.length === 0
        ? []
        : (await git.raw(["ls-files", "--others", "--exclude-standard", "--", ...setup]))
            .split("\n")
            .filter((f) => f !== "" && !existsSync(join(this.root, path, f)));
    for (const file of untracked) {
      const link = join(this.root, path, file);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(this.root, file), link, "file");
    }
    const ignored = [...new Set(shared.map((d) => `/${d.split("/")[0]}/`)), ...untracked.map((f) => `/${f}`)];
    if (ignored.length === 0) return;
    const wt = simpleGit(join(this.root, path));
    const gitDir = (await wt.revparse(["--absolute-git-dir"])).trim();
    // The person's own global excludes still apply in the worktree.
    const global = (await git.raw(["config", "--path", "--get", "core.excludesFile"]).catch(() => "")).trim();
    const xdg = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "git", "ignore");
    const inherited = [global, xdg].find((f) => f !== "" && existsSync(f));
    const excludes = join(gitDir, "metator-exclude");
    writeFileSync(
      excludes,
      `${inherited ? `${readFileSync(inherited, "utf8").trimEnd()}\n` : ""}${ignored.join("\n")}\n`,
    );
    await git.raw(["config", "extensions.worktreeConfig", "true"]);
    await wt.raw(["config", "--worktree", "core.excludesFile", excludes]);
  }

  async remove(path: string, force: boolean): Promise<Result<void, MetatorError>> {
    // git also drops its record of a worktree whose directory was deleted by hand.
    return this.attempt(`git worktree remove ${path}`, async () => {
      await simpleGit(this.root).raw(["worktree", "remove", ...(force ? ["--force"] : []), path]);
    });
  }

  async isDirty(path: string): Promise<Result<boolean, MetatorError>> {
    const dir = join(this.root, path);
    if (!existsSync(dir)) return ok(false);
    try {
      return ok(!(await simpleGit(dir).status()).isClean());
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `git status in ${path}: ${(e as Error).message}`));
    }
  }

  async switchBranch(path: string, branch: string, base: string): Promise<Result<void, MetatorError>> {
    return this.attempt(`git switch -c ${branch} in ${path}`, async () => {
      // The base is resolved in this checkout: "HEAD" means its HEAD, not the worktree's.
      const sha = (await simpleGit(this.root).revparse([base])).trim();
      const wt = simpleGit(join(this.root, path));
      const previous = (await wt.revparse(["--abbrev-ref", "HEAD"])).trim();
      await wt.raw(["switch", "-c", branch, sha]);
      if (previous !== "HEAD" && previous !== branch)
        await simpleGit(this.root).raw(["branch", "-D", previous]);
    });
  }

  private async attempt(what: string, run: () => Promise<void>): Promise<Result<void, MetatorError>> {
    try {
      await run();
      return ok(undefined);
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `${what}: ${(e as Error).message.trim()}`, {
          hint: "Check `git worktree list` and that the base ref exists.",
        }),
      );
    }
  }
}
