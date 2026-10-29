import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepositoryCloner } from "../src/git-repository-cloner.ts";

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
  return r.stdout.toString().trim();
}

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-clone-"));
  dirs.push(dir);
  return dir;
}

/** A repository with two commits on main and an annotated tag v1 on the first. */
async function platform(): Promise<{ dir: string; first: string; second: string }> {
  const dir = await temp();
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "m.yml"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "one");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", "-a", "v1", "-m", "v1");
  await writeFile(join(dir, "m.yml"), "two\n");
  git(dir, "commit", "-qam", "two");
  return { dir, first, second: git(dir, "rev-parse", "HEAD") };
}

test("a ref resolves to its commit: a branch, the peeled commit of an annotated tag, a sha as is", async () => {
  const { dir, first, second } = await platform();
  const cloner = new GitRepositoryCloner();
  expect((await cloner.resolve(dir, "main"))._unsafeUnwrap()).toBe(second);
  expect((await cloner.resolve(dir))._unsafeUnwrap()).toBe(second);
  expect((await cloner.resolve(dir, "v1"))._unsafeUnwrap()).toBe(first);
  expect((await cloner.resolve(dir, "f".repeat(40)))._unsafeUnwrap()).toBe("f".repeat(40));
  expect((await cloner.resolve(dir, "nope"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  const missing = (await cloner.resolve(join(dir, "absent"), "main"))._unsafeUnwrapErr();
  expect([missing.code, missing.message.startsWith("Cannot reach")]).toEqual(["COMMAND_FAILED", true]);
});

test("a checkout holds exactly the pinned commit and is reused once it exists", async () => {
  const { dir, first } = await platform();
  const cache = await temp();
  const cloner = new GitRepositoryCloner();
  const target = join(cache, "nested", "p@1");
  expect((await cloner.checkout(dir, first, target)).isOk()).toBe(true);
  expect(await readFile(join(target, "m.yml"), "utf8")).toBe("one\n");
  await writeFile(join(target, "m.yml"), "kept\n");
  expect((await cloner.checkout(dir, first, target)).isOk()).toBe(true);
  expect(await readFile(join(target, "m.yml"), "utf8")).toBe("kept\n");
  const bad = (await cloner.checkout(dir, "0".repeat(40), join(cache, "bad")))._unsafeUnwrapErr();
  expect(bad.message).toStartWith(`Cannot clone ${dir} at 000000000000`);
  // A failed checkout leaves nothing behind that a later run would take for a good clone.
  expect([existsSync(join(cache, "bad")), (await readdir(cache)).sort()]).toEqual([false, ["nested"]]);
});
