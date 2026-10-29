import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok } from "@metator/core";
import { writeFixture } from "@metator/testing";
import { ManypkgManifestReader } from "../src/manypkg-manifest-reader.ts";
import { ManypkgWorkspaceReader } from "../src/manypkg-workspace-reader.ts";

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-manifests-"));
  dirs.push(dir);
  await writeFixture(dir, files);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const json = (value: unknown) => JSON.stringify(value);

describe("ManypkgManifestReader", () => {
  test("workspace manifests with Nx and Turborepo tags, and the root manifest", async () => {
    const root = await fixture({
      "package.json": json({
        name: "shop",
        private: true,
        workspaces: ["apps/*", "packages/*"],
        devDependencies: { typescript: "5" },
      }),
      "apps/web/package.json": json({
        name: "@shop/web",
        dependencies: { "@shop/ui": "workspace:*" },
        scripts: { dev: "vite" },
      }),
      "apps/web/project.json": json({ projectType: "application", tags: ["scope:shop", "type:app"] }),
      "packages/ui/package.json": json({ name: "@shop/ui", main: "src/index.ts", nx: { tags: ["type:ui"] } }),
      "packages/ui/turbo.json": json({ tags: ["scope:shared", "type:ui"] }),
      "packages/db/package.json": json({ name: "@shop/db", exports: "./src/index.ts" }),
      "packages/db/project.json": "{ not json",
    });
    const set = (
      await new ManypkgManifestReader(root, new ManypkgWorkspaceReader(root)).manifests()
    )._unsafeUnwrap();
    expect(set.root).toMatchObject({
      name: "shop",
      dir: ".",
      private: true,
      devDependencies: { typescript: "5" },
    });
    expect(set.packages.map((p) => [p.name, p.dir, p.tags, p.projectType, p.entry])).toEqual([
      ["@shop/web", "apps/web", ["scope:shop", "type:app"], "application", false],
      ["@shop/db", "packages/db", [], undefined, true],
      ["@shop/ui", "packages/ui", ["scope:shared", "type:ui"], undefined, true],
    ]);
    expect(set.packages[0]?.dependencies).toEqual({ "@shop/ui": "workspace:*" });
  });

  test("a repository without package.json has no manifests", async () => {
    const root = await fixture({ "README.md": "x" });
    expect(
      (await new ManypkgManifestReader(root, new ManypkgWorkspaceReader(root)).manifests())._unsafeUnwrap(),
    ).toEqual({
      packages: [],
    });
  });

  test("a package the workspace lists without a readable package.json keeps its name", async () => {
    const root = await fixture({ "package.json": json({ name: "r" }) });
    const workspace = { packages: async () => ok([{ name: "@x/gone", dir: "packages/gone" }]) };
    const set = (await new ManypkgManifestReader(root, workspace).manifests())._unsafeUnwrap();
    expect(set.packages.map((p) => [p.name, p.dir, p.entry])).toEqual([["@x/gone", "packages/gone", false]]);
  });

  test("a workspace that cannot be read is the workspace's error", async () => {
    const failing = { packages: async () => err(new MetatorError("INVALID_CONFIG", "bad globs")) };
    const e = (await new ManypkgManifestReader("/nowhere", failing).manifests())._unsafeUnwrapErr();
    expect([e.code, e.message]).toEqual(["INVALID_CONFIG", "bad globs"]);
  });
});
