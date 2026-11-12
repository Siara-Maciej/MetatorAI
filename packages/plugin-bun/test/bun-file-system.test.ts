import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSystemContract } from "@metator/testing";
import { BunFileSystem } from "../src/bun-file-system.ts";

const roots: string[] = [];

async function seeded(files: Readonly<Record<string, string>>): Promise<BunFileSystem> {
  const root = await mkdtemp(join(tmpdir(), "metator-fs-"));
  roots.push(root);
  const fs = new BunFileSystem(root);
  for (const [path, content] of Object.entries(files)) await fs.write(path, content);
  return fs;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

fileSystemContract("BunFileSystem", seeded);

describe("BunFileSystem specifics", () => {
  test("skips node_modules and .git by default", async () => {
    const fs = await seeded({ "src/a.ts": "", "node_modules/x/index.ts": "", ".git/hooks/pre.ts": "" });
    expect(await fs.glob(["**/*.ts"])).toEqual(["src/a.ts"]);
  });

  test("refuses paths that escape the repository root", async () => {
    const fs = await seeded({});
    const result = await fs.read("../../etc/passwd");
    expect(result._unsafeUnwrapErr().code).toBe("USAGE");
    expect(await fs.exists("../outside.txt")).toBe(false);
    expect((await fs.write("../outside.txt", "x")).isErr()).toBe(true);
  });
});

test("the first write under a watched directory is announced before the directory exists, and only then", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-fs-"));
  try {
    const seen: boolean[] = [];
    const fs = new BunFileSystem(dir, {
      dir: ".metator",
      created: () => seen.push(existsSync(join(dir, ".metator"))),
    });
    await fs.write("src/a.ts", "a");
    await fs.read(".metator/index/imports.json");
    expect(seen).toEqual([]);
    await fs.write(".metator/index/imports.json", "{}");
    await fs.append(".metator/log.jsonl", "{}\n");
    await fs.write(join(dir, ".metator/abs.json"), "{}");
    expect(seen).toEqual([false]);
    // A directory that was already there (another process made it) is not announced again.
    const again: string[] = [];
    await new BunFileSystem(dir, { dir: ".metator", created: () => again.push("x") }).append(
      ".metator/y",
      "y",
    );
    expect(again).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
