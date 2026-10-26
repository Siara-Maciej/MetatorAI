import { describe, expect, test } from "bun:test";
import { DiffCoverage } from "../src/application/coverage.ts";
import { DEFAULT_TEST_GLOBS } from "../src/application/paths.ts";
import { coverageDiff } from "../src/domain/coverage.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { CoverageReader } from "../src/ports/index.ts";

const CODE = ["**/*.ts"];
const hits = (entries: Record<string, Record<number, number>>) =>
  new Map(
    Object.entries(entries).map(([f, l]) => [f, new Map(Object.entries(l).map(([k, v]) => [Number(k), v]))]),
  );

describe("coverageDiff", () => {
  test("only instrumented added lines count; uncovered ones are listed per file", () => {
    const d = coverageDiff(
      new Map([
        ["src/a.ts", [1, 2, 3, 4]],
        ["src/b.ts", [10]],
      ]),
      hits({ "src/a.ts": { 1: 3, 2: 0, 4: 1, 9: 0 }, "src/b.ts": { 10: 0 } }),
      { code: CODE, ignore: [] },
    );
    expect(d).toEqual({
      instrumented: 4,
      covered: 2,
      percent: 50,
      files: [
        { file: "src/a.ts", covered: 2, uncovered: [2] },
        { file: "src/b.ts", covered: 0, uncovered: [10] },
      ],
      unmeasured: [],
    });
  });

  test("files the report never loaded are unmeasured; non-code and ignored files do not count", () => {
    const d = coverageDiff(
      new Map([
        ["src/new.ts", [1]],
        ["README.md", [1]],
        ["src/a.test.ts", [1]],
      ]),
      hits({}),
      { code: CODE, ignore: DEFAULT_TEST_GLOBS },
    );
    expect([d.unmeasured, d.percent, d.instrumented]).toEqual([["src/new.ts"], 100, 0]);
  });

  test("percent rounds down to one decimal", () => {
    const d = coverageDiff(new Map([["a.ts", [1, 2, 3]]]), hits({ "a.ts": { 1: 1, 2: 1, 3: 0 } }), {
      code: CODE,
      ignore: [],
    });
    expect(d.percent).toBe(66.6);
  });
});

describe("DiffCoverage", () => {
  const added = {
    addedLines: async () =>
      ok(
        new Map([
          ["src/a.ts", [1, 2]],
          ["src/a.test.ts", [1]],
        ]) as ReadonlyMap<string, readonly number[]>,
      ),
  };
  const reader = (r: Record<string, Record<number, number>>): CoverageReader & { reports: string[] } => {
    const reports: string[] = [];
    return {
      reports,
      read: async (report) => {
        reports.push(report);
        return ok(hits(r));
      },
    };
  };

  test("reads the default LCOV report unless told otherwise", async () => {
    // The test file's line is uncovered in the report, but tests are not measured code.
    const r = reader({ "src/a.ts": { 1: 1, 2: 1 }, "src/a.test.ts": { 1: 0 } });
    const d = (
      await new DiffCoverage(added, r, DEFAULT_TEST_GLOBS).execute({ base: "main" })
    )._unsafeUnwrap();
    expect([d.percent, d.report, r.reports]).toEqual([100, "coverage/lcov.info", ["coverage/lcov.info"]]);
    await new DiffCoverage(added, r, DEFAULT_TEST_GLOBS).execute({ base: "main", lcov: "out/x.info" });
    expect(r.reports).toEqual(["coverage/lcov.info", "out/x.info"]);
  });

  test("git and report errors are values", async () => {
    const failingGit = { addedLines: async () => err(MetatorError.usage("Unknown base ref")) };
    expect(
      (await new DiffCoverage(failingGit, reader({}), []).execute({ base: "x" }))._unsafeUnwrapErr().code,
    ).toBe("USAGE");
    const missing: CoverageReader = { read: async () => err(new MetatorError("NOT_FOUND", "no report")) };
    expect((await new DiffCoverage(added, missing, []).execute({ base: "x" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });
});
