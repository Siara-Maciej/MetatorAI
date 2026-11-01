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
});
