import { describe, expect, test } from "bun:test";
import { GateChecks } from "../src/application/gate-checks.ts";
import { parseMetatorStep } from "../src/domain/config.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const fail = async () => err(new MetatorError("INTERNAL", "not expected"));
const rules = (severity: "error" | "warning" | null) => ({
  execute: async (_: unknown) =>
    ok({
      engines: ["ast-grep"],
      files: "all" as const,
      violations: severity
        ? [
            {
              engine: "ast-grep",
              source: "ast-grep",
              file: "a.ts",
              line: 3,
              severity,
              message: "bad",
              canonRuleId: "MT-X-001",
            },
          ]
        : [],
    }),
});
const calls: unknown[] = [];
const tests = (passed: boolean) => ({
  execute: async (input: unknown) => {
    calls.push(input);
    return ok({
      changed: [],
      tests: ["a.test.ts"],
      command: ["bun"],
      exitCode: passed ? 0 : 1,
      passed,
      output: "(fail) adds",
    });
  },
});
const graph = (cycles: string[][], deps: { from: string; to: string; via: string }[] = []) => ({
  execute: async (input: { base: string }) => {
    calls.push(input);
    return ok({
      base: input.base,
      changed: 1,
      added: [],
      removed: [],
      newPackageDependencies: deps,
      newCycles: cycles,
    });
  },
});
const api = (changed: boolean) => ({
  diff: async () =>
    ok({
      package: "p",
      changed,
      addedFiles: [],
      removedFiles: [],
      files: changed ? [{ path: "a.d.ts", added: ["x"], removed: ["y"] }] : [],
    }),
});
const coverage = (percent: number) => ({
  execute: async (input: unknown) => {
    calls.push(input);
    return ok({
      base: "HEAD",
      report: "r",
      instrumented: 4,
      covered: 2,
      percent,
      files: [{ file: "a.ts", covered: 2, uncovered: [3, 4] }],
      unmeasured: [],
    });
  },
});
const step = (text: string) => parseMetatorStep(text) as NonNullable<ReturnType<typeof parseMetatorStep>>;
const none = { execute: fail, diff: fail };

describe("parseMetatorStep", () => {
  test("known checks with their arguments; anything else is undefined", () => {
    expect(parseMetatorStep("api diff @acme/money")).toEqual({ command: "api diff", package: "@acme/money" });
    expect(parseMetatorStep("coverage diff --min 80 --lcov out/l.info")).toEqual({
      command: "coverage diff",
      min: 80,
      lcov: "out/l.info",
    });
    expect(parseMetatorStep("coverage diff")).toEqual({ command: "coverage diff" });
    expect(parseMetatorStep("arch check")).toEqual({ command: "arch check" });
    expect(parseMetatorStep("contract diff")).toEqual({ command: "contract diff" });
    for (const bad of ["rm -rf", "api diff", "coverage diff --min x", "graph diff --base main"])
      expect(parseMetatorStep(bad)).toBeUndefined();
  });
});

describe("GateChecks", () => {
  test("rules check fails only on errors, scoped to the gate's files", async () => {
    const c = (s: "error" | "warning" | null) => new GateChecks(rules(s), none, none, none, none, none);
    expect((await c("error").run(step("rules check"), { files: ["a.ts"] }))._unsafeUnwrap()).toEqual({
      passed: false,
      detail: "a.ts:3 MT-X-001: bad",
    });
    expect((await c("warning").run(step("rules check"), {}))._unsafeUnwrap().passed).toBe(true);
  });

  test("test affected uses the gate's files or base; a red run carries the output", async () => {
    calls.length = 0;
    const red = new GateChecks(none, tests(false), none, none, none, none);
    expect((await red.run(step("test affected"), { files: ["a.ts"] }))._unsafeUnwrap()).toEqual({
      passed: false,
      detail: "(fail) adds",
    });
    await new GateChecks(none, tests(true), none, none, none, none).run(step("test affected"), {
      base: "main",
    });
    expect(calls).toEqual([
      { changed: ["a.ts"], script: "test" },
      { base: "main", script: "test" },
    ]);
  });

  test("graph diff fails on a new cycle; new package dependencies are reported, not failed", async () => {
    const deps = [{ from: "@a/x", to: "@a/y", via: "x.ts → y.ts" }];
    const cyc = await new GateChecks(none, none, graph([["a.ts", "b.ts"]], deps), none, none, none).run(
      step("graph diff"),
      {},
    );
    expect(cyc._unsafeUnwrap()).toEqual({
      passed: false,
      detail: "new cycle: a.ts → b.ts\nnew package dependency @a/x → @a/y (x.ts → y.ts)",
    });
    const coupled = await new GateChecks(none, none, graph([], deps), none, none, none).run(
      step("graph diff"),
      {
        base: "main",
      },
    );
    expect(coupled._unsafeUnwrap()).toEqual({
      passed: true,
      detail: "new package dependency @a/x → @a/y (x.ts → y.ts)",
    });
  });

  test("api diff fails on any change with the lines; coverage diff fails below its minimum", async () => {
    expect(
      (
        await new GateChecks(none, none, none, api(true), none, none).run(step("api diff p"), {})
      )._unsafeUnwrap(),
    ).toEqual({
      passed: false,
      detail: "a.d.ts: - y\na.d.ts: + x",
    });
    expect(
      (
        await new GateChecks(none, none, none, api(false), none, none).run(step("api diff p"), {})
      )._unsafeUnwrap().passed,
    ).toBe(true);
    const low = await new GateChecks(none, none, none, none, coverage(50), none).run(
      step("coverage diff --min 80"),
      {},
    );
    expect(low._unsafeUnwrap()).toEqual({
      passed: false,
      detail: "50% of 4 added line(s) covered\na.ts: uncovered 3, 4",
    });
    const ok80 = await new GateChecks(none, none, none, none, coverage(80), none).run(
      step("coverage diff --min 80 --lcov x.info"),
      {},
    );
    expect(ok80._unsafeUnwrap()).toEqual({ passed: true, detail: "80% of 4 added line(s) covered" });
  });

  test("arch check fails on what the change adds against its base, with the ids", async () => {
    calls.length = 0;
    const arch = (failing: { id: string; message: string }[]) => ({
      execute: async (input: unknown) => {
        calls.push(input);
        return ok({
          base: "main",
          baseline: null,
          summary: {
            packages: 2,
            apps: 0,
            edges: 1,
            cycles: 0,
            errors: 0,
            warnings: 0,
            excepted: 0,
            score: 97,
          },
          added: [],
          failing: failing as never,
          fixed: [],
        });
      },
    });
    const red = await new GateChecks(
      none,
      none,
      none,
      none,
      none,
      arch([{ id: "cycle:a,b", message: "a ⇄ b" }]),
    ).run(step("arch check"), { base: "main" });
    expect(red._unsafeUnwrap()).toEqual({ passed: false, detail: "cycle:a,b: a ⇄ b" });
    const green = await new GateChecks(none, none, none, none, none, arch([])).run(step("arch check"), {});
    expect(green._unsafeUnwrap()).toEqual({
      passed: true,
      detail: "score 97, no new architecture violation",
    });
    expect(calls).toEqual([{ base: "main" }, { base: "HEAD" }]);
  });

  test("contract diff fails on a contract the policy does not allow, with the reason", async () => {
    const entry = (id: string, status: string, allowed: boolean, reason?: string) => ({
      id,
      status,
      allowed,
      ...(reason ? { reason } : {}),
    });
    const contracts = (entries: ReturnType<typeof entry>[]) => ({
      execute: async (input: { base: string }) => {
        calls.length = 0;
        calls.push(input);
        return ok({ map: "m", base: input.base, contracts: entries as never, failing: [], notCompared: [] });
      },
    });
    const red = await new GateChecks(
      none,
      none,
      none,
      none,
      none,
      none,
      contracts([entry("a", "breaking", false, "no"), entry("b", "compatible", true)]),
    ).run(step("contract diff"), { base: "main" });
    expect(red._unsafeUnwrap()).toEqual({ passed: false, detail: "a (breaking): no" });
    expect(calls).toEqual([{ base: "main" }]);
    const green = await new GateChecks(
      none,
      none,
      none,
      none,
      none,
      none,
      contracts([entry("a", "unchanged", true), entry("b", "compatible", true)]),
    ).run(step("contract diff"), {});
    expect(green._unsafeUnwrap()).toEqual({
      passed: true,
      detail: "1 of 2 contract(s) changed, none breaking",
    });
    const missing = await new GateChecks(none, none, none, none, none, none).run(step("contract diff"), {});
    expect(missing._unsafeUnwrap().passed).toBe(false);
  });

  test("a failing check is an error value", async () => {
    const r = await new GateChecks(none, none, none, none, none, none).run(step("graph diff"), {});
    expect(r._unsafeUnwrapErr().message).toBe("not expected");
  });
});
