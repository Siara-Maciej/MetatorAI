import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem, ScriptedProcessRunner } from "@metator/testing";
import { stringify } from "yaml";
import { CompareEvals, EvalCatalog, RunEvals, ScoreEvals } from "../src/application/evals.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import {
  type EvalCase,
  EvalCaseDocument,
  EvalReportDocument,
  regressions,
  scoreCase,
  totals,
} from "../src/domain/eval.ts";
import { type Finding, FindingSetDocument } from "../src/domain/finding.ts";
import { judge, VerdictDocument } from "../src/domain/verdict.ts";
import type { ResolvedCommand } from "../src/ports/index.ts";

const f = (file: string, line: number, extra: Partial<Finding> = {}): Finding => ({
  id: `LOGIC-${String(line).padStart(3, "0")}`,
  lens: "logic",
  severity: "blocking",
  confidence: 0.9,
  location: { file, line },
  quote: "x",
  claim: "a claim that is long enough",
  verification: { status: "confirmed", by: "v", evidence: "test" },
  ...extra,
});

const BUG: EvalCase = EvalCaseDocument.parse(
  {
    kind: "EvalCase",
    schemaVersion: 1,
    id: "rate-undefined",
    type: "bug",
    base: "a1",
    head: "b2",
    expected: [{ file: "src/pay.ts", line: 10, lens: "logic" }],
  },
  "x",
)._unsafeUnwrap();
const CLEAN: EvalCase = EvalCaseDocument.parse(
  { kind: "EvalCase", schemaVersion: 1, id: "clean-rename", type: "clean", base: "a", head: "b" },
  "x",
)._unsafeUnwrap();

describe("scoreCase / totals", () => {
  test("a finding within the tolerance is a true positive; others are false positives; missed ones false negatives", () => {
    expect(scoreCase(BUG, [f("src/pay.ts", 12), f("src/other.ts", 1)], 1, "CHANGES_REQUIRED")).toMatchObject({
      tp: 1,
      fp: 1,
      fn: 0,
      blocking: 2,
      blockingTrue: 1,
    });
    expect(scoreCase(BUG, [f("src/pay.ts", 20)], 1, "x")).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(scoreCase(BUG, [f("src/pay.ts", 10, { lens: "tests" })], 1, "x").tp).toBe(0); // wrong lens
    expect(scoreCase(BUG, [f("src/pay.ts", 10, { lens: "tests", alsoFrom: ["logic"] })], 1, "x").tp).toBe(1);
  });

  test("one expected finding matches once; refuted findings do not count", () => {
    expect(scoreCase(BUG, [f("src/pay.ts", 10), f("src/pay.ts", 11)], 1, "x")).toMatchObject({
      tp: 1,
      fp: 1,
    });
    expect(
      scoreCase(
        BUG,
        [f("src/pay.ts", 10, { verification: { status: "refuted", by: "v", evidence: "guard" } })],
        1,
        "x",
      ),
    ).toMatchObject({ tp: 0, fn: 1 });
  });

  test("totals: precision, recall, blocking precision, false blocks on clean cases, decision variance", () => {
    const t = totals([
      scoreCase(BUG, [f("src/pay.ts", 10)], 1, "CHANGES_REQUIRED"),
      scoreCase(BUG, [], 2, "APPROVED"),
      scoreCase(CLEAN, [f("src/x.ts", 1)], 1, "CHANGES_REQUIRED"),
    ]);
    expect(t).toEqual({
      precision: 0.5,
      recall: 0.5,
      blockingPrecision: 0.5,
      falseBlocks: 1,
      decisionVariance: 0.5,
    });
  });

  test("regressions beyond the tolerance; more false blocks always regress", () => {
    const base = {
      precision: 0.9,
      recall: 0.6,
      blockingPrecision: 0.85,
      falseBlocks: 0,
      decisionVariance: 0.1,
    };
    expect(regressions(base, { ...base, precision: 0.89 }, 0.02)).toEqual([]);
    expect(regressions(base, { ...base, recall: 0.5, falseBlocks: 1 }, 0.02)).toEqual([
      "recall 0.6 → 0.5",
      "falseBlocks 0 → 1",
    ]);
  });

  test("a clean case cannot expect findings", () => {
    expect(
      EvalCaseDocument.parse(
        {
          kind: "EvalCase",
          schemaVersion: 1,
          id: "c",
          type: "clean",
          base: "a",
          head: "b",
          expected: [{ file: "a", line: 1 }],
        },
        "x",
      ).isErr(),
    ).toBe(true);
  });
});

const caseFile = (c: object) => stringify({ kind: "EvalCase", schemaVersion: 1, ...c });
const out = (findings: Finding[]) => ({
  merged: JSON.stringify(FindingSetDocument.stamp({ lens: "merged", findings })),
  verdict: JSON.stringify(VerdictDocument.stamp(judge(findings))),
});

describe("ScoreEvals / CompareEvals", () => {
  test("scores every case and run from the runs directory; missing outputs are listed", async () => {
    const run1 = out([f("src/pay.ts", 10)]);
    const fs = new InMemoryFileSystem({
      "docs/metator/evals/golden/rate.yml": caseFile({
        id: "rate-undefined",
        type: "bug",
        base: "a",
        head: "b",
        expected: [{ file: "src/pay.ts", line: 10 }],
      }),
      "docs/metator/evals/golden/clean.yml": caseFile({
        id: "clean-rename",
        type: "clean",
        base: "a",
        head: "b",
      }),
      ".metator/evals/rate-undefined/1/findings/merged.json": run1.merged,
      ".metator/evals/rate-undefined/1/verdict.json": run1.verdict,
      ".metator/evals/rate-undefined/2/log.txt": "crashed",
    });
    const report = (
      await new ScoreEvals(new EvalCatalog(fs, DEFAULT_PATHS), fs).execute({ runsDir: ".metator/evals" })
    )._unsafeUnwrap();
    expect([report.cases, report.runs, report.missing]).toEqual([
      2,
      1,
      ["clean-rename/*", "rate-undefined/2"],
    ]);
    expect(report.totals).toMatchObject({ precision: 1, recall: 1 });
    const saved = JSON.parse((await fs.read(".metator/evals/report.json"))._unsafeUnwrap());
    expect(saved.kind).toBe("EvalReport");
  });

  test("compare finds regressions between two reports", async () => {
    const report = (t: object) =>
      JSON.stringify(
        EvalReportDocument.stamp({ cases: 1, runs: 1, totals: t as never, scores: [], missing: [] }),
      );
    const base = { precision: 0.9, recall: 0.6, blockingPrecision: 0.9, falseBlocks: 0, decisionVariance: 0 };
    const fs = new InMemoryFileSystem({
      "a.json": report(base),
      "b.json": report({ ...base, precision: 0.7 }),
    });
    expect(
      (
        await new CompareEvals(fs).execute({ before: "a.json", after: "b.json", tolerance: 0.02 })
      )._unsafeUnwrap().regressions,
    ).toEqual(["precision 0.9 → 0.7"]);
  });

  test("an empty golden set says how to start one", async () => {
    const fs = new InMemoryFileSystem({});
    expect(
      (
        await new ScoreEvals(new EvalCatalog(fs, DEFAULT_PATHS), fs).execute({ runsDir: "x" })
      )._unsafeUnwrapErr().hint,
    ).toContain("docs/metator/evals/golden");
  });
});

describe("RunEvals", () => {
  const bins = {
    command: async (bin: string, args: readonly string[]): Promise<ResolvedCommand> => ({
      argv: [bin, ...args],
      cwd: "/repo",
    }),
  };

  test("fills placeholders per case and repeat, passes env, never uses a shell", async () => {
    const fs = new InMemoryFileSystem({
      "docs/metator/evals/golden/rate.yml": caseFile({
        id: "rate",
        type: "bug",
        base: "a1",
        head: "b2",
        expected: [{ file: "x", line: 1 }],
      }),
    });
    const runner = new ScriptedProcessRunner([{ argvPrefix: [], result: { exitCode: 0 } }]);
    const result = (
      await new RunEvals(new EvalCatalog(fs, DEFAULT_PATHS), bins, runner).execute({
        command: "review.sh {case} {base}..{head} --out '{out}'",
        runsDir: "runs",
        repeat: 2,
        timeoutMs: 1000,
      })
    )._unsafeUnwrap();
    expect(runner.calls.map((c) => c.argv)).toEqual([
      ["review.sh", "rate", "a1..b2", "--out", "runs/rate/1"],
      ["review.sh", "rate", "a1..b2", "--out", "runs/rate/2"],
    ]);
    expect(runner.calls[0]?.env).toEqual({
      METATOR_EVAL_CASE: "rate",
      METATOR_EVAL_BASE: "a1",
      METATOR_EVAL_HEAD: "b2",
      METATOR_EVAL_OUT: "runs/rate/1",
    });
    expect(result.runs).toHaveLength(2);
  });

  test("shell operators are refused", async () => {
    const fs = new InMemoryFileSystem({
      "docs/metator/evals/golden/rate.yml": caseFile({ id: "rate", type: "clean", base: "a", head: "b" }),
    });
    const run = new RunEvals(new EvalCatalog(fs, DEFAULT_PATHS), bins, new ScriptedProcessRunner([]));
    expect(
      (
        await run.execute({ command: "review.sh {case} | tee log", runsDir: "r", repeat: 1, timeoutMs: 1 })
      )._unsafeUnwrapErr().code,
    ).toBe("USAGE");
  });
});
