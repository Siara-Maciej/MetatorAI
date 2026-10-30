import { describe, expect, test } from "bun:test";
import { FakeVcs, FixedClock, InMemoryFileSystem, ScriptedProcessRunner } from "@metator/testing";
import { RunGate } from "../src/application/gate.ts";
import { GateChecks } from "../src/application/gate-checks.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { MetatorConfigSchema } from "../src/domain/config.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { outputTail } from "../src/domain/gate.ts";
import { err, ok } from "../src/domain/result.ts";
import type { ResolvedCommand } from "../src/ports/index.ts";

const config = (gates: unknown) => MetatorConfigSchema.parse({ gates });
const pm = {
  scriptCommand: async (script: string, args: readonly string[]) =>
    ok<ResolvedCommand>({ argv: ["bun", "run", script, ...args], cwd: "/repo" }),
  workspacesCommand: async (script: string) =>
    ok<ResolvedCommand>({ argv: ["bun", "run", "--filter", "*", script], cwd: "/repo" }),
};
const bins = {
  command: async (bin: string, args: readonly string[]): Promise<ResolvedCommand> => ({
    argv: [`/repo/node_modules/.bin/${bin}`, ...args],
    cwd: "/repo",
  }),
};
const violations = (list: { severity: "error" | "warning"; file: string }[]) => ({
  execute: async () =>
    ok({
      engines: ["ast-grep"],
      files: "all" as const,
      violations: list.map((v) => ({
        ...v,
        source: "ast-grep",
        engine: "ast-grep",
        message: "bad",
        toolRuleId: "r",
      })),
    }),
});

const unused = {
  execute: async () => err(new MetatorError("INTERNAL", "not used here")),
  diff: async () => err(new MetatorError("INTERNAL", "not used here")),
};
const checksWith = (rules: ReturnType<typeof violations>) =>
  new GateChecks(rules, unused, unused, unused, unused, unused);

function gate(
  gates: unknown,
  runner: ScriptedProcessRunner,
  opts: { files?: Record<string, string>; changed?: string[]; rules?: ReturnType<typeof violations> } = {},
) {
  const fs = new InMemoryFileSystem(opts.files ?? { "src/a.ts": "", "src/b.ts": "" });
  const vcs = new FakeVcs(Object.keys(opts.files ?? {}), opts.changed ?? []);
  return {
    fs,
    run: new RunGate(
      config(gates),
      pm,
      bins,
      runner,
      checksWith(opts.rules ?? violations([])),
      vcs,
      fs,
      DEFAULT_PATHS,
      new FixedClock(new Date("2026-10-26T10:00:00Z")),
    ),
  };
}

const LINT = { id: "lint", run: { bin: "biome", args: ["check"] }, files: "append" };
const TEST = { id: "test", run: { script: "test" } };

describe("RunGate", () => {
  test("scripts go through the package manager, bins through the resolver, files appended only where asked", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const report = (
      await gate({ quick: [LINT, TEST] }, runner).run.execute({ gate: "quick", files: ["src/a.ts"] })
    )._unsafeUnwrap();
    expect(runner.calls.map((c) => c.argv)).toEqual([
      ["/repo/node_modules/.bin/biome", "check", "src/a.ts"],
      ["bun", "run", "test"],
    ]);
    expect(report).toMatchObject({
      gate: "quick",
      files: ["src/a.ts"],
      passed: true,
      startedAt: "2026-10-26T10:00:00.000Z",
    });
  });

  test("a workspaces step runs the script in every workspace package through the package manager", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const step = {
      id: "typecheck",
      run: { workspaces: "typecheck" },
      files: "none" as const,
      okExitCodes: [0],
      timeoutMs: 1000,
    };
    (await gate({ full: [step] }, runner).run.execute({ gate: "full" }))._unsafeUnwrap();
    expect(runner.calls.map((c) => c.argv)).toEqual([["bun", "run", "--filter", "*", "typecheck"]]);
  });

  test("every step runs; a failing step carries the end of its output; 127 is an error", async () => {
    const runner = new ScriptedProcessRunner([
      {
        argvPrefix: ["/repo/node_modules/.bin/biome"],
        result: { exitCode: 1, stdout: `${"line\n".repeat(30)}src/a.ts: bad format` },
      },
      { argvPrefix: ["bun"], result: { exitCode: 127 } },
    ]);
    const report = (await gate({ full: [LINT, TEST] }, runner).run.execute({ gate: "full" }))._unsafeUnwrap();
    expect(report.passed).toBe(false);
    expect(report.steps.map((s) => [s.id, s.status])).toEqual([
      ["lint", "fail"],
      ["test", "error"],
    ]);
    expect(report.steps[0]?.detail?.split("\n").length).toBeLessThanOrEqual(20);
    expect(report.steps[0]?.detail).toContain("src/a.ts: bad format");
    expect(report.steps[1]?.detail).toBe("not found: bun");
  });

  test("match limits the appended files; nothing matching skips the step", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const w = gate({ quick: [{ ...LINT, match: ["**/*.ts"] }] }, runner, {
      files: { "src/a.ts": "", "README.md": "" },
    });
    await w.run.execute({ gate: "quick", files: ["src/a.ts", "README.md"] });
    expect(runner.calls[0]?.argv).toEqual(["/repo/node_modules/.bin/biome", "check", "src/a.ts"]);
    const docsOnly = (await w.run.execute({ gate: "quick", files: ["README.md"] }))._unsafeUnwrap();
    expect(docsOnly.steps[0]).toMatchObject({ status: "skipped", detail: "no files this step checks" });
  });

  test("okExitCodes accept a tool's 'findings' exit code", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 1 } }]);
    const report = (
      await gate({ quick: [{ ...TEST, okExitCodes: [0, 1] }] }, runner).run.execute({ gate: "quick" })
    )._unsafeUnwrap();
    expect(report.passed).toBe(true);
  });

  test("--base scopes to changed files that still exist; no changes skips file steps", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const w = gate({ quick: [LINT] }, runner, { changed: ["src/a.ts", "src/deleted.ts"] });
    const report = (await w.run.execute({ gate: "quick", base: "main" }))._unsafeUnwrap();
    expect([report.files, runner.calls[0]?.argv.slice(-1)]).toEqual([["src/a.ts"], ["src/a.ts"]]);
    const none = (
      await gate({ quick: [LINT] }, runner).run.execute({ gate: "quick", files: [] })
    )._unsafeUnwrap();
    expect(none.steps).toEqual([
      { id: "lint", status: "skipped", durationMs: 0, detail: "no files to check" },
    ]);
  });

  test("the rules step runs in process: error violations fail it, warnings do not", async () => {
    const runner = new ScriptedProcessRunner([]);
    const step = { id: "rules", run: { metator: "rules check" } };
    const red = gate({ quick: [step] }, runner, {
      rules: violations([{ severity: "error", file: "src/a.ts" }]),
    });
    const report = (await red.run.execute({ gate: "quick" }))._unsafeUnwrap();
    expect([report.passed, report.steps[0]?.detail]).toEqual([false, "src/a.ts:1 r: bad"]);
    const amber = gate({ quick: [step] }, runner, {
      rules: violations([{ severity: "warning", file: "src/a.ts" }]),
    });
    expect((await amber.run.execute({ gate: "quick" }))._unsafeUnwrap().passed).toBe(true);
    expect(runner.calls).toEqual([]);
  });

  test("the report is a versioned document", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const w = gate({ full: [TEST] }, runner);
    await w.run.execute({ gate: "full" });
    const saved = JSON.parse((await w.fs.read(".metator/gates/full.json"))._unsafeUnwrap());
    expect([saved.kind, saved.schemaVersion, saved.gate, saved.files]).toEqual([
      "GateReport",
      1,
      "full",
      null,
    ]);
  });
});

describe("outputTail", () => {
  test("keeps the last lines, then caps the characters from the end", () => {
    expect(outputTail("a\nb\nc\n", 2)).toBe("b\nc");
    expect(outputTail(`${"x".repeat(50)}END`, 20, 10)).toBe("xxxxxxxEND");
  });
});
