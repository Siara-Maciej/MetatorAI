import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileStats } from "../src/bun-file-stats.ts";

const root = await mkdtemp(join(tmpdir(), "file-stats-"));
await mkdir(join(root, "runs/r1"), { recursive: true });
await writeFile(join(root, "runs/r1/plan.md"), "# Plan\n");
await symlink("/etc", join(root, "runs/r1/out"));
await symlink(join(root, "runs"), join(root, "linked-runs"));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("BunFileStats", () => {
  const stats = new BunFileStats(root);
  test("a file: its size, when it changed, where it really is; a directory says so; nothing is undefined", async () => {
    const real = await realpath(root);
    const file = await stats.stat("runs/r1/plan.md");
    expect([file?.directory, file?.size, file?.real]).toEqual([false, 7, join(real, "runs/r1/plan.md")]);
    expect(Number.isNaN(Date.parse(file?.modifiedAt ?? ""))).toBe(false);
    expect((await stats.stat("runs/r1"))?.directory).toBe(true);
    expect(await stats.stat("runs/r1/none.md")).toBeUndefined();
    expect((await stats.stat(join(root, "runs/r1/plan.md")))?.size).toBe(7);
  });
  test("a link is followed: its real path says where it leads", async () => {
    expect((await stats.stat("runs/r1/out"))?.real).toBe(await realpath("/etc"));
    expect((await stats.stat("linked-runs/r1/plan.md"))?.real).toBe(
      join(await realpath(root), "runs/r1/plan.md"),
    );
  });
});
