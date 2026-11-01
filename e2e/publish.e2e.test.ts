import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
let bare: string;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("init");
  bare = await mkdtemp(join(tmpdir(), "metator-origin-"));
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
  await repo.git("remote", "add", "origin", bare);
  await repo.git("switch", "-qc", "metator/run-1");
});
afterAll(async () => {
  await repo.dispose();
  await rm(bare, { recursive: true, force: true });
});

describe("metator run published (real CLI)", () => {
  test("fails until the work is committed and origin holds the branch, then passes", async () => {
    await repo.write("src/b.ts", "export const b = 2;\n");
    const uncommitted = await metator(["run", "published"], repo.root);
    expect([uncommitted.code, (uncommitted.json.error as { message: string }).message]).toEqual([
      1,
      "not published: not committed: src/b.ts (git add -A, then git commit)",
    ]);
    await repo.commit("b");
    const unpushed = await metator(["run", "published"], repo.root);
    expect((unpushed.json.error as { message: string }).message).toBe(
      "not published: origin has no branch metator/run-1: git push -u origin metator/run-1",
    );
    await repo.git("push", "-q", "origin", "metator/run-1");
    const published = await metator(["run", "published"], repo.root);
    expect([published.code, (published.json.data as { branch: string }).branch]).toEqual([
      0,
      "metator/run-1",
    ]);
  }, 60_000);

  test("in a run's worktree it checks the worktree's branch, not the checkout's untracked setup", async () => {
    await repo.git("switch", "-q", "-c", "main-2");
    await repo.write("metator.config.yml", "kind: MetatorConfig\nschemaVersion: 5\n");
    await repo.git("worktree", "add", "-q", "-b", "metator/run-2", ".metator/wt/run-2", "HEAD");
    const wt = `${repo.root}/.metator/wt/run-2`;
    await Bun.write(`${wt}/src/c.ts`, "export const c = 3;\n");
    const notYet = await metator(["run", "published"], wt);
    expect((notYet.json.error as { message: string }).message).toBe(
      "not published: not committed: src/c.ts (git add -A, then git commit)",
    );
    const git = (...a: string[]) =>
      Bun.spawnSync(
        ["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a],
        {
          cwd: wt,
        },
      );
    git("add", "-A");
    git("commit", "-qm", "c");
    git("push", "-q", "origin", "metator/run-2");
    expect((await metator(["run", "published"], wt)).code).toBe(0);
  }, 60_000);
});
