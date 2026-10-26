import { z } from "zod";
import { type Finding, LENSES, SEVERITIES } from "./finding.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Review evals (ADR-0033): a golden set of changes with the findings a good review must report
 * (and clean changes it must not block), scored for precision and recall. Prompts are code:
 * a change to agents must not make the scores worse.
 */
export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** bug: a real bug (hotfix, revert); seeded: a mutation planted on purpose; clean: nothing to find. */
  type: z.enum(["bug", "seeded", "clean"]),
  base: z.string().min(1),
  head: z.string().min(1),
  description: z.string().optional(),
  expected: z
    .array(
      z.strictObject({
        file: z.string().min(1),
        line: z.number().int().positive(),
        /** How far the reported line may be from the expected one. */
        tolerance: z.number().int().min(0).default(3),
        lens: z.enum(LENSES).optional(),
        severity: z.enum(SEVERITIES).default("blocking"),
        note: z.string().optional(),
      }),
    )
    .default([]),
});
export type EvalCase = z.output<typeof EvalCaseSchema>;

export const EvalCaseDocument = defineDocument("EvalCase", {
  latest: EvalCaseSchema.refine(
    (c) => c.type !== "clean" || c.expected.length === 0,
    "a clean case expects no findings",
  ),
  errorCode: "INVALID_CONFIG",
});

export interface CaseScore {
  readonly id: string;
  readonly type: EvalCase["type"];
  readonly run: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Predicted confirmed blockers, and how many of them match an expected blocker. */
  readonly blocking: number;
  readonly blockingTrue: number;
  readonly decision: string;
}

/** Matches one run's findings to a case: each expected finding is matched at most once. */
export function scoreCase(
  c: EvalCase,
  findings: readonly Finding[],
  run: number,
  decision: string,
): CaseScore {
  const reported = findings.filter((f) => f.verification?.status !== "refuted");
  const used = new Set<number>();
  let tp = 0;
  const matchedReport = new Set<number>();
  reported.forEach((f, i) => {
    const j = c.expected.findIndex(
      (e, k) =>
        !used.has(k) &&
        e.file === f.location.file &&
        Math.abs(e.line - f.location.line) <= e.tolerance &&
        (e.lens === undefined || e.lens === f.lens || (f.alsoFrom ?? []).includes(e.lens)),
    );
    if (j >= 0) {
      used.add(j);
      matchedReport.add(i);
      tp++;
    }
  });
  const isBlocking = (f: Finding) => f.severity === "blocking" && f.verification?.status === "confirmed";
  const blocking = reported.filter(isBlocking).length;
  const blockingTrue = reported.filter((f, i) => isBlocking(f) && matchedReport.has(i)).length;
  return {
    id: c.id,
    type: c.type,
    run,
    tp,
    fp: reported.length - tp,
    fn: c.expected.length - tp,
    blocking,
    blockingTrue,
    decision,
  };
}

export interface EvalTotals {
  readonly precision: number;
  readonly recall: number;
  /** Of the confirmed blockers reported, the share that were real (the number humans feel). */
  readonly blockingPrecision: number;
  /** Clean cases the review wrongly blocked. */
  readonly falseBlocks: number;
  /** Share of cases whose decision differed between repeated runs. */
  readonly decisionVariance: number;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : Math.round((a / b) * 1000) / 1000);

export function totals(scores: readonly CaseScore[]): EvalTotals {
  const sum = (k: "tp" | "fp" | "fn" | "blocking" | "blockingTrue") => scores.reduce((n, s) => n + s[k], 0);
  const byCase = new Map<string, Set<string>>();
  for (const s of scores) byCase.set(s.id, (byCase.get(s.id) ?? new Set()).add(s.decision));
  const unstable = [...byCase.values()].filter((d) => d.size > 1).length;
  return {
    precision: ratio(sum("tp"), sum("tp") + sum("fp")),
    recall: ratio(sum("tp"), sum("tp") + sum("fn")),
    blockingPrecision: ratio(sum("blockingTrue"), sum("blocking")),
    falseBlocks: scores.filter((s) => s.type === "clean" && s.decision === "CHANGES_REQUIRED").length,
    decisionVariance: ratio(unstable, byCase.size),
  };
}

export const EvalReportDocument = defineDocument("EvalReport", {
  latest: z.strictObject({
    cases: z.number().int(),
    runs: z.number().int(),
    totals: z.strictObject({
      precision: z.number(),
      recall: z.number(),
      blockingPrecision: z.number(),
      falseBlocks: z.number().int(),
      decisionVariance: z.number(),
    }),
    scores: z.array(
      z.strictObject({
        id: z.string(),
        type: z.enum(["bug", "seeded", "clean"]),
        run: z.number().int(),
        tp: z.number().int(),
        fp: z.number().int(),
        fn: z.number().int(),
        blocking: z.number().int(),
        blockingTrue: z.number().int(),
        decision: z.string(),
      }),
    ),
    missing: z.array(z.string()),
  }),
});

/** A drop beyond the tolerance in any headline number is a regression. */
export function regressions(before: EvalTotals, after: EvalTotals, tolerance: number): string[] {
  const out: string[] = [];
  for (const k of ["precision", "recall", "blockingPrecision"] as const) {
    if (after[k] < before[k] - tolerance) out.push(`${k} ${before[k]} → ${after[k]}`);
  }
  if (after.falseBlocks > before.falseBlocks)
    out.push(`falseBlocks ${before.falseBlocks} → ${after.falseBlocks}`);
  if (after.decisionVariance > before.decisionVariance + tolerance) {
    out.push(`decisionVariance ${before.decisionVariance} → ${after.decisionVariance}`);
  }
  return out;
}
