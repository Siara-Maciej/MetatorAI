import { afterAll, describe, expect, test } from "bun:test";
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
