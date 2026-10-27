import { describe, expect, test } from "bun:test";
import type { WorktreeManager } from "@metator/core";

export interface WorktreeWorld {
  readonly manager: WorktreeManager;
  /** Leaves uncommitted work in the worktree at the repo-relative path. */
  readonly makeDirty: (path: string) => Promise<void>;
}

/** Every WorktreeManager adapter must pass this suite (the factory gives a repository with one commit). */
export function worktreeManagerContract(name: string, make: () => Promise<WorktreeWorld>): void {
  describe(`WorktreeManager contract: ${name}`, () => {
    test("add, then a clean worktree, then remove", async () => {
      const { manager } = await make();
      expect((await manager.add(".metator/wt/a", "metator/a", "HEAD")).isOk()).toBe(true);
      expect((await manager.isDirty(".metator/wt/a"))._unsafeUnwrap()).toBe(false);
      expect((await manager.remove(".metator/wt/a", false)).isOk()).toBe(true);
    });

    test("the same path twice is an error value", async () => {
      const { manager } = await make();
      await manager.add(".metator/wt/a", "metator/a", "HEAD");
      const again = await manager.add(".metator/wt/a", "metator/a2", "HEAD");
      expect(again._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
    });

    test("uncommitted work is dirty; removing it needs force", async () => {
      const w = await make();
      await w.manager.add(".metator/wt/a", "metator/a", "HEAD");
      await w.makeDirty(".metator/wt/a");
      expect((await w.manager.isDirty(".metator/wt/a"))._unsafeUnwrap()).toBe(true);
      expect((await w.manager.remove(".metator/wt/a", false)).isErr()).toBe(true);
      expect((await w.manager.remove(".metator/wt/a", true)).isOk()).toBe(true);
    });
  });
}
