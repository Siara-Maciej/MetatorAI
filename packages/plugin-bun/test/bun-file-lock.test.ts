import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLockDocument, ok, serializeJsonDocument } from "@metator/core";
import { fileLockContract } from "@metator/testing";
import { BunFileLock } from "../src/bun-file-lock.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-lock-"));
  dirs.push(dir);
  return dir;
};

fileLockContract("BunFileLock", async () => new BunFileLock(await scratch()));

const lockOf = (pid: number) =>
  serializeJsonDocument(FileLockDocument.stamp({ pid, token: "theirs", at: "2026-11-12T10:00:00.000Z" }));

/** A pid no process has: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("BunFileLock on the file system", () => {
  test("the lock is a versioned file next to the file it guards, gone after the work", async () => {
    const root = await scratch();
    const seen = await new BunFileLock(root).hold(".metator/worktrees.json", async () =>
      ok(await Bun.file(join(root, ".metator/worktrees.json.lock")).json()),
    );
    expect(seen._unsafeUnwrap()).toMatchObject({ kind: "FileLock", schemaVersion: 1, pid: process.pid });
    expect(await readdir(join(root, ".metator"))).toEqual([]);
  });

  test("a lock whose process is gone is taken over", async () => {
    const root = await scratch();
    await mkdir(join(root, "s"), { recursive: true });
    await writeFile(join(root, "s/a.json.lock"), lockOf(await deadPid()));
    const r = await new BunFileLock(root, { waitMs: 500 }).hold("s/a.json", async () => ok("mine"));
    expect(r._unsafeUnwrap()).toBe("mine");
    expect(await readdir(join(root, "s"))).toEqual([]);
  });

  test("a lock a live process holds is waited for, then refused with its pid and the file to delete", async () => {
    const root = await scratch();
    await mkdir(join(root, "s"), { recursive: true });
    // This test's own process, under another token: alive, and not this holder.
    await writeFile(join(root, "s/a.json.lock"), lockOf(process.pid));
    let ran = false;
    const r = await new BunFileLock(root, { waitMs: 150 }).hold("s/a.json", async () => {
      ran = true;
      return ok(undefined);
    });
    const e = r._unsafeUnwrapErr();
    expect(ran).toBe(false);
    expect(e.code).toBe("COMMAND_FAILED");
    expect(e.message).toBe(
      `${join(root, "s/a.json")} is locked by process ${process.pid} since 2026-11-12T10:00:00.000Z`,
    );
    expect(e.hint).toContain(`delete ${join(root, "s/a.json.lock")}`);
    // The lock was not ours: it is still there.
    expect(await readdir(join(root, "s"))).toEqual(["a.json.lock"]);
  });

  test("a lock nobody refreshed for staleMs holds nothing, even when its pid lives", async () => {
    const root = await scratch();
    await mkdir(join(root, "s"), { recursive: true });
    await writeFile(join(root, "s/a.json.lock"), lockOf(process.pid));
    await Bun.sleep(60);
    const r = await new BunFileLock(root, { waitMs: 500, staleMs: 30 }).hold("s/a.json", async () => ok(1));
    expect(r._unsafeUnwrap()).toBe(1);
  });

  test("work longer than staleMs keeps its lock: the holder refreshes it, a second lock object waits", async () => {
    const root = await scratch();
    const order: string[] = [];
    const slow = new BunFileLock(root, { staleMs: 1000 }).hold("s/a.json", async () => {
      order.push("slow in");
      await Bun.sleep(2500);
      order.push("slow out");
      return ok(undefined);
    });
    await Bun.sleep(20);
    // Another lock object, as another process would be: it only sees the lock file.
    await new BunFileLock(root, { staleMs: 1000 }).hold("s/a.json", async () => {
      order.push("second");
      return ok(undefined);
    });
    await slow;
    expect(order).toEqual(["slow in", "slow out", "second"]);
  }, 20_000);

  test("a path outside the repository is refused", async () => {
    const r = await new BunFileLock(await scratch()).hold("../x.json", async () => ok(1));
    expect(r._unsafeUnwrapErr().code).toBe("USAGE");
  });

  test("several real processes: every read-modify-write under the lock survives", async () => {
    const root = await scratch();
    const script = join(import.meta.dir, "fixtures/lock-bump.ts");
    const procs = Array.from({ length: 5 }, () =>
      Bun.spawn(["bun", script, root], { cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" }),
    );
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0]);
    expect(await Bun.file(join(root, "counter.txt")).text()).toBe("75");
  }, 30_000);
});
