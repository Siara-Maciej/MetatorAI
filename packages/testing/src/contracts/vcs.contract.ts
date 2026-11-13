import { describe, expect, test } from "bun:test";
import type { Vcs } from "@metator/core";

export interface VcsWorld {
  /**
   * A repository with one commit holding `a.ts` and `b.ts`, then `a.ts` changed and a new
   * `c.ts`, neither committed; with `remote` as its `origin` when given.
   */
  readonly vcs: Vcs;
  /** The ref the changes are measured against (the one commit). */
  readonly base: string;
  readonly remote?: string;
  /** The same adapter where there is no repository. */
  readonly outside: Vcs;
}

/**
 * Every Vcs adapter passes this suite: the repository's files and the changes since a base as
 * sorted repo-relative paths without duplicates, the remote's URL or none, and "not a repository"
 * as an error value from every method.
 */
export function vcsContract(name: string, make: () => Promise<VcsWorld>): void {
  describe(`Vcs contract: ${name}`, () => {
    test("lists the repository's files, repo-relative, sorted, each once", async () => {
      const { vcs } = await make();
      const files = (await vcs.listFiles())._unsafeUnwrap();
      expect(files).toEqual(["a.ts", "b.ts", "c.ts"]);
    });

    test("the changes since the base are the changed and the new files, sorted, each once", async () => {
      const { vcs, base } = await make();
      expect((await vcs.changedFiles(base))._unsafeUnwrap()).toEqual(["a.ts", "c.ts"]);
    });

    test("the remote's URL, or none", async () => {
      const w = await make();
      expect((await w.vcs.remoteUrl())._unsafeUnwrap()).toBe(w.remote as string);
    });

    test("a repository with a commit says so, when the adapter can tell", async () => {
      const { vcs } = await make();
      if (vcs.hasCommits) expect((await vcs.hasCommits())._unsafeUnwrap()).toBe(true);
    });

    test("where there is no repository every method is NOT_FOUND, never a throw", async () => {
      const { outside, base } = await make();
      expect((await outside.listFiles())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
      expect((await outside.changedFiles(base))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
      expect((await outside.remoteUrl())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    });
  });
}
