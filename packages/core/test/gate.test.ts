import { describe, expect, test } from "bun:test";
import { FakeVcs, FixedClock, InMemoryFileSystem, ScriptedProcessRunner } from "@metator/testing";
import { RunGate } from "../src/application/gate.ts";
import { GateChecks } from "../src/application/gate-checks.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { MetatorConfigSchema } from "../src/domain/config.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { outputTail } from "../src/domain/gate.ts";
import type { JavaBuild, JavaModule } from "../src/domain/java-build.ts";
import { err, ok } from "../src/domain/result.ts";
import type { ResolvedCommand } from "../src/ports/index.ts";

const config = (gates: unknown) => MetatorConfigSchema.parse({ gates });
const pm = {
  scriptCommand: async (script: string, args: readonly string[]) =>
    ok<ResolvedCommand>({ argv: ["bun", "run", script, ...args], cwd: "/repo" }),
  workspacesCommand: async (script: string) =>
    ok<ResolvedCommand>({ argv: ["bun", "run", "--filter", "*", script], cwd: "/repo" }),
  installCommand: async (cwd: string) => ok<ResolvedCommand>({ argv: ["bun", "install"], cwd }),
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
  opts: {
    files?: Record<string, string>;
    changed?: string[];
    rules?: ReturnType<typeof violations>;
    java?: JavaBuild;
    platform?: string;
  } = {},
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
      opts.java ? { read: async () => ok(opts.java as JavaBuild) } : undefined,
      () => opts.platform ?? "linux",
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

describe("RunGate: a Java build (round 22)", () => {
  const BUILD = {
    id: "test",
    run: { build: "maven", args: ["-B", "test"] },
    files: "modules",
    match: ["**/*.java", "**/pom.xml"],
  };
  const files = {
    "pom.xml": "<project/>",
    "shop-api/pom.xml": "<project/>",
    "shop-api/src/main/java/a/Api.java": "",
    "shop-domain/pom.xml": "<project/>",
    "shop-domain/src/main/java/a/Order.java": "",
    "README.md": "",
  };
  // The modules as the Java build reader gives them.
  const mod = (name: string, dir: string, build: "maven" | "gradle" = "maven"): JavaModule => ({
    name,
    dir,
    build,
    buildFile: `${dir}/pom.xml`,
    sourceRoots: [],
    modules: [],
    dependencies: [],
  });
  const java: JavaBuild = {
    tools: ["maven"],
    modules: [mod("parent", "."), mod("shop-api", "shop-api"), mod("shop-domain", "shop-domain")],
    notes: [],
  };

  test("only the changed files' modules, and what they need; the tool from PATH without a wrapper", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const report = (
      await gate({ quick: [BUILD] }, runner, { files, java }).run.execute({
        gate: "quick",
        files: ["shop-domain/src/main/java/a/Order.java", "shop-api/src/main/java/a/Api.java", "README.md"],
      })
    )._unsafeUnwrap();
    expect(report.steps[0]?.command).toEqual(["mvn", "-pl", "shop-api,shop-domain", "-am", "-B", "test"]);
    expect(runner.calls[0]?.cwd).toBe("/repo");
  });

  test("the wrapper at the root wins, by its path; a root file builds everything", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const report = (
      await gate({ quick: [BUILD] }, runner, { files: { ...files, mvnw: "#!/bin/sh" }, java }).run.execute({
        gate: "quick",
        files: ["pom.xml", "shop-api/src/main/java/a/Api.java"],
      })
    )._unsafeUnwrap();
    expect(report.steps[0]?.command).toEqual(["/repo/mvnw", "-B", "test"]);
  });

  test("on Windows the wrapper is mvnw.cmd (gradlew.bat), by its Windows path; the shell script alone is not run there", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const run = (files: Record<string, string>, step: object, platform = "win32") =>
      gate({ full: [{ ...step, files: "none" }] }, runner, { files, platform })
        .run.execute({ gate: "full" })
        .then((r) => r._unsafeUnwrap().steps[0]?.command);
    const gradle = { id: "test", run: { build: "gradle", args: ["test"] } };
    expect(await run({ mvnw: "", "mvnw.cmd": "" }, BUILD)).toEqual(["/repo\\mvnw.cmd", "-B", "test"]);
    expect(await run({ mvnw: "" }, BUILD)).toEqual(["mvn", "-B", "test"]);
    expect(await run({ gradlew: "", "gradlew.bat": "" }, gradle)).toEqual(["/repo\\gradlew.bat", "test"]);
    // On Linux the same repository runs the shell script, never the Windows one.
    expect(await run({ "mvnw.cmd": "" }, BUILD, "linux")).toEqual(["mvn", "-B", "test"]);
    expect(await run({ gradlew: "", "gradlew.bat": "" }, gradle, "linux")).toEqual(["/repo/gradlew", "test"]);
  });

  test("Gradle: each task in each module's project; no Java file changed: skipped", async () => {
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const step = {
      id: "typecheck",
      run: { build: "gradle", args: ["compileJava", "-q"] },
      files: "modules",
      match: ["**/*.java"],
    };
    const w = gate({ quick: [step] }, runner, {
      files: { "settings.gradle.kts": "", "libs/core/build.gradle.kts": "", "libs/core/src/A.java": "" },
      java: { tools: ["gradle"], modules: [mod("libs:core", "libs/core", "gradle")], notes: [] },
    });
    const one = (await w.run.execute({ gate: "quick", files: ["libs/core/src/A.java"] }))._unsafeUnwrap();
    expect(one.steps[0]?.command).toEqual(["gradle", ":libs:core:compileJava", "-q"]);
    const none = (await w.run.execute({ gate: "quick", files: ["settings.gradle.kts"] }))._unsafeUnwrap();
    expect(none.steps[0]).toMatchObject({ status: "skipped", detail: "no files this step checks" });
    // Without the Java build read, a changed file builds the whole build: never less than asked.
    const unread = gate({ quick: [step] }, runner, { files: { "libs/core/src/A.java": "" } });
    const whole = (
      await unread.run.execute({ gate: "quick", files: ["libs/core/src/A.java"] })
    )._unsafeUnwrap();
    expect(whole.steps[0]?.command).toEqual(["gradle", "compileJava", "-q"]);
  });

  test("the full gate builds everything; a red build fails the step with its output", async () => {
    const runner = new ScriptedProcessRunner([
      { argvPrefix: [], result: { exitCode: 1, stdout: "[ERROR] COMPILATION ERROR" } },
    ]);
    const full = { ...BUILD, files: "none" };
    const report = (
      await gate({ full: [full] }, runner, { files }).run.execute({ gate: "full" })
    )._unsafeUnwrap();
    expect(report.steps[0]).toMatchObject({
      command: ["mvn", "-B", "test"],
      status: "fail",
      detail: expect.stringContaining("COMPILATION ERROR"),
    });
  });
});
