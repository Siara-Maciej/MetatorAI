import { describe, expect, test } from "bun:test";
import { ScriptedProcessRunner } from "@metator/testing";
import { RunAffectedTests } from "../src/application/test-affected.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { PackageManager } from "../src/ports/index.ts";

const affected = (tests: string[]) => ({
  execute: async () => ok({ changed: ["src/a.ts"], files: ["src/a.ts", ...tests], tests }),
});
const npm: PackageManager = {
  scriptCommand: async (script, args) => ok({ argv: ["npm", "run", script, "--", ...args], cwd: "/repo" }),
};

describe("RunAffectedTests", () => {
  test("runs the repository's test script with only the affected test files", async () => {
    const runner = new ScriptedProcessRunner([
      { argvPrefix: ["npm"], result: { exitCode: 0, stdout: "2 pass" } },
    ]);
    const run = await new RunAffectedTests(affected(["src/a.test.ts", "src/b.test.ts"]), npm, runner).execute(
      {
        base: "main",
        script: "test:unit",
      },
    );
    expect(run._unsafeUnwrap()).toEqual({
      changed: ["src/a.ts"],
      tests: ["src/a.test.ts", "src/b.test.ts"],
      command: ["npm", "run", "test:unit", "--", "src/a.test.ts", "src/b.test.ts"],
      exitCode: 0,
      passed: true,
      output: "2 pass",
    });
    expect(runner.calls.length).toBe(1);
  });

  test("a failing run is reported with its exit code and output", async () => {
    const runner = new ScriptedProcessRunner([
      { argvPrefix: ["npm"], result: { exitCode: 1, stderr: "(fail) adds" } },
    ]);
    const run = (
      await new RunAffectedTests(affected(["src/a.test.ts"]), npm, runner).execute({ script: "test" })
    )._unsafeUnwrap();
    expect([run.passed, run.exitCode, run.output?.trim()]).toEqual([false, 1, "(fail) adds"]);
  });

  test("no affected test: nothing runs and the result passes", async () => {
    const runner = new ScriptedProcessRunner();
    const run = (
      await new RunAffectedTests(affected([]), npm, runner).execute({ script: "test" })
    )._unsafeUnwrap();
    expect([run.command, run.exitCode, run.passed, runner.calls.length]).toEqual([null, null, true, 0]);
  });

  test("errors from the graph or the package manager are values", async () => {
    const failing = { execute: async () => err(MetatorError.usage("Unknown base ref")) };
    const runner = new ScriptedProcessRunner();
    expect(
      (await new RunAffectedTests(failing, npm, runner).execute({ script: "test" }))._unsafeUnwrapErr().code,
    ).toBe("USAGE");
    const noScript: PackageManager = {
      scriptCommand: async () => err(new MetatorError("INTERNAL", "no run command")),
    };
    const run = await new RunAffectedTests(affected(["a.test.ts"]), noScript, runner).execute({
      script: "test",
    });
    expect(run._unsafeUnwrapErr().code).toBe("INTERNAL");
  });
});
