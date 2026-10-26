import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@metator/plugin-bun";
import { ScriptedProcessRunner } from "@metator/testing";
import { TscDeclarationEmitter } from "../src/tsc-declaration-emitter.ts";

const TSC = join(import.meta.dir, "../node_modules/.bin/tsc");
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-dts-test-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content);
  await mkdir(join(dir, "node_modules/.bin"), { recursive: true });
  await symlink(TSC, join(dir, "node_modules/.bin/tsc"));
  return dir;
}
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] });

describe("TscDeclarationEmitter (real tsc)", () => {
  test("declaration files by repo-relative path, even with type errors; the temp directory is gone", async () => {
    const root = await project({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a: number = 1;\n",
      "src/b.ts": 'export const b: number = "type error";\n',
    });
    const files = (await new TscDeclarationEmitter(new BunProcessRunner(), root).emit())._unsafeUnwrap();
    expect([...files.keys()].sort()).toEqual(["src/a.d.ts", "src/b.d.ts"]);
    expect(files.get("src/a.d.ts")).toContain("export declare const a: number;");
  }, 60_000);

  test("no tsconfig, no tsc, nothing emitted: error values", async () => {
    const bare = await project({});
    expect(
      (await new TscDeclarationEmitter(new BunProcessRunner(), bare).emit())._unsafeUnwrapErr().code,
    ).toBe("NOT_FOUND");
    const root = await project({ "tsconfig.json": TSCONFIG, "src/a.ts": "export const a = 1;\n" });
    const missing = new ScriptedProcessRunner(); // unscripted commands exit 127
    expect((await new TscDeclarationEmitter(missing, root).emit())._unsafeUnwrapErr().code).toBe(
      "BIN_NOT_FOUND",
    );
    const silent = new ScriptedProcessRunner([
      { argvPrefix: [], result: { exitCode: 2, stdout: "", stderr: "boom" } },
    ]);
    expect((await new TscDeclarationEmitter(silent, root).emit())._unsafeUnwrapErr().code).toBe(
      "COMMAND_FAILED",
    );
  }, 60_000);
});
