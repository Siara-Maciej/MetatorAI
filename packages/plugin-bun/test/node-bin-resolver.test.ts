import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeBinResolver } from "../src/node-bin-resolver.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("NodeBinResolver (real files)", () => {
  test("the repo's node_modules/.bin wins; otherwise the bare name runs from PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-bin-"));
    dirs.push(root);
    await Bun.write(join(root, "node_modules/.bin/biome"), "#!/bin/sh\n");
    const resolver = new NodeBinResolver(root);
    expect(await resolver.command("biome", ["check", "a.ts"])).toEqual({
      argv: [join(root, "node_modules/.bin/biome"), "check", "a.ts"],
      cwd: root,
    });
    expect(await resolver.command("eslint", [])).toEqual({ argv: ["eslint"], cwd: root });
  });

  test("a Node project without node_modules runs its own binary path, reported missing, never another from PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-bin-"));
    dirs.push(root);
    await Bun.write(join(root, "package.json"), "{}");
    expect((await new NodeBinResolver(root).command("tsc", ["--noEmit"])).argv).toEqual([
      join(root, "node_modules/.bin/tsc"),
      "--noEmit",
    ]);
  });

  test("asked for PATH instead, a project without node_modules runs the bare name; a pinned binary still wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-bin-"));
    dirs.push(root);
    await Bun.write(join(root, "package.json"), "{}");
    const resolver = new NodeBinResolver(root, "path");
    expect((await resolver.command("tsc", ["--noEmit"])).argv).toEqual(["tsc", "--noEmit"]);
    await Bun.write(join(root, "node_modules/.bin/tsc"), "#!/bin/sh\n");
    expect((await resolver.command("tsc", [])).argv).toEqual([join(root, "node_modules/.bin/tsc")]);
  });
});
