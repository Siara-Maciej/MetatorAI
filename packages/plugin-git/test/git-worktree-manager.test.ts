import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeManagerContract } from "@metator/testing";
import { GitWorktreeManager } from "../src/git-worktree-manager.ts";

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

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-wt-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

worktreeManagerContract("GitWorktreeManager", async () => {
  const dir = await repo();
  return {
    manager: new GitWorktreeManager(dir),
    makeDirty: (path) => writeFile(join(dir, path, "a.txt"), "changed\n"),
  };
});

test("a worktree deleted by hand is clean and removable (git's record is pruned)", async () => {
  const dir = await repo();
  const manager = new GitWorktreeManager(dir);
  await manager.add(".metator/wt/a", "metator/a", "HEAD");
  await rm(join(dir, ".metator/wt/a"), { recursive: true, force: true });
  expect((await manager.isDirty(".metator/wt/a"))._unsafeUnwrap()).toBe(false);
  expect((await manager.remove(".metator/wt/a", false)).isOk()).toBe(true);
  const list = Bun.spawnSync(["git", "worktree", "list"], { cwd: dir }).stdout.toString();
  expect(list).not.toContain(".metator/wt/a");
});

test("an unknown base ref is an error value with a hint", async () => {
  const r = await new GitWorktreeManager(await repo()).add(".metator/wt/a", "metator/a", "no-such-ref");
  expect(r._unsafeUnwrapErr().hint).toContain("base ref");
});

test("switchBranch starts the new branch at this checkout's HEAD and deletes the pool branch", async () => {
  const dir = await repo();
  const manager = new GitWorktreeManager(dir);
  await manager.add(".metator/wt/pool-1", "metator/pool-1", "HEAD");
  // The checkout moves on after the pool worktree was made.
  await writeFile(join(dir, "later.txt"), "later\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "later");
  expect((await manager.switchBranch(".metator/wt/pool-1", "metator/run-1", "HEAD")).isOk()).toBe(true);
  const out = (cwd: string, ...argv: string[]) =>
    Bun.spawnSync(["git", ...argv], { cwd })
      .stdout.toString()
      .trim();
  const wt = join(dir, ".metator/wt/pool-1");
  expect(out(wt, "branch", "--show-current")).toBe("metator/run-1");
  expect(out(wt, "rev-parse", "HEAD")).toBe(out(dir, "rev-parse", "HEAD"));
  expect(out(dir, "branch", "--list", "metator/pool-1")).toBe("");
});

test("shared directories of the checkout are reached from the worktree through a link", async () => {
  const dir = await repo();
  const m = new GitWorktreeManager(dir);
  (await m.add(".metator/wt/r1", "metator/r1", "HEAD", [".metator/runs"]))._unsafeUnwrap();
  await writeFile(join(dir, ".metator/runs/state.json"), "{}");
  expect(await Bun.file(join(dir, ".metator/wt/r1/.metator/runs/state.json")).text()).toBe("{}");
  // The link is not work in the worktree: it stays clean.
  expect((await m.isDirty(".metator/wt/r1"))._unsafeUnwrap()).toBe(false);
  // A second worktree does not write the exclude line twice.
  (await m.add(".metator/wt/r2", "metator/r2", "HEAD", [".metator/runs"]))._unsafeUnwrap();
  const exclude = await Bun.file(join(dir, ".git/info/exclude")).text();
  expect(exclude.split("\n").filter((l) => l === "/.metator/runs")).toHaveLength(1);
});
