import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, MetatorError, ok, type Result, type WorktreeManager } from "@metator/core";
import { simpleGit } from "simple-git";

/** WorktreeManager on simple-git (`git worktree add|remove`, ADR-0050). Paths are repo-relative. */
export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly root: string) {}

  async add(path: string, branch: string, base: string): Promise<Result<void, MetatorError>> {
    return this.attempt(`git worktree add ${path}`, async () => {
      await simpleGit(this.root).raw(["worktree", "add", "-b", branch, path, base]);
    });
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
