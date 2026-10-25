import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@metator/plugin-bun";
import { GitVcs } from "../src/git-vcs.ts";

const runner = new BunProcessRunner();
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function sh(cwd: string, ...argv: string[]): Promise<void> {
  const r = await runner.run({
    argv: [
      "git",
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      ...argv,
    ],
    cwd,
  });
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-git-"));
  dirs.push(dir);
  await sh(dir, "init", "-q", "-b", "main");
  return dir;
}

/** main: a.ts, b.ts, ignored rule. feature: +e.ts committed; then working-tree changes. */
async function scenario(): Promise<string> {
  const dir = await repo();
  await writeFile(join(dir, "a.ts"), "a");
  await writeFile(join(dir, "b.ts"), "b");
  await writeFile(join(dir, ".gitignore"), "dist/\n");
  await sh(dir, "add", ".");
  await sh(dir, "commit", "-q", "-m", "init");
  await sh(dir, "checkout", "-q", "-b", "feature");
  await writeFile(join(dir, "e.ts"), "e");
  await sh(dir, "add", "e.ts");
  await sh(dir, "commit", "-q", "-m", "feature work");
  await writeFile(join(dir, "a.ts"), "a changed"); // unstaged
  await unlink(join(dir, "b.ts")); // deleted
  await writeFile(join(dir, "d.ts"), "d");
  await sh(dir, "add", "d.ts"); // staged, new
  await writeFile(join(dir, "c ż.ts"), "c"); // untracked, space + unicode
  await Bun.write(join(dir, "dist/out.js"), "ignored");
  return dir;
}

describe("GitVcs (real git)", () => {
  test("against a branch: committed, staged, unstaged, deleted and untracked changes", async () => {
    const dir = await scenario();
    const files = (await new GitVcs(dir).changedFiles("main"))._unsafeUnwrap();
    expect(files).toEqual(["a.ts", "b.ts", "c ż.ts", "d.ts", "e.ts"]);
  });

  test("against HEAD: only the working tree, not earlier branch commits", async () => {
    const dir = await scenario();
    const files = (await new GitVcs(dir).changedFiles("HEAD"))._unsafeUnwrap();
    expect(files).toEqual(["a.ts", "b.ts", "c ż.ts", "d.ts"]);
  });

  test("ignored files never show up", async () => {
    const dir = await scenario();
    const files = (await new GitVcs(dir).changedFiles("main"))._unsafeUnwrap();
    expect(files.some((f) => f.startsWith("dist/"))).toBe(false);
  });

  test("clean tree has no changes", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.ts"), "a");
    await sh(dir, "add", ".");
    await sh(dir, "commit", "-q", "-m", "init");
    expect((await new GitVcs(dir).changedFiles("HEAD"))._unsafeUnwrap()).toEqual([]);
  });

  test("repository without commits: every non-ignored file counts as changed", async () => {
    const dir = await repo();
    await writeFile(join(dir, "x.ts"), "x");
    await writeFile(join(dir, "y.ts"), "y");
    await sh(dir, "add", "x.ts");
    expect((await new GitVcs(dir).changedFiles("HEAD"))._unsafeUnwrap()).toEqual(["x.ts", "y.ts"]);
  });

  test("unknown base ref is a usage error with a hint", async () => {
    const dir = await scenario();
    const error = (await new GitVcs(dir).changedFiles("no-such-branch"))._unsafeUnwrapErr();
    expect(error.code).toBe("USAGE");
    expect(error.message).toContain("no-such-branch");
  });

  test("outside a git repository: NOT_FOUND", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-nogit-"));
    dirs.push(dir);
    const error = (await new GitVcs(dir).changedFiles("HEAD"))._unsafeUnwrapErr();
    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("GitVcs.listFiles (real git)", () => {
  test("tracked + untracked, minus ignored and minus deleted files", async () => {
    const dir = await scenario();
    const files = (await new GitVcs(dir).listFiles())._unsafeUnwrap();
    expect(files).toEqual([".gitignore", "a.ts", "c ż.ts", "d.ts", "e.ts"]);
  });

  test("outside a git repository: NOT_FOUND (callers fall back to the file system)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-nogit-ls-"));
    dirs.push(dir);
    expect((await new GitVcs(dir).listFiles())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

describe("GitVcs edge cases", () => {
  test("a directory that does not exist is NOT_FOUND, not a crash", async () => {
    const vcs = new GitVcs(join(tmpdir(), "metator-missing-dir-xyz"));
    expect((await vcs.changedFiles("HEAD"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await vcs.listFiles())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("a renamed file counts under both names", async () => {
    const dir = await repo();
    await writeFile(join(dir, "old.ts"), "same content");
    await sh(dir, "add", ".");
    await sh(dir, "commit", "-q", "-m", "init");
    await sh(dir, "mv", "old.ts", "new.ts");
    expect((await new GitVcs(dir).changedFiles("HEAD"))._unsafeUnwrap()).toEqual(["new.ts", "old.ts"]);
  });

  test("works from a subdirectory of the checkout; paths stay repo-relative", async () => {
    const dir = await scenario();
    await Bun.write(join(dir, "sub/keep.txt"), "x");
    const files = (await new GitVcs(dir).changedFiles("main"))._unsafeUnwrap();
    expect(files).toContain("sub/keep.txt");
  });
});

describe("GitVcs unrelated history", () => {
  test("a base without a common ancestor is a usage error, not an empty diff", async () => {
    const dir = await scenario();
    await sh(dir, "checkout", "-q", "--orphan", "island");
    await sh(dir, "commit", "-q", "--allow-empty", "-m", "island");
    await sh(dir, "checkout", "-q", "-f", "feature");
    const error = (await new GitVcs(dir).changedFiles("island"))._unsafeUnwrapErr();
    expect(error.code).toBe("USAGE");
  });
});
