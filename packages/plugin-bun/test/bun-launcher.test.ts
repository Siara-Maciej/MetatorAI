import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunLauncher } from "../src/bun-launcher.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("BunLauncher", () => {
  test("attached returns the exit code; detached returns at once and the program still runs", async () => {
    dir = await mkdtemp(join(tmpdir(), "launcher-"));
    const launcher = new BunLauncher();
    expect((await launcher.attached(["sh", "-c", "exit 3"], dir))._unsafeUnwrap()).toBe(3);
    expect((await launcher.detached(["sh", "-c", "sleep 0.2; echo hi > out.txt"], dir)).isOk()).toBe(true);
    expect(await Bun.file(join(dir, "out.txt")).exists()).toBe(false);
    for (let i = 0; i < 50 && !(await Bun.file(join(dir, "out.txt")).exists()); i++) await Bun.sleep(50);
    expect((await Bun.file(join(dir, "out.txt")).text()).trim()).toBe("hi");
  });

  test("available keeps only the commands on PATH, in order; a missing program is an error value", async () => {
    const launcher = new BunLauncher();
    expect(launcher.available(["no-such-editor-xyz", "sh", "git"])).toEqual(["sh", "git"]);
    const r = await launcher.attached(["no-such-editor-xyz"], tmpdir());
    expect(r._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
  });
});
