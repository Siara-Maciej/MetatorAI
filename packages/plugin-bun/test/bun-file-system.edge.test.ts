import { afterAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
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

  test("write replaces the file whole: no temporary file stays, a link is written through, the mode is kept", async () => {
    const { fs, root } = await fresh();
    await fs.write("run/state.json", "old");
    await chmod(join(root, "run/state.json"), 0o755);
    await symlink(join(root, "run/state.json"), join(root, "link.json"));
    expect((await fs.write("link.json", "new")).isOk()).toBe(true);
    expect((await lstat(join(root, "link.json"))).isSymbolicLink()).toBe(true);
    expect(await Bun.file(join(root, "run/state.json")).text()).toBe("new");
    expect((await stat(join(root, "run/state.json"))).mode & 0o777).toBe(0o755);
    expect(await readdir(join(root, "run"))).toEqual(["state.json"]);
  });

  test("a reader never sees half a file while another writes it", async () => {
    const { fs } = await fresh();
    const texts = ["a".repeat(4_000_000), "b".repeat(4_000_000)];
    await fs.write("state.json", texts[0] as string);
    let torn = 0;
    let writing = true;
    const reader = (async () => {
      while (writing) {
        const text = (await fs.read("state.json"))._unsafeUnwrap();
        if (!texts.includes(text)) torn++;
      }
    })();
    for (let i = 0; i < 40; i++) await fs.write("state.json", texts[i % 2] as string);
    writing = false;
    await reader;
    expect(torn).toBe(0);
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

  test("an absolute path inside the root is the same file; one outside it is a usage error", async () => {
    const { fs, root } = await fresh();
    await fs.write("runs/1/findings/merged.json", "{}");
    expect((await fs.read(join(root, "runs/1/findings/merged.json")))._unsafeUnwrap()).toBe("{}");
    expect(await fs.exists(join(root, "runs/1/findings/merged.json"))).toBe(true);
    expect((await fs.write(join(root, "runs/1/verdict.json"), "v")).isOk()).toBe(true);
    expect(await Bun.file(join(root, "runs/1/verdict.json")).text()).toBe("v");
    expect((await fs.read(join(tmpdir(), "elsewhere.json")))._unsafeUnwrapErr().code).toBe("USAGE");
  });

  test("UTF-8 content round-trips byte-exactly", async () => {
    const { fs } = await fresh();
    const content = "zażółć gęślą jaźń · 日本語 · emoji 🚀\n";
    await fs.write("utf8.txt", content);
    expect((await fs.read("utf8.txt"))._unsafeUnwrap()).toBe(content);
  });
});
