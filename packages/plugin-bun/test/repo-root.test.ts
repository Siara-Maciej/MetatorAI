import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChildRepos, findFolderRoot, findRepoRoot, runsRootOf } from "../src/repo-root.ts";

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
