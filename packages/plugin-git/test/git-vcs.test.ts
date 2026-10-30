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
  return shEnv(cwd, {}, ...argv);
}

async function shEnv(cwd: string, env: Record<string, string>, ...argv: string[]): Promise<void> {
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
    env,
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

  test("its own state is never a change, even before it is gitignored", async () => {
    const dir = await scenario();
    await Bun.write(join(dir, ".metator/index/imports.json"), "{}");
    expect((await new GitVcs(dir).changedFiles("main"))._unsafeUnwrap()).toContain(
      ".metator/index/imports.json",
    );
    expect((await new GitVcs(dir, [".metator/"]).changedFiles("main"))._unsafeUnwrap()).toEqual([
      "a.ts",
      "b.ts",
      "c ż.ts",
      "d.ts",
      "e.ts",
    ]);
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

describe("GitVcs path parsing", () => {
  test("a tracked file with spaces, unicode and an arrow-like name is reported verbatim", async () => {
    const dir = await repo();
    const names = ["zażółć gęślą.ts", "a => b.ts", "dir with space/x.ts"];
    for (const n of names) await Bun.write(join(dir, n), "v1");
    await sh(dir, "add", ".");
    await sh(dir, "commit", "-q", "-m", "init");
    for (const n of names) await Bun.write(join(dir, n), "v2");
    expect((await new GitVcs(dir).changedFiles("HEAD"))._unsafeUnwrap()).toEqual([...names].sort());
  });
});

describe("GitVcs.remoteUrl (real git)", () => {
  test("origin wins; no remote is undefined; outside git is NOT_FOUND", async () => {
    const dir = await repo();
    expect((await new GitVcs(dir).remoteUrl())._unsafeUnwrap()).toBeUndefined();
    await sh(dir, "remote", "add", "upstream", "https://example.com/up.git");
    await sh(dir, "remote", "add", "origin", "git@github.com:acme/shop.git");
    expect((await new GitVcs(dir).remoteUrl())._unsafeUnwrap()).toBe("git@github.com:acme/shop.git");
    const none = await mkdtemp(join(tmpdir(), "metator-nogit-remote-"));
    dirs.push(none);
    expect((await new GitVcs(none).remoteUrl())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

describe("GitVcs.readAt (real git)", () => {
  test("reads a file at the merge base: changed, deleted, branch-only and missing files", async () => {
    const dir = await scenario();
    await sh(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "a.ts"), "a on main later"); // after the merge base: not seen
    await sh(dir, "commit", "-q", "-am", "main moves on");
    await sh(dir, "checkout", "-q", "feature");
    const vcs = new GitVcs(dir);
    expect((await vcs.readAt("main", "a.ts"))._unsafeUnwrap()).toBe("a");
    expect((await vcs.readAt("main", "b.ts"))._unsafeUnwrap()).toBe("b");
    expect((await vcs.readAt("main", "e.ts"))._unsafeUnwrap()).toBeUndefined();
    expect((await vcs.readAt("HEAD", "e.ts"))._unsafeUnwrap()).toBe("e");
    expect((await vcs.readAt("main", "nope/x.ts"))._unsafeUnwrap()).toBeUndefined();
  });

  test("an unknown base is a usage error; a repo without commits has no history", async () => {
    const dir = await scenario();
    expect((await new GitVcs(dir).readAt("no-such-ref", "a.ts"))._unsafeUnwrapErr().code).toBe("USAGE");
    const empty = await repo();
    expect((await new GitVcs(empty).readAt("HEAD", "a.ts"))._unsafeUnwrap()).toBeUndefined();
    expect((await new GitVcs(join(empty, "missing")).readAt("HEAD", "a.ts"))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });
});

describe("GitVcs.addedLines (real git)", () => {
  test("lines added since the merge base: committed, unstaged and whole untracked files", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.ts"), "1\n2\n3\n");
    await sh(dir, "add", ".");
    await sh(dir, "commit", "-q", "-m", "init");
    await sh(dir, "checkout", "-q", "-b", "feature");
    await writeFile(join(dir, "a.ts"), "1\nnew\n2\n3\n");
    await sh(dir, "commit", "-q", "-am", "insert");
    await writeFile(join(dir, "a.ts"), "1\nnew\n2\n3\nend\n"); // unstaged
    await writeFile(join(dir, "b.ts"), "x\ny\n"); // untracked
    const added = (await new GitVcs(dir).addedLines("main"))._unsafeUnwrap();
    expect([...added]).toEqual([
      ["a.ts", [2, 5]],
      ["b.ts", [1, 2]],
    ]);
  });

  test("deleted files add nothing; an unknown base is a usage error", async () => {
    const dir = await scenario();
    const added = (await new GitVcs(dir).addedLines("main"))._unsafeUnwrap();
    expect(added.has("b.ts")).toBe(false);
    expect((await new GitVcs(dir).addedLines("nope"))._unsafeUnwrapErr().code).toBe("USAGE");
  });
});

describe("GitVcs.lastChanged (real git)", () => {
  test("each committed file with the date of the last commit that touched it", async () => {
    const dir = await repo();
    const at = (date: string) => ({ GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
    await writeFile(join(dir, "a.md"), "a\n");
    await writeFile(join(dir, "b.md"), "b\n");
    await sh(dir, "add", ".");
    await shEnv(dir, at("2026-01-01T10:00:00Z"), "commit", "-q", "-m", "init");
    await writeFile(join(dir, "b.md"), "b2\n");
    await shEnv(dir, at("2026-02-01T10:00:00Z"), "commit", "-q", "-am", "b");
    await writeFile(join(dir, "c.md"), "untracked\n");
    const changed = (await new GitVcs(dir).lastChanged())._unsafeUnwrap();
    expect([...changed].map(([f, d]) => [f, d.slice(0, 10)])).toEqual([
      ["b.md", "2026-02-01"],
      ["a.md", "2026-01-01"],
    ]);
  });

  test("no commits yet: nothing; not a repository: an error value", async () => {
    const empty = await repo();
    expect((await new GitVcs(empty).lastChanged())._unsafeUnwrap().size).toBe(0);
    expect((await new GitVcs(join(empty, "missing")).lastChanged())._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });
});

describe("GitVcs.commits (real git)", () => {
  test("the files of the last commits, newest first, at most the limit", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.md"), "a\n");
    await writeFile(join(dir, "b.md"), "b\n");
    await sh(dir, "add", ".");
    await sh(dir, "commit", "-q", "-m", "init");
    await writeFile(join(dir, "b.md"), "b2\n");
    await sh(dir, "commit", "-q", "-am", "b");
    await sh(dir, "commit", "-q", "--allow-empty", "-m", "empty");
    expect((await new GitVcs(dir).commits(10))._unsafeUnwrap()).toEqual([[], ["b.md"], ["a.md", "b.md"]]);
    expect((await new GitVcs(dir).commits(1))._unsafeUnwrap()).toEqual([[]]);
  });

  test("no commits yet: none; not a repository: an error value", async () => {
    const empty = await repo();
    expect((await new GitVcs(empty).commits(5))._unsafeUnwrap()).toEqual([]);
    expect((await new GitVcs(join(empty, "missing")).commits(5))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

describe("GitVcs.branch (real git)", () => {
  test("the branch against its base: merge base, commits after it with authors, uncommitted work", async () => {
    const dir = await scenario();
    const b = (await new GitVcs(dir).branch("main"))._unsafeUnwrap();
    expect([b.branch, b.uncommitted, b.commits.map((c) => [c.author, c.email, c.subject])]).toEqual([
      "feature",
      true,
      [["Test", "t@example.com", "feature work"]],
    ]);
    expect(b.head).toMatch(/^[0-9a-f]{40}$/);
    expect(b.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(b.mergeBase).not.toBe(b.head);
    expect(b.commits[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Against HEAD: nothing after it.
    expect((await new GitVcs(dir).branch("HEAD"))._unsafeUnwrap().commits).toEqual([]);
    expect((await new GitVcs(dir).branch("nope"))._unsafeUnwrapErr().code).toBe("USAGE");
  });

  test("a repository without commits has no head; a clean tree has nothing uncommitted", async () => {
    const empty = await repo();
    expect((await new GitVcs(empty).branch("main"))._unsafeUnwrap()).toEqual({
      branch: "main",
      head: null,
      mergeBase: null,
      commits: [],
      uncommitted: false,
    });
    const dir = await repo();
    await writeFile(join(dir, "a.ts"), "a");
    await sh(dir, "add", ".");
    await sh(dir, "commit", "-q", "-m", "init");
    expect((await new GitVcs(dir).branch("HEAD"))._unsafeUnwrap().uncommitted).toBe(false);
  });
});
