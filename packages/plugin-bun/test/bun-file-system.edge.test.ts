import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "../src/bun-file-system.ts";

const roots: string[] = [];
async function fresh(): Promise<{ fs: BunFileSystem; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "metator-fs-edge-"));
  roots.push(root);
  return { fs: new BunFileSystem(root), root };
}
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

describe("BunFileSystem edge cases", () => {
  test("write creates nested directories and overwrites existing files", async () => {
    const { fs, root } = await fresh();
    expect((await fs.write("a/b/c/report.json", "1")).isOk()).toBe(true);
    expect((await fs.write("a/b/c/report.json", "2")).isOk()).toBe(true);
    expect(await Bun.file(join(root, "a/b/c/report.json")).text()).toBe("2");
  });

  test("glob includes dotfiles like .github/ but not .git/", async () => {
    const { fs } = await fresh();
    await fs.write(".github/workflows/ci.yml", "x");
    await fs.write(".git/config", "x");
    expect(await fs.glob(["**/*"])).toEqual([".github/workflows/ci.yml"]);
  });

  test("glob de-duplicates files matched by several patterns", async () => {
    const { fs } = await fresh();
    await fs.write("src/a.ts", "");
    expect(await fs.glob(["src/**", "**/*.ts", "src/a.ts"])).toEqual(["src/a.ts"]);
  });

  test("accepts Windows-style and ./-prefixed paths", async () => {
    const { fs } = await fresh();
    await fs.write(".\\docs\\x.md", "hi");
    expect((await fs.read("docs/x.md"))._unsafeUnwrap()).toBe("hi");
    expect(await fs.exists("./docs/x.md")).toBe(true);
  });

  test("UTF-8 content round-trips byte-exactly", async () => {
    const { fs } = await fresh();
    const content = "zażółć gęślą jaźń · 日本語 · emoji 🚀\n";
    await fs.write("utf8.txt", content);
    expect((await fs.read("utf8.txt"))._unsafeUnwrap()).toBe(content);
  });
});
