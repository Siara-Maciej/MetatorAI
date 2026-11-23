/**
 * The README's live badges (scripts/badges.ts) end to end: the parsers that read CI's outputs (an
 * LCOV report, `bun test`'s summary, the mutation smoke's total), the colours, the check of what
 * Pages publishes, and the script itself run as CI and the docs workflow run it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  type Badge,
  bunSummary,
  coverageBadge,
  coverageColor,
  isSourceFile,
  lcovTotal,
  mutationBadge,
  mutationTotalLine,
  mutationTotals,
  outcome,
  publishable,
  suite,
  testsBadge,
} from "../scripts/badges.ts";

const ROOT = join(import.meta.dir, "..");
const ESC = String.fromCharCode(27);

const LCOV = [
  "TN:",
  "SF:packages/core/src/a.ts",
  "FNF:1",
  "FNH:1",
  "DA:1,1",
  "LF:10",
  "LH:9",
  "end_of_record",
  "TN:",
  "SF:packages/core/src/b.ts",
  "LF:30",
  "LH:15",
  "end_of_record",
  "SF:packages/core/test/a.test.ts",
  "LF:100",
  "LH:100",
  "end_of_record",
  "",
].join("\n");

/** What `bun test` prints at the end of a run (bun 1.4.4), here with the colours CI may add. */
const BUN_OK = [
  "bun test v1.4.4 (38afee6c8)",
  "(pass) a > b [1.00ms]",
  "",
  ` ${ESC}[32m2587 pass${ESC}[0m`,
  " 3 skip",
  ` ${ESC}[2m0 fail${ESC}[0m`,
  " 4 snapshots, 12865 expect() calls",
  "Ran 2590 tests across 261 files. [45.46s]",
].join("\n");

const BUN_FAILED = [" 570 pass", " 6 fail", " 1 error", " 1200 expect() calls", "Ran 577 tests"].join("\n");

const color = (b: Badge) => b.color;

describe("parsers", () => {
  test("lcovTotal sums LH and LF over the source records and leaves test files out", () => {
    expect(lcovTotal(LCOV)).toEqual({ hit: 24, found: 40 });
    expect(lcovTotal(LCOV, () => true)).toEqual({ hit: 124, found: 140 });
    // A record cut off before end_of_record does not count; nothing counted is no total.
    expect(lcovTotal("SF:a.ts\nLF:10\nLH:10\n")).toBeUndefined();
    expect(lcovTotal("")).toBeUndefined();
    expect(lcovTotal("SF:a.ts\nLF:0\nLH:0\nend_of_record\n")).toBeUndefined();
    // A path with a colon in it (a Windows drive) is still one path.
    expect(lcovTotal("SF:C:\\r\\a.ts\r\nLF:4\r\nLH:1\r\nend_of_record\r\n")).toEqual({ hit: 1, found: 4 });
    expect([
      isSourceFile("packages/x/src/a.ts"),
      isSourceFile("src/a.test.tsx"),
      isSourceFile("x/test/h.ts"),
    ]).toEqual([true, false, false]);
  });

  test("bunSummary reads the pass and fail counts; an error outside a test is a failure", () => {
    expect(bunSummary(BUN_OK)).toEqual({ pass: 2587, fail: 0 });
    expect(bunSummary(BUN_FAILED)).toEqual({ pass: 570, fail: 7 });
    // A run that never got to its summary has none; per-test lines are not a summary.
    expect(bunSummary("bun test v1.4.4\n(pass) a [1ms]\n(fail) b [2ms]\n")).toBeUndefined();
    expect(bunSummary("")).toBeUndefined();
  });

  test("mutationTotals reads the smoke's total line, else counts its lines", () => {
    const line = mutationTotalLine({ killed: 1590, survived: 2, stale: 1, total: 1593 });
    expect(line).toBe("TOTAL    1590 killed, 2 survived, 1 stale of 1593 mutants");
    expect(mutationTotals(`KILLED  a.ts: x\nSURVIVED b.ts: y\n\n${line}\n`)).toEqual({
      killed: 1590,
      survived: 2,
      stale: 1,
      total: 1593,
    });
    // A run cut short has no total: what it got through is counted, the total stays unknown.
    expect(
      mutationTotals("STALE   c.ts: gone\nKILLED  a.ts: x\nKILLED  a.ts: y\nSURVIVED b.ts: z\n"),
    ).toEqual({
      killed: 2,
      survived: 1,
      stale: 1,
      total: undefined,
    });
    expect(mutationTotals("BROKEN  the unmutated suite fails\n")).toBeUndefined();
  });

  test("outcome takes only an Actions step outcome", () => {
    expect([outcome("success"), outcome("failure"), outcome("skipped"), outcome("cancelled")]).toEqual([
      "success",
      "failure",
      "skipped",
      "cancelled",
    ]);
    expect([outcome(""), outcome("passed"), outcome(undefined)]).toEqual([undefined, undefined, undefined]);
  });
});

describe("badges", () => {
  test("coverage colours step at 90, 80, 70, 60 and 50 percent", () => {
    const at = [100, 90, 89.99, 80, 79.99, 70, 69.99, 60, 59.99, 50, 49.99, 0].map(coverageColor);
    expect(at).toEqual([
      "brightgreen",
      "brightgreen",
      "green",
      "green",
      "yellowgreen",
      "yellowgreen",
      "yellow",
      "yellow",
      "orange",
      "orange",
      "red",
      "red",
    ]);
  });

  test("the coverage badge rounds down and says unknown without a report", () => {
    expect(coverageBadge({ hit: 8996, found: 10000 })).toEqual({
      schemaVersion: 1,
      label: "coverage",
      message: "89%",
      color: "green",
    });
    expect(coverageBadge({ hit: 1, found: 1 }).message).toBe("100%");
    expect(coverageBadge(undefined)).toEqual({
      schemaVersion: 1,
      label: "coverage",
      message: "unknown",
      color: "lightgrey",
    });
  });

  test("the tests badge is green only when both suites ran and nothing failed", () => {
    const passed = testsBadge({
      unit: suite({ pass: 2584, fail: 0 }, "success"),
      e2e: suite({ pass: 576, fail: 0 }, "success"),
    });
    expect(passed).toEqual({
      schemaVersion: 1,
      label: "tests",
      message: "2584 unit · 576 e2e passing",
      color: "brightgreen",
    });
    const failing = testsBadge({
      unit: suite({ pass: 2584, fail: 0 }, "success"),
      e2e: suite({ pass: 570, fail: 6 }, "failure"),
    });
    expect([failing.message, color(failing)]).toEqual(["2584 unit · 570 e2e passing · 6 failing", "red"]);
    // A red step is red even when its output claims nothing failed.
    const red = testsBadge({
      unit: suite({ pass: 2584, fail: 0 }, "failure"),
      e2e: suite(undefined, "skipped"),
    });
    expect([red.message, color(red)]).toEqual(["2584 unit passing · unit failed · e2e not run", "red"]);
    const crashed = testsBadge({ unit: suite(undefined, "failure"), e2e: suite(undefined, "skipped") });
    expect([crashed.message, color(crashed)]).toEqual(["unit failed · e2e not run", "red"]);
    // Nothing failed but a suite did not run: not green.
    const partial = testsBadge({
      unit: suite({ pass: 3, fail: 0 }, "success"),
      e2e: suite(undefined, undefined),
    });
    expect([partial.message, color(partial)]).toEqual(["3 unit passing · e2e not run", "lightgrey"]);
  });

  test("the mutation badge is green only when the run finished and killed every mutant", () => {
    const all = { killed: 1593, survived: 0, stale: 0, total: 1593 };
    expect(mutationBadge(all, "success")).toEqual({
      schemaVersion: 1,
      label: "mutants killed",
      message: "1593/1593",
      color: "brightgreen",
    });
    expect(mutationBadge({ ...all, killed: 1592, survived: 1 }, "failure")).toMatchObject({
      message: "1592/1593",
      color: "red",
    });
    expect(mutationBadge({ ...all, killed: 1592, stale: 1 }, "failure").color).toBe("red");
    // A worker whose copy broke leaves mutants untried: fewer killed than selected.
    expect(mutationBadge({ ...all, killed: 1000 }, "failure")).toMatchObject({
      message: "1000/1593",
      color: "red",
    });
    expect(mutationBadge(all, "failure").color).toBe("red");
    expect(mutationBadge({ killed: 5, survived: 0, stale: 0, total: undefined }, "cancelled")).toMatchObject({
      message: "5/5",
      color: "red",
    });
    expect(mutationBadge(undefined, "failure")).toMatchObject({ message: "failed", color: "red" });
    expect(mutationBadge(undefined, "skipped")).toMatchObject({ message: "not run", color: "lightgrey" });
  });

  test("Pages publishes CI's badge only when it is a well-formed endpoint badge, else pending", () => {
    const good: Badge = {
      schemaVersion: 1,
      label: "tests",
      message: "3 unit · 2 e2e passing",
      color: "brightgreen",
    };
    expect(publishable("tests", JSON.stringify({ ...good, extra: "<script>" }))).toEqual(good);
    expect(publishable("tests", JSON.stringify({ ...good, color: "#a1b2c3" })).color).toBe("#a1b2c3");
    const pending: Badge = { schemaVersion: 1, label: "tests", message: "pending", color: "lightgrey" };
    for (const bad of [
      undefined,
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...good, schemaVersion: 2 }),
      JSON.stringify({ ...good, label: "coverage" }),
      JSON.stringify({ ...good, message: "" }),
      JSON.stringify({ ...good, message: "x".repeat(101) }),
      JSON.stringify({ ...good, color: "red; x" }),
      JSON.stringify({ ...good, color: 5 }),
    ])
      expect([bad, publishable("tests", bad)]).toEqual([bad, pending]);
    expect(publishable("mutation", undefined).label).toBe("mutants killed");
  });
});

describe("the script", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "metator-badges-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    const proc = Bun.spawn(["bun", join(ROOT, "scripts/badges.ts"), ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }
  const json = async (path: string) => JSON.parse(await Bun.file(path).text()) as Badge;

  test("CI's outputs become three endpoint badges in the output directory, and nothing else is written", async () => {
    await Bun.write(join(dir, "in/lcov.info"), LCOV);
    await Bun.write(join(dir, "in/unit.log"), BUN_OK);
    await Bun.write(join(dir, "in/e2e.log"), " 576 pass\n 0 fail\n");
    await Bun.write(
      join(dir, "in/mutation.log"),
      `KILLED  a.ts: x\n\nAll 1 mutants killed.\n${mutationTotalLine({ killed: 1, survived: 0, stale: 0, total: 1 })}\n`,
    );
    const r = await run([
      "--out",
      "out",
      "--lcov",
      "in/lcov.info",
      "--unit",
      "in/unit.log",
      "--unit-outcome",
      "success",
      "--e2e",
      "in/e2e.log",
      "--e2e-outcome",
      "success",
      "--mutation",
      "in/mutation.log",
      "--mutation-outcome",
      "success",
    ]);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["coverage.json", "mutation.json", "tests.json"]);
    expect(await json(join(dir, "out/coverage.json"))).toEqual({
      schemaVersion: 1,
      label: "coverage",
      message: "60%",
      color: "yellow",
    });
    expect(await json(join(dir, "out/tests.json"))).toEqual({
      schemaVersion: 1,
      label: "tests",
      message: "2587 unit · 576 e2e passing",
      color: "brightgreen",
    });
    expect(await json(join(dir, "out/mutation.json"))).toEqual({
      schemaVersion: 1,
      label: "mutants killed",
      message: "1/1",
      color: "brightgreen",
    });
    expect(readdirSync(dir).sort()).toEqual(["in", "out"]);
  });

  test("a job that stopped early still gets badges, and they show it", async () => {
    await Bun.write(join(dir, "red/unit.log"), BUN_FAILED);
    const r = await run([
      "--out",
      "red/out",
      "--lcov",
      "red/missing.info",
      "--unit",
      "red/unit.log",
      "--unit-outcome",
      "failure",
      "--e2e",
      "red/missing.log",
      "--e2e-outcome",
      "skipped",
      "--mutation",
      "red/missing.log",
      "--mutation-outcome",
      "skipped",
    ]);
    expect(r.code).toBe(0);
    expect(await json(join(dir, "red/out/tests.json"))).toMatchObject({
      message: "570 unit passing · 7 failing · e2e not run",
      color: "red",
    });
    expect((await json(join(dir, "red/out/coverage.json"))).message).toBe("unknown");
    expect((await json(join(dir, "red/out/mutation.json"))).message).toBe("not run");
  });

  test("--publish copies well-formed badges and publishes pending for the rest, also with no artifact at all", async () => {
    const none = await run(["--publish", "no-artifact", "--out", "site-none"]);
    expect(none.code).toBe(0);
    for (const [name, label] of [
      ["coverage", "coverage"],
      ["tests", "tests"],
      ["mutation", "mutants killed"],
    ] as const)
      expect(await json(join(dir, `site-none/${name}.json`))).toEqual({
        schemaVersion: 1,
        label,
        message: "pending",
        color: "lightgrey",
      });
    expect(existsSync(join(dir, "no-artifact"))).toBe(false);

    const tests: Badge = {
      schemaVersion: 1,
      label: "tests",
      message: "1 unit · 1 e2e passing",
      color: "brightgreen",
    };
    await Bun.write(join(dir, "artifact/tests.json"), JSON.stringify(tests));
    await Bun.write(join(dir, "artifact/coverage.json"), "{ broken");
    const some = await run(["--publish", "artifact", "--out", "site-some"]);
    expect(some.code).toBe(0);
    expect(await json(join(dir, "site-some/tests.json"))).toEqual(tests);
    expect((await json(join(dir, "site-some/coverage.json"))).message).toBe("pending");
    expect((await json(join(dir, "site-some/mutation.json"))).message).toBe("pending");
  });

  test("without --out the script writes nothing and exits 2", async () => {
    const r = await run(["--unit", "in/unit.log"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--out");
  });
});

describe("the workflows", () => {
  interface Step {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    shell?: string;
    "continue-on-error"?: boolean;
    with?: Record<string, unknown>;
  }
  interface Workflow {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; steps: Step[] }>;
  }
  const workflow = async (name: string) =>
    parse(await Bun.file(join(ROOT, ".github/workflows", name)).text()) as Workflow;
  const MAIN_ONLY = `\${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' }}`;

  test("ci keeps every check, fails a teed step when its command fails, and makes badges on main only", async () => {
    const steps = (await workflow("ci.yml")).jobs.check?.steps ?? [];
    const runs = steps.map((s) => s.run?.trim());
    for (const check of ["bunx biome ci .", "bun run typecheck", "bun run arch", "bun run canon"])
      expect(runs).toContain(check);
    for (const [id, command] of [
      ["unit", "bun run test:unit"],
      ["e2e", "bun run test:e2e"],
      ["mutation", "bun run test:mutation"],
    ]) {
      const step = steps.find((s) => s.id === id);
      // `shell: bash` is bash -eo pipefail: the tee never hides the test command's exit code.
      expect([id, step?.run, step?.shell, step?.if, step?.["continue-on-error"]]).toEqual([
        id,
        `${command} 2>&1 | tee "$RUNNER_TEMP/${id}.log"`,
        "bash",
        undefined,
        undefined,
      ]);
    }
    const checks = steps.slice(0, steps.findIndex((s) => s.id === "mutation") + 1);
    expect(
      checks.filter((s) => s.if !== undefined || s["continue-on-error"] !== undefined).map((s) => s.name),
    ).toEqual([]);
    const badges = steps.slice(checks.length);
    expect(badges.map((s) => s.if)).toEqual([MAIN_ONLY, MAIN_ONLY, MAIN_ONLY]);
    expect(badges[1]?.run).toContain("scripts/badges.ts");
    for (const id of ["unit", "e2e", "mutation"])
      expect(badges[1]?.run).toContain(`--${id}-outcome "\${{ steps.${id}.outcome }}"`);
    expect([badges[2]?.uses, badges[2]?.with?.name]).toEqual(["actions/upload-artifact@v4", "badges"]);
  });

  test("pages publishes the badges of ci on main, pending when there are none", async () => {
    const pages = await workflow("pages.yml");
    expect(pages.on.workflow_run).toEqual({ workflows: ["ci"], types: ["completed"], branches: ["main"] });
    for (const trigger of ["push", "pull_request", "workflow_dispatch"])
      expect(Object.keys(pages.on)).toContain(trigger);
    expect(pages.permissions).toEqual({ contents: "read", actions: "read" });
    const build = pages.jobs.build;
    expect(build?.if).toContain("github.event.workflow_run.event == 'push'");
    const steps = build?.steps ?? [];
    const download = steps.findIndex((s) => s.run?.includes("gh run download"));
    const publish = steps.findIndex((s) => s.run?.includes("scripts/badges.ts --publish"));
    const site = steps.findIndex((s) => s.run === "bun run site:build");
    expect(steps[download]?.["continue-on-error"]).toBe(true);
    expect(steps[publish]?.run).toContain("--out site/public/badges");
    // The publish step runs for every event, so the site always has badges/*.json.
    expect([steps[publish]?.if, download < publish, publish < site]).toEqual([undefined, true, true]);
  });
});
