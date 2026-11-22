import { describe, expect, test } from "bun:test";
import type { Checkout } from "../src/domain/git-checkout.ts";
import {
  checkoutsOf,
  foldWorktrees,
  proposeRepoSet,
  RepoSetDocument,
  reposOf,
} from "../src/domain/repo-set.ts";

describe("RepoSet", () => {
  test("names come from the last part of the path; clashing names get the whole path", () => {
    expect(proposeRepoSet(["web", "services/billing", "billing", "web"])).toEqual({
      repos: [
        { path: "billing", name: "billing" },
        { path: "services/billing", name: "services-billing" },
        { path: "web" },
      ],
    });
    expect(reposOf(proposeRepoSet(["a/x/", "b"])).repos).toEqual([
      { name: "x", path: "a/x", worktrees: [] },
      { name: "b", path: "b", worktrees: [] },
    ]);
  });

  test("two repositories with one name are a problem; paths stay inside the folder", () => {
    const set = { repos: [{ path: "a/api" }, { path: "b/api" }] };
    expect(reposOf(set).problems).toEqual(["two repositories are named api; give one of them a `name`"]);
    for (const path of ["/abs", "../up", "a/../b"]) {
      const r = RepoSetDocument.parse({ kind: "RepoSet", schemaVersion: 1, repos: [{ path }] }, "f");
      expect(r._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
    }
    expect(RepoSetDocument.parse({ kind: "RepoSet", schemaVersion: 1, repos: [] }, "f").isErr()).toBe(true);
  });
});

describe("RepoSet v2: a repository's worktrees", () => {
  const wt = (common: string, branch?: string): Checkout => ({
    kind: "worktree",
    common,
    main: common.replace(/\/\.git$/, ""),
    branch,
  });
  const repo = (common: string): Checkout => ({ kind: "repository", common });

  test("a v1 file reads as v2 with no worktrees; v2 lists them, folder-relative", () => {
    const v1 = RepoSetDocument.parse({ kind: "RepoSet", schemaVersion: 1, repos: [{ path: "shop" }] }, "f");
    expect(v1._unsafeUnwrap()).toEqual({ repos: [{ path: "shop" }] });
    const v2 = RepoSetDocument.parse(
      { kind: "RepoSet", schemaVersion: 2, repos: [{ path: "shop", worktrees: ["shop-fix"] }] },
      "f",
    );
    expect(reposOf(v2._unsafeUnwrap()).repos).toEqual([
      { name: "shop", path: "shop", worktrees: [{ name: "shop-fix", path: "shop-fix" }] },
    ]);
    const outside = RepoSetDocument.parse(
      { kind: "RepoSet", schemaVersion: 2, repos: [{ path: "shop", worktrees: ["../x"] }] },
      "f",
    );
    expect(outside._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });

  test("repos init proposes each repository with its worktrees; a worktree whose name is taken gets its path", () => {
    expect(
      proposeRepoSet([
        { path: "shop", worktrees: [{ path: "shop-fix", branch: "fix-tax" }] },
        { path: "web", worktrees: [] },
      ]),
    ).toEqual({ repos: [{ path: "shop", worktrees: ["shop-fix"] }, { path: "web" }] });
    expect(
      reposOf({ repos: [{ path: "web" }, { path: "shop", worktrees: ["wt/web"] }] }).repos[1]?.worktrees,
    ).toEqual([{ name: "wt-web", path: "wt/web" }]);
  });

  test("listed repositories that are worktrees of another listed one become its worktrees, said once", () => {
    const facts: Record<string, Checkout> = {
      shop: repo("/w/shop/.git"),
      "shop-fix": wt("/w/shop/.git", "fix-tax"),
      "shop-wip": wt("/w/shop/.git"),
      web: repo("/w/web/.git"),
    };
    const listed = reposOf({
      repos: [{ path: "shop-fix" }, { path: "shop", worktrees: ["shop-wip"] }, { path: "web" }],
    }).repos;
    expect(foldWorktrees(listed, (p) => facts[p] ?? { kind: "none" })).toEqual({
      repos: [
        {
          name: "shop",
          path: "shop",
          worktrees: [
            { name: "shop-wip", path: "shop-wip" },
            { name: "shop-fix", path: "shop-fix", branch: "fix-tax" },
          ],
        },
        { name: "web", path: "web", worktrees: [] },
      ],
      hints: ["shop-fix is a worktree of shop; counted once"],
    });
  });

  test("listed worktrees of a repository that is not listed: the first stands for it", () => {
    const facts: Record<string, Checkout> = {
      a: wt("/elsewhere/shop/.git", "a"),
      b: wt("/elsewhere/shop/.git", "b"),
    };
    const listed = reposOf({ repos: [{ path: "a" }, { path: "b" }] }).repos;
    const folded = foldWorktrees(listed, (p) => facts[p] ?? { kind: "none" });
    expect(folded.repos).toEqual([
      { name: "a", path: "a", worktrees: [{ name: "b", path: "b", branch: "b" }] },
    ]);
    expect(folded.hints).toEqual(["b is a worktree of a; counted once"]);
  });

  test("every checkout of a folder, each repository's first, with the label that tells it apart", () => {
    expect(
      checkoutsOf([
        {
          name: "shop",
          path: "shop",
          worktrees: [{ name: "shop-fix", path: "shop-fix", branch: "fix-tax" }],
        },
        { name: "web", path: "web", worktrees: [] },
      ]),
    ).toEqual([
      { name: "shop", path: "shop", repo: "shop", label: "shop" },
      {
        name: "shop-fix",
        path: "shop-fix",
        repo: "shop",
        label: "shop (fix-tax)",
        worktreeOf: "shop",
        branch: "fix-tax",
      },
      { name: "web", path: "web", repo: "web", label: "web" },
    ]);
  });
});
