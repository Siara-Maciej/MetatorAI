import { describe, expect, test } from "bun:test";
import type { ProcessResult } from "@metator/core";
import { CheckFlaky } from "../src/application/flaky.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { PackageManager, ProcessRunner } from "../src/ports/index.ts";

const npm: PackageManager = {
  scriptCommand: async (s, a) => ok({ argv: ["npm", "run", s, "--", ...a], cwd: "/r" }),
  workspacesCommand: async (s) => ok({ argv: ["npm", "run", s, "--workspaces"], cwd: "/r" }),
};
const sequence = (codes: number[]): ProcessRunner & { argv: string[][] } => {
  const argv: string[][] = [];
  let i = 0;
  return {
    argv,
    run: async (c): Promise<ProcessResult> => {
      argv.push([...c.argv]);
      const exitCode = codes[i++] ?? 0;
      return { exitCode, stdout: exitCode === 0 ? "pass" : `(fail) run ${i}`, stderr: "", durationMs: 1 };
    },
  };
};

describe("CheckFlaky", () => {
  test("mixed results are flaky, with the first failure's output; every run uses the repo script", async () => {
    const runner = sequence([0, 1, 0, 1]);
    const r = (
      await new CheckFlaky(npm, runner).execute({ test: "a.test.ts", runs: 4, script: "test" })
    )._unsafeUnwrap();
    expect(r).toEqual({
      test: "a.test.ts",
      runs: 4,
      passed: 2,
      failed: 2,
      flaky: true,
      firstFailure: "(fail) run 2",
    });
    expect(runner.argv).toEqual(Array(4).fill(["npm", "run", "test", "--", "a.test.ts"]));
  });

  test("always green and always red are both deterministic", async () => {
    const green = (
      await new CheckFlaky(npm, sequence([0, 0])).execute({ test: "a", runs: 2, script: "test" })
    )._unsafeUnwrap();
    const red = (
      await new CheckFlaky(npm, sequence([1, 1])).execute({ test: "a", runs: 2, script: "test" })
    )._unsafeUnwrap();
    expect([green.flaky, green.failed, red.flaky, red.passed]).toEqual([false, 0, false, 0]);
  });

  test("a missing script is an error value", async () => {
    const none: PackageManager = {
      scriptCommand: async () => err(new MetatorError("INTERNAL", "no run command")),
      workspacesCommand: async () => err(new MetatorError("INTERNAL", "no run command")),
    };
    expect(
      (
        await new CheckFlaky(none, sequence([])).execute({ test: "a", runs: 1, script: "x" })
      )._unsafeUnwrapErr().code,
    ).toBe("INTERNAL");
  });
});
