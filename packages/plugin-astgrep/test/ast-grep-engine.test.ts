import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "@metator/core";
import { BunProcessRunner, NodeBinResolver } from "@metator/plugin-bun";
import { ruleEngineContract, ScriptedProcessRunner } from "@metator/testing";
import { AstGrepEngine } from "../src/ast-grep-engine.ts";

/** The engine as the runtime wires it: the repository's pinned binary first, PATH otherwise. */
const astGrep = (runner: ProcessRunner, root: string) =>
  new AstGrepEngine(runner, root, new NodeBinResolver(root, "path"));

const runner = new BunProcessRunner();
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const RULES = `id: no-var
language: TypeScript
severity: error
message: "no var"
rule:
  pattern: var $A = $B
---
id: no-eval
language: TypeScript
severity: warning
message: no eval
rule:
  pattern: eval($$$)
`;

async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-sg-"));
  dirs.push(dir);
  const all: Record<string, string> = {
    "sgconfig.yml": "ruleDirs: [rules]\ntestConfigs:\n  - testDir: rule-tests\n",
    "rules/style.yml": RULES,
    "rule-tests/no-var-test.yml": "id: no-var\nvalid: [const a = 1]\ninvalid: [var a = 1]\n",
    "src/a.ts": 'const ok = 1;\nvar bad = 2;\neval("x");\n',
    "src/clean.ts": "export const x = 1;\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) await Bun.write(join(dir, path), content);
  return dir;
}

/** A directory ast-grep is not configured in. */
async function empty(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-sg-bare-"));
  dirs.push(dir);
  return dir;
}

const BIN = join(import.meta.dir, "../node_modules/.bin/ast-grep");
/** Runs ast-grep from this package's node_modules, as if the user's repo had it installed. */
class PinnedRunner extends BunProcessRunner {
  override run(
    command: Parameters<BunProcessRunner["run"]>[0],
    options?: Parameters<BunProcessRunner["run"]>[1],
  ) {
    const argv = command.argv[0] === "ast-grep" ? [BIN, ...command.argv.slice(1)] : command.argv;
    return super.run({ ...command, argv }, options);
  }
}
const pinned = new PinnedRunner();

ruleEngineContract("AstGrepEngine", async () => ({
  engine: astGrep(pinned, await project()),
  bare: astGrep(pinned, await empty()),
  missing: astGrep(new ScriptedProcessRunner(), await project()),
  finding: { file: "src/a.ts", toolRuleId: "no-var" },
  clean: "src/clean.ts",
}));

describe("AstGrepEngine.rules (real config files)", () => {
  test("lists every rule id across multi-document files, with test coverage", async () => {
    const engine = astGrep(pinned, await project());
    expect((await engine.rules())._unsafeUnwrap()).toEqual([
      { id: "no-eval", source: "rules/style.yml", hasTest: false },
      { id: "no-var", source: "rules/style.yml", hasTest: true },
    ]);
  });

  test("no sgconfig.yml: no rules, nothing to check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-sg-none-"));
    dirs.push(dir);
    const engine = astGrep(runner, dir);
    expect((await engine.rules())._unsafeUnwrap()).toEqual([]);
    expect((await engine.check())._unsafeUnwrap()).toEqual([]);
  });

  test("invalid sgconfig.yml is INVALID_CONFIG", async () => {
    const engine = astGrep(pinned, await project({ "sgconfig.yml": "ruleDirs: [" }));
    expect((await engine.rules())._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });
});

describe("AstGrepEngine.check (real ast-grep)", () => {
  test("whole project: findings with 1-based positions and mapped severities", async () => {
    const engine = astGrep(pinned, await project());
    expect((await engine.check())._unsafeUnwrap()).toEqual([
      {
        source: "ast-grep",
        toolRuleId: "no-var",
        file: "src/a.ts",
        line: 2,
        column: 1,
        severity: "error",
        message: "no var",
      },
      {
        source: "ast-grep",
        toolRuleId: "no-eval",
        file: "src/a.ts",
        line: 3,
        column: 1,
        severity: "warning",
        message: "no eval",
      },
    ]);
  });

  test("only the given files; deleted files are skipped instead of failing the scan", async () => {
    const engine = astGrep(pinned, await project());
    expect((await engine.check(["src/clean.ts", "src/deleted.ts"]))._unsafeUnwrap()).toEqual([]);
    expect((await engine.check(["src/deleted.ts"]))._unsafeUnwrap()).toEqual([]);
  });

  test("a file name with a space, a letter outside ASCII and a percent sign is reported verbatim", async () => {
    const name = "src/c ż 100%25 50%.ts";
    const engine = astGrep(pinned, await project({ [name]: "var q = 1;\n" }));
    expect((await engine.check([name]))._unsafeUnwrap().map((d) => d.file)).toEqual([name]);
  });

  test("the repository's own node_modules/.bin/ast-grep is used (pinned version, not PATH)", async () => {
    const dir = await project();
    await mkdir(join(dir, "node_modules/.bin"), { recursive: true });
    await symlink(BIN, join(dir, "node_modules/.bin/ast-grep"));
    const scripted = new ScriptedProcessRunner([]);
    await astGrep(scripted, dir).check();
    expect(scripted.calls[0]?.argv[0]).toBe(join(dir, "node_modules/.bin/ast-grep"));
    expect((await astGrep(runner, dir).check())._unsafeUnwrap()).toHaveLength(2);
  });

  test("a missing binary is BIN_NOT_FOUND with an install hint", async () => {
    const scripted = new ScriptedProcessRunner([
      { argvPrefix: ["ast-grep"], result: { exitCode: 127, stderr: "not found" } },
    ]);
    const error = (await astGrep(scripted, await project()).check())._unsafeUnwrapErr();
    expect([error.code, error.hint?.includes("@ast-grep/cli")]).toEqual(["BIN_NOT_FOUND", true]);
  });

  test("garbage output or a crash is COMMAND_FAILED, never an empty success", async () => {
    const dir = await project();
    for (const result of [
      { exitCode: 1, stdout: "not json\n" },
      { exitCode: 2, stderr: "panic" },
      { exitCode: 1 },
    ]) {
      const scripted = new ScriptedProcessRunner([{ argvPrefix: ["ast-grep"], result }]);
      expect((await astGrep(scripted, dir).check())._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
    }
  });
});
