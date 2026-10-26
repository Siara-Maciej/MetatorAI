import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@metator/plugin-bun";
import { ScriptedProcessRunner } from "@metator/testing";
import { BiomeEngine } from "../src/biome-engine.ts";

const BIOME_PKG = join(import.meta.dir, "../node_modules/@biomejs/biome");
const runner = new BunProcessRunner();
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A project with Biome installed the way `bun add -d @biomejs/biome` leaves it. */
async function project(files: Record<string, string>, installed = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-biome-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content);
  if (installed) {
    await mkdir(join(dir, "node_modules/@biomejs"), { recursive: true });
    await mkdir(join(dir, "node_modules/.bin"), { recursive: true });
    await symlink(BIOME_PKG, join(dir, "node_modules/@biomejs/biome"));
    await symlink(join(BIOME_PKG, "bin/biome"), join(dir, "node_modules/.bin/biome"));
  }
  return dir;
}

const FILES = {
  "biome.json": "{}\n",
  "src/bad.ts": "debugger;\nexport const x = 1;\n",
  "src/good.ts": "export const y = 2;\n",
  "README.md": "# not linted\n",
};

describe("BiomeEngine (real Biome)", () => {
  test("rules come from the installed Biome's schema, as lint/<group>/<rule>", async () => {
    const rules = (await new BiomeEngine(runner, await project(FILES)).rules())._unsafeUnwrap();
    expect(rules.length).toBeGreaterThan(200);
    expect(rules.find((r) => r.id === "lint/suspicious/noDebugger")).toEqual({
      id: "lint/suspicious/noDebugger",
      source: "@biomejs/biome",
      hasTest: true,
    });
    expect(rules.some((r) => r.id.endsWith("/recommended"))).toBe(false);
  });

  test("whole project and selected files; unknown and deleted files are ignored", async () => {
    const engine = new BiomeEngine(runner, await project(FILES));
    expect((await engine.check())._unsafeUnwrap()).toEqual([
      {
        source: "biome",
        toolRuleId: "lint/suspicious/noDebugger",
        file: "src/bad.ts",
        line: 1,
        column: 1,
        severity: "error",
        message: "This is an unexpected use of the debugger statement.",
      },
    ]);
    expect((await engine.check(["src/good.ts", "README.md", "src/gone.ts"]))._unsafeUnwrap()).toEqual([]);
  });

  test("a repo without a Biome config is skipped; without Biome installed there are no rules", async () => {
    const { "biome.json": _config, ...rest } = FILES;
    expect((await new BiomeEngine(runner, await project(rest)).check())._unsafeUnwrap()).toEqual([]);
    expect((await new BiomeEngine(runner, await project(FILES, false)).rules())._unsafeUnwrap()).toEqual([]);
  });

  test("missing binary and unreadable output are errors, never an empty success", async () => {
    const dir = await project(FILES, false);
    const missing = new ScriptedProcessRunner([{ argvPrefix: ["biome"], result: { exitCode: 127 } }]);
    expect((await new BiomeEngine(missing, dir).check())._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
    const garbage = new ScriptedProcessRunner([
      { argvPrefix: ["biome"], result: { exitCode: 1, stdout: "panic" } },
    ]);
    expect((await new BiomeEngine(garbage, dir).check())._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
  });
});
