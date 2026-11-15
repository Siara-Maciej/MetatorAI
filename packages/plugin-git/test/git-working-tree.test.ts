import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@metator/plugin-bun";
import { GitWorkingTree } from "../src/git-working-tree.ts";

const runner = new BunProcessRunner();
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, ...argv: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...argv],
    { cwd },
  );
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr.toString()}`);
}

/** A repository on `main` with one commit: a.ts, b.ts and an ignore rule for dist/. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-tree-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.ts"), "a\n");
  await writeFile(join(dir, "b.ts"), "b\n");
  await writeFile(join(dir, ".gitignore"), "dist/\n.metator/wt/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const tree = (root: string) => new GitWorkingTree(runner, root, [".metator/"]);

describe("GitWorkingTree.worktreeChanges (real git)", () => {
  test("what a worktree committed, changed, deleted and added since it branched off; ignored files never", async () => {
    const root = await repo();
    git(root, "worktree", "add", "-q", "-b", "metator/x", ".metator/wt/x", "HEAD");
    const wt = join(root, ".metator/wt/x");
    await writeFile(join(wt, "c.ts"), "c\n");
    git(wt, "add", "c.ts");
    git(wt, "commit", "-qm", "work");
    await writeFile(join(wt, "a.ts"), "a changed\n"); // unstaged
    await unlink(join(wt, "b.ts")); // deleted
    await writeFile(join(wt, "new file.ts"), "n\n"); // untracked
    await mkdir(join(wt, "dist"));
    await writeFile(join(wt, "dist/out.js"), "ignored\n");
    expect((await tree(root).worktreeChanges(".metator/wt/x"))._unsafeUnwrap()).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "new file.ts",
    ]);
  });

  test("a worktree that changed nothing has no changes, also after the main checkout moved on", async () => {
    const root = await repo();
    git(root, "worktree", "add", "-q", "-b", "metator/y", ".metator/wt/y", "HEAD");
    expect((await tree(root).worktreeChanges(".metator/wt/y"))._unsafeUnwrap()).toEqual([]);
    await writeFile(join(root, "main-only.ts"), "m\n");
    git(root, "add", "main-only.ts");
    git(root, "commit", "-qm", "main moves on");
    // Measured from where the branch forked, so what main did since is not the worktree's change.
    expect((await tree(root).worktreeChanges(".metator/wt/y"))._unsafeUnwrap()).toEqual([]);
  });

  test("a path that is not a worktree is an error value naming the directory", async () => {
    const root = await repo();
    const error = (await tree(root).worktreeChanges(".metator/wt/none"))._unsafeUnwrapErr();
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toStartWith(`git merge-base in ${join(root, ".metator/wt/none")}:`);
  });
});

describe("GitWorkingTree.modifiedTracked (real git)", () => {
  test("tracked files with staged or unstaged changes; untracked files and its own state are not", async () => {
    const root = await repo();
    expect(await tree(root).modifiedTracked()).toEqual([]);
    await writeFile(join(root, "a.ts"), "a changed\n");
    await writeFile(join(root, "b.ts"), "b changed\n");
    git(root, "add", "b.ts");
    await writeFile(join(root, "untracked.ts"), "u\n");
    await mkdir(join(root, ".metator/runs"), { recursive: true });
    await writeFile(join(root, ".metator/runs/state.json"), "{}\n");
    git(root, "add", "-f", ".metator/runs/state.json");
    expect(await tree(root).modifiedTracked()).toEqual(["a.ts", "b.ts"]);
  });

  test("a file name with a space and a letter outside ASCII is reported verbatim", async () => {
    const root = await repo();
    await writeFile(join(root, "c ż.ts"), "c\n");
    git(root, "add", "c ż.ts");
    git(root, "commit", "-qm", "c");
    await writeFile(join(root, "c ż.ts"), "c changed\n");
    expect(await tree(root).modifiedTracked()).toEqual(["c ż.ts"]);
  });

  test("a renamed file is the change under its new name only", async () => {
    const root = await repo();
    git(root, "mv", "a.ts", "renamed.ts");
    expect(await tree(root).modifiedTracked()).toEqual(["renamed.ts"]);
  });

  test("its own state is whatever prefixes it is given", async () => {
    const root = await repo();
    await writeFile(join(root, "a.ts"), "a changed\n");
    expect(await new GitWorkingTree(runner, root, ["a."]).modifiedTracked()).toEqual([]);
    expect(await new GitWorkingTree(runner, root).modifiedTracked()).toEqual(["a.ts"]);
  });

  test("where git cannot say (not a repository): undefined, not an empty list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-tree-none-"));
    dirs.push(dir);
    expect(await tree(dir).modifiedTracked()).toBeUndefined();
  });
});

describe("GitWorkingTree.detachedHead (real git)", () => {
  test("on a branch: false; on a commit: true; not a repository: undefined", async () => {
    const root = await repo();
    expect(await tree(root).detachedHead()).toBe(false);
    git(root, "checkout", "-q", "--detach", "HEAD");
    expect(await tree(root).detachedHead()).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "metator-tree-none-"));
    dirs.push(dir);
    expect(await tree(dir).detachedHead()).toBeUndefined();
  });

  test("a repository without commits is on its branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-tree-empty-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    expect(await tree(dir).detachedHead()).toBe(false);
  });
});
