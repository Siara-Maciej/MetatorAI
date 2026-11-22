import { describe, expect, test } from "bun:test";
import {
  type Checkout,
  checkoutLabel,
  checkoutOf,
  type GitFiles,
  groupCheckouts,
} from "../src/domain/git-checkout.ts";

/** Git's files as a map: a path ending in `/` is a directory, any other a file with its text. */
const files = (tree: Record<string, string>): GitFiles => ({
  text: (p) => tree[p],
  isDir: (p) => `${p}/` in tree,
});

describe("checkoutOf: what a checkout's .git says it is", () => {
  test("a .git directory is a repository of its own, its common dir that directory", () => {
    expect(checkoutOf("/w/shop", files({ "/w/shop/.git/": "" }))).toEqual({
      kind: "repository",
      common: "/w/shop/.git",
    });
  });

  test("a .git file whose gitdir has a commondir is a linked worktree of the main checkout", () => {
    const tree = files({
      "/w/shop-fix/.git": "gitdir: /w/shop/.git/worktrees/shop-fix\n",
      "/w/shop/.git/worktrees/shop-fix/commondir": "../..\n",
      "/w/shop/.git/worktrees/shop-fix/HEAD": "ref: refs/heads/fix-tax\n",
      "/w/shop/.git/config": "[core]\n\tbare = false\n",
    });
    expect(checkoutOf("/w/shop-fix", tree)).toEqual({
      kind: "worktree",
      common: "/w/shop/.git",
      main: "/w/shop",
      branch: "fix-tax",
    });
  });

  test("a relative gitdir is read from the checkout; a detached HEAD has no branch", () => {
    const tree = files({
      "/w/a/fix/.git": "gitdir: ../../shop/.git/worktrees/fix",
      "/w/shop/.git/worktrees/fix/commondir": "../..",
      "/w/shop/.git/worktrees/fix/HEAD": "3f1c0de9a1b2c3d4e5f60718293a4b5c6d7e8f90\n",
    });
    expect(checkoutOf("/w/a/fix/", tree)).toEqual({
      kind: "worktree",
      common: "/w/shop/.git",
      main: "/w/shop",
      branch: undefined,
    });
  });

  test("a submodule's gitdir under .git/modules has no commondir: it is not a worktree", () => {
    const tree = files({ "/w/app/lib/.git": "gitdir: ../.git/modules/lib\n" });
    expect(checkoutOf("/w/app/lib", tree)).toEqual({ kind: "submodule", common: "/w/app/.git/modules/lib" });
  });

  test("a worktree of a bare repository has no main checkout", () => {
    const tree = files({
      "/w/shop-main/.git": "gitdir: /w/shop.git/worktrees/shop-main",
      "/w/shop.git/worktrees/shop-main/commondir": "../..",
      "/w/shop.git/worktrees/shop-main/HEAD": "ref: refs/heads/main",
      "/w/shop.git/config": "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
    });
    expect(checkoutOf("/w/shop-main", tree)).toEqual({
      kind: "worktree",
      common: "/w/shop.git",
      main: undefined,
      branch: "main",
    });
  });

  test("a gitdir with no commondir elsewhere (--separate-git-dir) is a repository; no .git is nothing", () => {
    const tree = files({ "/w/x/.git": "gitdir: /store/x.git\n", "/w/y/.git": "not a pointer" });
    expect(checkoutOf("/w/x", tree)).toEqual({ kind: "repository", common: "/store/x.git" });
    expect(checkoutOf("/w/y", tree)).toEqual({ kind: "none" });
    expect(checkoutOf("/w/z", tree)).toEqual({ kind: "none" });
  });

  test("Windows paths keep their drive and use forward slashes", () => {
    const tree = files({
      "C:/w/fix/.git": "gitdir: C:/w/shop/.git/worktrees/fix",
      "C:/w/shop/.git/worktrees/fix/commondir": "../..",
    });
    expect(checkoutOf("C:\\w\\fix", tree)).toMatchObject({ kind: "worktree", main: "C:/w/shop" });
  });
});

describe("groupCheckouts: a folder's checkouts as repositories", () => {
  const repo = (common: string): Checkout => ({ kind: "repository", common });
  const wt = (common: string, main: string | undefined, branch?: string): Checkout => ({
    kind: "worktree",
    common,
    main,
    branch,
  });

  test("worktrees of a repository in the folder are its checkouts, not repositories", () => {
    expect(
      groupCheckouts([
        { path: "shop-wip", checkout: wt("/w/shop/.git", "/w/shop") },
        { path: "billing", checkout: repo("/w/billing/.git") },
        { path: "shop", checkout: repo("/w/shop/.git") },
        { path: "shop-fix", checkout: wt("/w/shop/.git", "/w/shop", "fix-tax") },
        { path: "notes", checkout: { kind: "none" } },
      ]),
    ).toEqual([
      { path: "billing", worktrees: [] },
      { path: "notes", worktrees: [] },
      {
        path: "shop",
        worktrees: [{ path: "shop-fix", branch: "fix-tax" }, { path: "shop-wip" }],
      },
    ]);
  });

  test("the main checkout stands for its repository even when a worktree sorts first", () => {
    expect(
      groupCheckouts([
        { path: "shop", checkout: repo("/w/shop/.git") },
        { path: "a-fix", checkout: wt("/w/shop/.git", "/w/shop", "fix") },
      ]),
    ).toEqual([{ path: "shop", worktrees: [{ path: "a-fix", branch: "fix" }] }]);
  });

  test("with no main checkout in the folder (bare, or elsewhere) the first worktree stands for the repository", () => {
    expect(
      groupCheckouts([
        { path: "b-main", checkout: wt("/w/b.git", undefined, "main") },
        { path: "a-fix", checkout: wt("/elsewhere/a/.git", "/elsewhere/a", "fix") },
        { path: "b-fix", checkout: wt("/w/b.git", undefined, "fix") },
      ]),
    ).toEqual([
      { path: "a-fix", worktrees: [] },
      { path: "b-fix", worktrees: [{ path: "b-main", branch: "main" }] },
    ]);
  });

  test("a submodule and two repositories with their own .git stay apart", () => {
    expect(
      groupCheckouts([
        { path: "lib", checkout: { kind: "submodule", common: "/w/app/.git/modules/lib" } },
        { path: "a", checkout: repo("/w/a/.git") },
        { path: "b", checkout: repo("/w/b/.git") },
      ]).map((r) => r.path),
    ).toEqual(["a", "b", "lib"]);
  });

  test("a worktree's label is its repository with its branch, else its directory", () => {
    expect(checkoutLabel("shop", { path: "work/shop-fix", branch: "fix-tax" })).toBe("shop (fix-tax)");
    expect(checkoutLabel("shop", { path: "work/shop-fix" })).toBe("shop (shop-fix)");
  });
});
