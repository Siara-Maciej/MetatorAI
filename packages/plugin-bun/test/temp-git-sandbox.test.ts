import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TempGitSandbox } from "../src/temp-git-sandbox.ts";

describe("TempGitSandbox", () => {
  test("a committed git repository of the files, linked with bun install, removed on dispose", async () => {
    const box = (
      await new TempGitSandbox().create({
        "package.json": JSON.stringify({ name: "r", private: true, workspaces: ["packages/*"] }),
        "packages/a/package.json": JSON.stringify({ name: "@x/a", dependencies: { "@x/b": "*" } }),
        "packages/b/package.json": JSON.stringify({ name: "@x/b" }),
        "packages/b/src/index.ts": "export const b = 1;\n",
      })
    )._unsafeUnwrap();
    expect(await Bun.file(join(box.root, "packages/b/src/index.ts")).text()).toBe("export const b = 1;\n");
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: box.root }).stdout.toString();
    expect(log).toContain("sandbox");
    const status = Bun.spawnSync(["git", "status", "--porcelain", "--", "packages"], {
      cwd: box.root,
    }).stdout.toString();
    expect(status).toBe("");
    expect(
      existsSync(join(box.root, "packages/a/node_modules/@x/b")) ||
        existsSync(join(box.root, "node_modules/@x/b")),
    ).toBe(true);
    await box.dispose();
    expect(existsSync(box.root)).toBe(false);
  }, 60_000);

  test("a path outside the sandbox is refused and nothing is left behind", async () => {
    const e = (await new TempGitSandbox().create({ "../escape.txt": "x" }))._unsafeUnwrapErr();
    expect([e.code, e.message]).toEqual(["USAGE", "../escape.txt is outside the sandbox"]);
  });
});
