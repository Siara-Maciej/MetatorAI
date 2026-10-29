import { z } from "zod";
import {
  type SystemAnalysis,
  type SystemPlan,
  type SystemPlanProblem,
  stepDependsOn,
} from "./system-plan.ts";
import { defineDocument } from "./versioned.ts";

/**
 * The golden set of system changes (F7.7, ADR-0072): a system (its map and specifications), a
 * task, and what a good analysis and plan contain: the applications the change reaches, each
 * contract's change, the steps and the order they must keep. Scored by the same tools a plan
 * passes through, with or without the system agents. `docs/metator/evals/system/<id>.yml`.
 */
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const SystemEvalCaseSchema = z.strictObject({
  id,
  description: z.string().optional(),
  task: z.string().min(1),
  /** The repository (the map, specifications, code), committed into a fresh git repository. */
  files: z.record(z.string(), z.string()).refine((f) => Object.keys(f).length > 0, "a case needs files"),
  /** What the task names: contracts it changes, and which of them it breaks. */
  input: z
    .strictObject({
      contracts: z.array(id).optional(),
      breaking: z.array(id).optional(),
    })
    .default({}),
  expect: z.strictObject({
    /** Every application the change reaches, and no other. */
    applications: z.array(id).min(1),
    contracts: z.record(id, z.enum(["breaking", "compatible", "unknown"])).default({}),
    /** Steps a good plan has. */
    steps: z.array(id).default([]),
    /** Pairs [first, then]: `then` must run after `first`. */
    order: z.array(z.tuple([id, id])).default([]),
  }),
});
export type SystemEvalCase = z.output<typeof SystemEvalCaseSchema>;

export const SystemEvalCaseDocument = defineDocument("SystemEvalCase", {
  latest: SystemEvalCaseSchema,
  errorCode: "INVALID_CONFIG",
});

export interface SystemCaseScore {
  readonly id: string;
  readonly plan: string | null;
  /** Share of the expected applications the analysis found. */
  readonly impactRecall: number;
  /** Share of the applications found that were expected. */
  readonly impactPrecision: number;
  /** Share of the expected contract changes the analysis got right. */
  readonly contracts: number;
  readonly lintClean: boolean;
  readonly stepsRecall: number;
  /** Share of the order pairs the plan keeps. */
  readonly order: number;
  readonly passed: boolean;
  /** The mean of the six checks. */
  readonly score: number;
  readonly error?: string;
}

const round = (n: number) => Math.round(n * 100) / 100;
const share = (hit: number, of: number) => (of === 0 ? 1 : hit / of);

/** An analysis and a plan scored against their case. */
export function scoreSystemCase(input: {
  readonly case: SystemEvalCase;
  readonly analysis: SystemAnalysis;
  readonly plan: SystemPlan;
  readonly problems: readonly SystemPlanProblem[];
}): SystemCaseScore {
  const { expect } = input.case;
  const found = new Set(input.analysis.applications.map((a) => a.id));
  const expected = new Set(expect.applications);
  const impactRecall = share([...expected].filter((a) => found.has(a)).length, expected.size);
  const impactPrecision = share([...found].filter((a) => expected.has(a)).length, found.size);
  const changes = Object.entries(expect.contracts);
  const contracts = share(
    changes.filter(([c, change]) => input.analysis.contracts.find((x) => x.id === c)?.change === change)
      .length,
    changes.length,
  );
  const lintClean = !input.problems.some((p) => p.severity === "error");
  const ids = new Set(input.plan.steps.map((s) => s.id));
  const stepsRecall = share(expect.steps.filter((s) => ids.has(s)).length, expect.steps.length);
  const order = share(
    expect.order.filter(
      ([first, then]) => ids.has(first) && ids.has(then) && stepDependsOn(input.plan, then, first),
    ).length,
    expect.order.length,
  );
  const checks = [impactRecall, impactPrecision, contracts, lintClean ? 1 : 0, stepsRecall, order];
  const score = round(checks.reduce((a, b) => a + b, 0) / checks.length);
  return {
    id: input.case.id,
    plan: input.plan.id,
    impactRecall: round(impactRecall),
    impactPrecision: round(impactPrecision),
    contracts: round(contracts),
    lintClean,
    stepsRecall: round(stepsRecall),
    order: round(order),
    passed: score === 1,
    score,
  };
}

/** A case that could not be analyzed or planned at all scores 0. */
export const failedSystemCase = (caseId: string, error: string): SystemCaseScore => ({
  id: caseId,
  plan: null,
  impactRecall: 0,
  impactPrecision: 0,
  contracts: 0,
  lintClean: false,
  stepsRecall: 0,
  order: 0,
  passed: false,
  score: 0,
  error,
});

export function summarizeSystemEval(scores: readonly SystemCaseScore[]): {
  readonly cases: number;
  readonly passed: number;
  readonly score: number;
  /** The mean impact recall: the pilot's exit is at least 0.95 (design/08 §5). */
  readonly impactRecall: number;
} {
  const mean = (f: (s: SystemCaseScore) => number) =>
    scores.length === 0 ? 0 : round(scores.reduce((a, s) => a + f(s), 0) / scores.length);
  return {
    cases: scores.length,
    passed: scores.filter((s) => s.passed).length,
    score: mean((s) => s.score),
    impactRecall: mean((s) => s.impactRecall),
  };
}
