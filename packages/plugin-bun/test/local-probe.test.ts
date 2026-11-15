import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, onPath, pathExists } from "../src/local-probe.ts";

describe("commandExists", () => {
  test("a name is looked up on PATH; a path is a file that is there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-probe-"));
    const file = join(dir, "tool");
    await writeFile(file, "#!/bin/sh\n");
    expect(commandExists("sh")).toBe(true);
    expect(commandExists("metator-no-such-program")).toBe(false);
    // A path is not looked up on PATH: the file itself decides, executable or not.
    expect(commandExists(file)).toBe(true);
    expect(commandExists(join(dir, "missing"))).toBe(false);
    expect(commandExists("./sh")).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("onPath", () => {
  test("only programs PATH has", () => {
    expect([onPath("sh"), onPath("metator-no-such-program")]).toEqual([true, false]);
  });
});

describe("pathExists", () => {
  test("a file and a directory are there; a missing path is not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-probe-"));
    await writeFile(join(dir, "a.txt"), "a");
    expect([pathExists(dir), pathExists(join(dir, "a.txt")), pathExists(join(dir, "b.txt"))]).toEqual([
      true,
      true,
      false,
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});
