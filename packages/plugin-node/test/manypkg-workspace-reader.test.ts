import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createMonorepo, MONOREPO_FILES, writeFixture } from "@metator/testing";
import { ManypkgWorkspaceReader } from "../src/manypkg-workspace-reader.ts";

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-ws-"));
  dirs.push(dir);
  await writeFixture(dir, files);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("ManypkgWorkspaceReader", () => {
  const EXPECTED = [
    { name: "@acme/web", dir: "apps/web" },
    { name: "@acme/billing", dir: "packages/billing" },
    { name: "@acme/money", dir: "packages/money" },
  ];

  test("installed bun workspaces (lockfile present, detected by manypkg)", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-ws-installed-"));
    dirs.push(root);
    await createMonorepo(root);
    expect(await Bun.file(join(root, "bun.lock")).exists()).toBe(true);
    expect((await new ManypkgWorkspaceReader(root).packages())._unsafeUnwrap()).toEqual(EXPECTED);
  });

  test("workspaces declared but no lockfile yet (fresh clone)", async () => {
    const root = await fixture(MONOREPO_FILES as Record<string, string>);
    expect((await new ManypkgWorkspaceReader(root).packages())._unsafeUnwrap()).toEqual(EXPECTED);
  });

  test("pnpm workspaces from pnpm-workspace.yaml", async () => {
    const root = await fixture({
      "package.json": '{ "name": "p", "private": true }',
      "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
      "libs/one/package.json": '{ "name": "@p/one" }',
    });
    expect((await new ManypkgWorkspaceReader(root).packages())._unsafeUnwrap()).toEqual([
      { name: "@p/one", dir: "libs/one" },
    ]);
  });

  test("a package.json without a name is named after its directory, not an error", async () => {
    const pnpm = await fixture({
      "package.json": '{ "private": true }',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": "packages:\n  - proxy\n  - '!**/test/**'\n",
      "proxy/package.json": '{ "private": true }',
    });
    expect((await new ManypkgWorkspaceReader(pnpm).packages())._unsafeUnwrap()).toEqual([
      { name: "proxy", dir: "proxy" },
    ]);
    const single = await fixture({ "package.json": '{ "private": true }', "pnpm-lock.yaml": "x: 1\n" });
    const name = basename(single);
    expect((await new ManypkgWorkspaceReader(single).packages())._unsafeUnwrap()).toEqual([
      { name, dir: "." },
    ]);
  });

  test("a single-package repository is one package at the root", async () => {
    const root = await fixture({ "package.json": '{ "name": "solo" }' });
    expect((await new ManypkgWorkspaceReader(root).packages())._unsafeUnwrap()).toEqual([
      { name: "solo", dir: "." },
    ]);
  });

  test("a repository without package.json has no packages", async () => {
    const root = await fixture({ "README.md": "# not js" });
    expect((await new ManypkgWorkspaceReader(root).packages())._unsafeUnwrap()).toEqual([]);
  });
});

describe("ManypkgWorkspaceReader declared globs", () => {
  test("a deep workspace glob skips packages inside node_modules", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/**"] }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/a/node_modules/dep/package.json": JSON.stringify({ name: "dep" }),
    });
    expect((await new ManypkgWorkspaceReader(root).packages())._unsafeUnwrap()).toEqual([
      { name: "a", dir: "packages/a" },
    ]);
  });
});
