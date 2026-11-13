import { describe, expect, test } from "bun:test";
import { type BinResolver, runTool } from "@metator/core";
import { ScriptedProcessRunner } from "@metator/testing";

/** The repository's pinned binary, as the real resolver names it. */
const bins: BinResolver = {
  command: async (bin, args) => ({ argv: [`/repo/node_modules/.bin/${bin}`, ...args], cwd: "/repo" }),
};
const BIN = "/repo/node_modules/.bin/lint";

describe("runTool", () => {
  test("runs the binary the resolver names, with the arguments, and returns the tool's own answer", async () => {
    const runner = new ScriptedProcessRunner([
      { argvPrefix: [BIN], result: { exitCode: 1, stdout: "findings", stderr: "warn" } },
    ]);
    const r = (await runTool(runner, bins, { bin: "lint", args: ["--json", "a.ts"] }))._unsafeUnwrap();
    expect(runner.calls).toEqual([{ argv: [BIN, "--json", "a.ts"], cwd: "/repo" }]);
    expect(r).toMatchObject({ exitCode: 1, stdout: "findings", stderr: "warn" });
  });

  test("a binary that cannot be started is BIN_NOT_FOUND with the install hint", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [BIN], result: { exitCode: 127 } }]);
    const error = (
      await runTool(runner, bins, { bin: "lint", args: [], hint: "Install it with `bun add -d lint`." })
    )._unsafeUnwrapErr();
    expect(error.toJSON()).toEqual({
      code: "BIN_NOT_FOUND",
      message: "lint is not installed",
      hint: "Install it with `bun add -d lint`.",
    });
  });

  test("the message names the tool when it is not the binary's name; no hint when none is given", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [BIN], result: { exitCode: 127 } }]);
    const error = (await runTool(runner, bins, { bin: "lint", args: [], tool: "Linter" }))._unsafeUnwrapErr();
    expect(error.toJSON()).toEqual({ code: "BIN_NOT_FOUND", message: "Linter is not installed" });
  });

  test("the time limit goes to the runner only when one is given", async () => {
    const seen: unknown[] = [];
    const runner = {
      run: async (_c: unknown, options?: unknown) => {
        seen.push(options);
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    };
    await runTool(runner, bins, { bin: "lint", args: [], timeoutMs: 5000 });
    await runTool(runner, bins, { bin: "lint", args: [] });
    expect(seen).toEqual([{ timeoutMs: 5000 }, {}]);
  });
});
