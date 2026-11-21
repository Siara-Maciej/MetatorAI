import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@metator/plugin-bun";
import { GitWorkingPatches } from "../src/git-working-patches.ts";

const runner = new BunProcessRunner();
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, ...argv: string[]): string {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...argv],
    { cwd },
  );
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** A repository on `main` with one commit: a.ts (three lines), b.ts, and dist/ ignored. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-patches-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.ts"), "one\ntwo\nthree\n");
  await writeFile(join(dir, "b.ts"), "b\n");
  await writeFile(join(dir, ".gitignore"), "dist/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const patches = (root: string) => new GitWorkingPatches(runner, root, [".metator/"]);
const text = (root: string, file: string) => readFile(join(root, file), "utf8");

describe("GitWorkingPatches (real git)", () => {
  test("a snapshot touches nothing; the patch between two is exactly what changed in between, new and deleted files too", async () => {
    const root = await repo();
    // Work in progress before the edit: staged and unstaged, both stay as they are.
    await writeFile(join(root, "b.ts"), "b, in progress\n");
    git(root, "add", "b.ts");
    await writeFile(join(root, "wip.ts"), "wip\n");
    const before = git(root, "status", "--porcelain");
    const p = patches(root);
    const from = (await p.snapshot())._unsafeUnwrap();
    expect(git(root, "status", "--porcelain")).toBe(before);
    await writeFile(join(root, "a.ts"), "one\nconsole.log('debug');\ntwo\nthree\n");
    await writeFile(join(root, "debug.ts"), "export const DEBUG = true;\n");
    await unlink(join(root, "wip.ts"));
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/out.js"), "ignored\n");
    await mkdir(join(root, ".metator/scratch"), { recursive: true });
    await writeFile(join(root, ".metator/scratch/open.json"), "{}\n");
    const to = (await p.snapshot())._unsafeUnwrap();
    const change = (await p.between(from, to))._unsafeUnwrap();
    expect(change.files).toEqual(["a.ts", "debug.ts", "wip.ts"]);
    expect(change.patch).toContain("+console.log('debug');");
    expect(change.patch).not.toContain("in progress");
    // Nothing changed: no files, no patch.
    expect((await p.between(to, to))._unsafeUnwrap()).toEqual({ files: [], patch: "" });
    // The same when MetatorAI's state is ignored by the repository, as it is after setup.
    await writeFile(join(root, ".gitignore"), "dist/\n.metator/\n");
    const ignoring = (await p.snapshot())._unsafeUnwrap();
    expect((await p.between(to, ignoring))._unsafeUnwrap().files).toEqual([".gitignore"]);
    expect(git(root, "stash", "list")).toBe("");
  });

  test("holding: which files still hold the change, in the tree and in the index", async () => {
    const root = await repo();
    const p = patches(root);
    const from = (await p.snapshot())._unsafeUnwrap();
    await writeFile(join(root, "a.ts"), "one\nconsole.log('debug');\ntwo\nthree\n");
    await writeFile(join(root, "b.ts"), "b\nconsole.log('b');\n");
    await writeFile(join(root, "debug.log"), "trace\n");
    const { patch } = (await p.between(from, (await p.snapshot())._unsafeUnwrap()))._unsafeUnwrap();
    expect((await p.holding(patch, "tree"))._unsafeUnwrap()).toEqual(["a.ts", "b.ts", "debug.log"]);
    expect((await p.holding(patch, "index"))._unsafeUnwrap()).toEqual([]);
    // What `commit -a` would take: tracked files only, not the new file nobody added.
    expect((await p.holding(patch, "tracked"))._unsafeUnwrap()).toEqual(["a.ts", "b.ts"]);
    git(root, "add", "b.ts");
    expect((await p.holding(patch, "index"))._unsafeUnwrap()).toEqual(["b.ts"]);
    // The person took one out by hand.
    await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n");
    expect((await p.holding(patch, "tree"))._unsafeUnwrap()).toEqual(["b.ts", "debug.log"]);
  });

  test("revert takes the change out of the tree and out of the index, and keeps other work in the same file", async () => {
    const root = await repo();
    const p = patches(root);
    const from = (await p.snapshot())._unsafeUnwrap();
    await writeFile(join(root, "a.ts"), "one\nconsole.log('debug');\ntwo\nthree\n");
    await writeFile(join(root, "debug.ts"), "export const DEBUG = true;\n");
    const { patch } = (await p.between(from, (await p.snapshot())._unsafeUnwrap()))._unsafeUnwrap();
    // Real work after the edit, further down the same file; and the debug file is staged.
    await writeFile(join(root, "a.ts"), "one\nconsole.log('debug');\ntwo\nthree\nfour\n");
    git(root, "add", "debug.ts");
    (await p.revert(patch))._unsafeUnwrap();
    expect(await text(root, "a.ts")).toBe("one\ntwo\nthree\nfour\n");
    expect(await Bun.file(join(root, "debug.ts")).exists()).toBe(false);
    expect(git(root, "status", "--porcelain").trim()).toBe("M a.ts");
  });

  test("a patch that no longer applies changes nothing and says which file changed since", async () => {
    const root = await repo();
    const p = patches(root);
    const from = (await p.snapshot())._unsafeUnwrap();
    await writeFile(join(root, "a.ts"), "one\nconsole.log('debug');\ntwo\nthree\n");
    await writeFile(join(root, "b.ts"), "b\nconsole.log('b');\n");
    const { patch } = (await p.between(from, (await p.snapshot())._unsafeUnwrap()))._unsafeUnwrap();
    // The debug line itself was rewritten: the patch cannot be taken out as recorded.
    await writeFile(join(root, "a.ts"), "one\nconsole.warn('changed');\ntwo\nthree\n");
    const failed = (await p.revert(patch))._unsafeUnwrapErr();
    expect([failed.code, failed.message]).toEqual([
      "COMMAND_FAILED",
      "the patch no longer applies (a.ts changed since)",
    ]);
    // Nothing half done: b.ts still holds its debug line.
    expect(await text(root, "b.ts")).toBe("b\nconsole.log('b');\n");
    expect(await text(root, "a.ts")).toBe("one\nconsole.warn('changed');\ntwo\nthree\n");
  });

  test("a repository with no commit yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-patches-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.ts"), "a\n");
    const p = patches(dir);
    const from = (await p.snapshot())._unsafeUnwrap();
    await writeFile(join(dir, "a.ts"), "a\ndebug\n");
    const change = (await p.between(from, (await p.snapshot())._unsafeUnwrap()))._unsafeUnwrap();
    expect(change.files).toEqual(["a.ts"]);
    (await p.revert(change.patch))._unsafeUnwrap();
    expect(await text(dir, "a.ts")).toBe("a\n");
  });
});
