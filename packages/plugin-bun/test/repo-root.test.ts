import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findChildRepos,
  findFolderRepos,
  findFolderRoot,
  findRepoRoot,
  readCheckout,
  runsRootOf,
} from "../src/repo-root.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function folder(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metator-folder-"));
  dirs.push(root);
  for (const f of files) {
    await mkdir(join(root, f, ".."), { recursive: true });
    if (f.endsWith("/")) await mkdir(join(root, f), { recursive: true });
    else await writeFile(join(root, f), "");
  }
  return root;
}

describe("a folder of repositories", () => {
  test("repositories below a folder are found, two levels deep, never inside a repository", async () => {
    const root = await folder([
      "shop/.git/",
      "shop/vendor/lib/.git/",
      "services/billing/.git/",
      "services/mailer/metator.config.yml",
      "node_modules/x/.git/",
      ".hidden/y/.git/",
      "docs/readme.md",
    ]);
    expect(findChildRepos(root)).toEqual(["services/billing", "services/mailer", "shop"]);
    expect(findChildRepos(root, 1)).toEqual(["shop"]);
  });

  test("the folder is found from itself and from below it, but inside a repository the repository wins", async () => {
    const root = await folder(["metator.repos.yml", "shop/.git/", "shop/src/a.ts", "notes/x.md"]);
    expect(findFolderRoot(root)).toBe(root);
    expect(findFolderRoot(join(root, "notes"))).toBe(root);
    expect(findFolderRoot(join(root, "shop/src"))).toBeUndefined();
    expect(findRepoRoot(join(root, "shop/src"))).toBe(join(root, "shop"));
  });

  test("without metator.repos.yml a folder is one that holds repositories; an empty one is not", async () => {
    const withRepos = await folder(["a/.git/", "b/.git/"]);
    expect(findFolderRoot(withRepos)).toBe(withRepos);
    const empty = await folder(["notes/x.md"]);
    expect(findFolderRoot(empty)).toBeUndefined();
  });
});

describe("runsRootOf", () => {
  test("a MetatorAI worktree keeps its run in the checkout it came from; any other root keeps its own", async () => {
    const repo = await mkdtemp(join(tmpdir(), "metator-runs-root-"));
    await mkdir(join(repo, ".git"));
    const wt = join(repo, ".metator/wt/20261029-x");
    await mkdir(join(wt, ".git"), { recursive: true });
    expect(runsRootOf(wt)).toBe(repo);
    expect(runsRootOf(`${wt}/`)).toBe(repo);
    expect(runsRootOf(repo)).toBe(repo);
    // Under .metator/wt of something that is no repository: the root keeps its own runs.
    const loose = join(tmpdir(), "metator-loose", ".metator/wt/y");
    expect(runsRootOf(loose)).toBe(loose);
    expect(runsRootOf(join(repo, "packages/a"))).toBe(join(repo, "packages/a"));
    await rm(repo, { recursive: true, force: true });
  });
});

/** git in `cwd`, with an identity and no signing: local only. */
function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A repository with one commit in `dir`. */
async function gitRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("worktrees in a folder (real git)", () => {
  test("a main repository with 2 worktrees in the folder is one repository with 2 worktrees", async () => {
    const root = await tempDir("metator-wt-folder-");
    const shop = await gitRepo(join(root, "shop"));
    await gitRepo(join(root, "billing"));
    git(shop, "worktree", "add", "-q", "-b", "fix-tax", "../shop-fix");
    git(shop, "worktree", "add", "-q", "--detach", "../shop-wip");
    expect(findChildRepos(root)).toEqual(["billing", "shop", "shop-fix", "shop-wip"]);
    expect(findFolderRepos(root)).toEqual([
      { path: "billing", worktrees: [] },
      { path: "shop", worktrees: [{ path: "shop-fix", branch: "fix-tax" }, { path: "shop-wip" }] },
    ]);
    expect(readCheckout(join(root, "shop-fix"))).toMatchObject({ kind: "worktree", main: shop });
    expect(readCheckout(shop)).toEqual({ kind: "repository", common: `${shop}/.git` });
  });

  test("worktrees whose main checkout is outside the folder are one repository: the first stands for it", async () => {
    const elsewhere = await tempDir("metator-wt-main-");
    const root = await tempDir("metator-wt-folder-");
    const shop = await gitRepo(join(elsewhere, "shop"));
    git(shop, "worktree", "add", "-q", "-b", "b", join(root, "b"));
    git(shop, "worktree", "add", "-q", "-b", "a", join(root, "a"));
    expect(findFolderRepos(root)).toEqual([{ path: "a", worktrees: [{ path: "b", branch: "b" }] }]);
    expect(readCheckout(join(root, "a"))).toMatchObject({ kind: "worktree", main: shop, branch: "a" });
  });

  test("a submodule is a repository of its own, not a worktree", async () => {
    const root = await tempDir("metator-wt-sub-");
    const lib = await gitRepo(join(root, "lib"));
    const app = await gitRepo(join(root, "app"));
    git(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    expect(readCheckout(join(app, "vendor/lib"))).toEqual({
      kind: "submodule",
      common: `${app}/.git/modules/vendor/lib`,
    });
    // Listed on its own (the walk never goes inside a repository), it stays apart from its superproject.
    expect(findFolderRepos(root)).toEqual([
      { path: "app", worktrees: [] },
      { path: "lib", worktrees: [] },
    ]);
  });

  test("worktrees of a bare repository have no main checkout and are one repository", async () => {
    const root = await tempDir("metator-wt-bare-");
    const seed = await gitRepo(join(root, "seed"));
    git(root, "clone", "-q", "--bare", seed, "shop.git");
    await rm(seed, { recursive: true, force: true });
    const bare = join(root, "shop.git");
    git(bare, "worktree", "add", "-q", "../shop-main", "main");
    git(bare, "worktree", "add", "-q", "-b", "fix", "../shop-fix");
    expect(readCheckout(join(root, "shop-main"))).toMatchObject({ kind: "worktree", main: undefined });
    expect(findFolderRepos(root)).toEqual([
      { path: "shop-fix", worktrees: [{ path: "shop-main", branch: "main" }] },
    ]);
  });

  test("MetatorAI's own worktrees under .metator/wt stay skipped", async () => {
    const root = await tempDir("metator-wt-own-");
    const shop = await gitRepo(join(root, "shop"));
    git(shop, "worktree", "add", "-q", "-b", "metator/run-1", ".metator/wt/run-1");
    expect(findChildRepos(root)).toEqual(["shop"]);
    expect(findFolderRepos(root)).toEqual([{ path: "shop", worktrees: [] }]);
    expect(runsRootOf(join(shop, ".metator/wt/run-1"))).toBe(shop);
  });
});
