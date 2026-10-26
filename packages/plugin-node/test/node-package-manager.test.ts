import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePackageManager } from "../src/node-package-manager.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-pm-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content);
  return dir;
}

describe("NodePackageManager (real files)", () => {
  test("packageManager field wins, with its version", async () => {
    const pm = new NodePackageManager(
      await repo({ "package.json": JSON.stringify({ packageManager: "pnpm@9.12.1" }), "yarn.lock": "" }),
    );
    expect((await pm.detect())._unsafeUnwrap()).toEqual({
      name: "pnpm",
      version: "9.12.1",
      lockfiles: ["yarn.lock"],
    });
  });

  test("lockfiles decide otherwise; several are all listed", async () => {
    const pm = new NodePackageManager(
      await repo({ "package.json": "{}", "bun.lock": "", "package-lock.json": "{}" }),
    );
    const detected = (await pm.detect())._unsafeUnwrap();
    expect(detected?.lockfiles).toEqual(["bun.lock", "package-lock.json"]);
    expect(["bun", "npm"]).toContain(detected?.name as string);
  });

  test("a repo with no signal has no package manager; scripts then run with npm", async () => {
    const dir = await repo({ "package.json": "{}" });
    const pm = new NodePackageManager(dir);
    expect((await pm.detect())._unsafeUnwrap()).toBeUndefined();
    expect((await pm.scriptCommand("lint", ["a.ts"]))._unsafeUnwrap()).toEqual({
      argv: ["npm", "run", "lint", "--", "a.ts"],
      cwd: dir,
    });
  });

  test.each([
    ["package-lock.json", ["npm", "run", "lint", "--", "a.ts"]],
    ["yarn.lock", ["yarn", "run", "lint", "a.ts"]],
    ["pnpm-lock.yaml", ["pnpm", "run", "lint", "a.ts"]],
    ["bun.lock", ["bun", "run", "lint", "a.ts"]],
  ])("%s → %j", async (lockfile, argv) => {
    const pm = new NodePackageManager(await repo({ "package.json": "{}", [lockfile]: "" }));
    expect((await pm.scriptCommand("lint", ["a.ts"]))._unsafeUnwrap().argv).toEqual(argv);
  });
});
