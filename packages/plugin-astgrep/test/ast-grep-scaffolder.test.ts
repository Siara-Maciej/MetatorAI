import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AstGrepScaffolder } from "../src/ast-grep-scaffolder.ts";

const BIN = join(import.meta.dir, "../node_modules/.bin/ast-grep");
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function project(config?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-scaffold-"));
  dirs.push(dir);
  if (config !== undefined) await Bun.write(join(dir, "sgconfig.yml"), config);
  return dir;
}

const CONFIG = "ruleDirs: [sg/rules]\ntestConfigs:\n  - testDir: sg/tests\n";
const spec = { ruleId: "mt-ts-001", message: "MT-TS-001: No var", files: ["src/**"] };

describe("AstGrepScaffolder (real ast-grep)", () => {
  test("writes a valid rule and a test that fails until real cases are written", async () => {
    const dir = await project(CONFIG);
    const result = (await new AstGrepScaffolder(dir).scaffold(spec))._unsafeUnwrap();
    expect(result.files).toEqual(["sg/rules/mt-ts-001.yml", "sg/tests/mt-ts-001-test.yml"]);
    const proc = Bun.spawn([BIN, "test", "--skip-snapshot-tests"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).not.toBe(0); // placeholders do not pass
    expect(out).toContain("mt-ts-001");
    expect(await Bun.file(join(dir, "sg/rules/mt-ts-001.yml")).text()).toContain("files:\n  - src/**");
  });

  test("never overwrites an existing rule", async () => {
    const dir = await project(CONFIG);
    await new AstGrepScaffolder(dir).scaffold(spec);
    expect((await new AstGrepScaffolder(dir).scaffold(spec))._unsafeUnwrapErr().code).toBe("USAGE");
  });

  test("needs sgconfig.yml with ruleDirs and testConfigs", async () => {
    expect((await new AstGrepScaffolder(await project()).scaffold(spec))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
    expect(
      (await new AstGrepScaffolder(await project("ruleDirs: [r]\n")).scaffold(spec))._unsafeUnwrapErr().code,
    ).toBe("INVALID_CONFIG");
    expect(
      (await new AstGrepScaffolder(await project("ruleDirs: [")).scaffold(spec))._unsafeUnwrapErr().code,
    ).toBe("INVALID_CONFIG");
  });
});
