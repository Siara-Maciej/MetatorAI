import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@metator/plugin-bun";
import { ScriptedProcessRunner } from "@metator/testing";
import { TscEngine } from "../src/tsc-engine.ts";

const TSC = join(import.meta.dir, "../node_modules/.bin/tsc");
const runner = new BunProcessRunner();
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function project(files: Record<string, string>, installed = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-tsc-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content);
  if (installed) {
    await mkdir(join(dir, "node_modules/.bin"), { recursive: true });
    await symlink(TSC, join(dir, "node_modules/.bin/tsc"));
  }
  return dir;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    strictPropertyInitialization: false,
    noUncheckedIndexedAccess: true,
    noEmit: true,
  },
  include: ["src"],
});

describe("TscEngine (real tsc)", () => {
  test("rules are compiler checks, enabled as tsc --showConfig resolves them (strict family included)", async () => {
    const rules = (
      await new TscEngine(
        runner,
        await project({ "tsconfig.json": TSCONFIG, "src/a.ts": "export {};\n" }),
      ).rules()
    )._unsafeUnwrap();
    const on = (id: string) => rules.find((r) => r.id === id)?.enabled;
    expect([
      on("strict"),
      on("strictNullChecks"),
      on("strictPropertyInitialization"),
      on("noUncheckedIndexedAccess"),
      on("noUnusedLocals"),
    ]).toEqual([
      true,
      true,
      false, // explicitly off despite strict
      true,
      false,
    ]);
    expect(rules.every((r) => r.hasTest && r.source === "tsconfig.json")).toBe(true);
  });

  test("type errors are findings with code, position and repo-relative file; --files filters", async () => {
    const dir = await project({
      "tsconfig.json": TSCONFIG,
      "src/bad.ts": "const xs: number[] = [];\nexport const first: number = xs[0];\n",
      "src/good.ts": "export const ok = 1;\n",
    });
    const engine = new TscEngine(runner, dir);
    expect((await engine.check())._unsafeUnwrap()).toEqual([
      {
        source: "tsc",
        toolRuleId: "TS2322",
        file: "src/bad.ts",
        line: 2,
        column: 14,
        severity: "error",
        message: "Type 'number | undefined' is not assignable to type 'number'.",
      },
    ]);
    expect((await engine.check(["src/good.ts"]))._unsafeUnwrap()).toEqual([]);
  });

  test("no tsconfig: nothing to check; missing tsc and broken output are errors", async () => {
    const none = await project({ "src/a.ts": "export {};\n" }, false);
    expect([
      (await new TscEngine(runner, none).rules())._unsafeUnwrap(),
      (await new TscEngine(runner, none).check())._unsafeUnwrap(),
    ]).toEqual([[], []]);
    const dir = await project({ "tsconfig.json": TSCONFIG }, false);
    const missing = new ScriptedProcessRunner([{ argvPrefix: ["tsc"], result: { exitCode: 127 } }]);
    expect((await new TscEngine(missing, dir).check())._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
    const crash = new ScriptedProcessRunner([
      {
        argvPrefix: ["tsc"],
        result: { exitCode: 2, stdout: "error TS5058: The specified path does not exist" },
      },
    ]);
    expect((await new TscEngine(crash, dir).check())._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
    const garbage = new ScriptedProcessRunner([{ argvPrefix: ["tsc"], result: { stdout: "not json" } }]);
    expect((await new TscEngine(garbage, dir).rules())._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
  });
});
