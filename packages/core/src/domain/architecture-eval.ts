import { z } from "zod";
import type { ArchitectureReport } from "./architecture.ts";
import { goalMet, PLAN_GOALS, type RefactorPlan, type RefactorPlanProblem } from "./architecture-plan.ts";
import { defineDocument } from "./versioned.ts";

/**
 * The golden set of refactor planning (H7, ADR-0066): small monorepos with a known architecture
 * problem and what a good plan must fix. Each case is scored by the same deterministic tools the
 * plan itself passes through, so a change to mt-arch-planner (prompt, model) is measured, not
 * guessed. `docs/metator/evals/arch/<id>.yml`.
 */
export const ArchEvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().optional(),
  goal: z.enum(PLAN_GOALS),
  /** The repository, file by file (committed into a fresh git repository for the run). */
  files: z.record(z.string(), z.string()).refine((f) => Object.keys(f).length > 0, "a case needs files"),
  expect: z.strictObject({
    /** Violation ids a good plan fixes. */
    fixed: z.array(z.string().min(1)).min(1),
    /** Violation ids it must not leave or create. */
    forbidden: z.array(z.string().min(1)).default([]),
    /** At most this many moves (a plan that rewrites everything is not a good plan). */
    maxMoves: z.number().int().positive().optional(),
  }),
});
export type ArchEvalCase = z.output<typeof ArchEvalCaseSchema>;

export const ArchEvalCaseDocument = defineDocument("ArchEvalCase", {
  latest: ArchEvalCaseSchema,
  errorCode: "INVALID_CONFIG",
});

export interface ArchCaseScore {
  readonly id: string;
  readonly plan: string | null;
  readonly moves: number;
  readonly lintClean: boolean;
  readonly goalMet: boolean;
  /** Share of the expected fixes the plan makes. */
  readonly recall: number;
  readonly forbidden: readonly string[];
  readonly withinMoves: boolean;
  readonly passed: boolean;
  /** The mean of the five checks above (forbidden counts as 1 when none is hit). */
  readonly score: number;
  readonly error?: string;
}

/** A plan scored against its case: by lint, the plan's own simulation and the expected fixes. */
export function scoreArchCase(input: {
  readonly case: ArchEvalCase;
  readonly plan: RefactorPlan;
  readonly problems: readonly RefactorPlanProblem[];
  readonly before: ArchitectureReport;
  readonly after: ArchitectureReport;
}): ArchCaseScore {
  const c = input.case;
  const lintClean = !input.problems.some((p) => p.severity === "error");
  const met = goalMet(c.goal, input.before.summary, input.after.summary);
  const left = new Set(input.after.violations.filter((v) => !v.exception).map((v) => v.id));
  const recall = c.expect.fixed.filter((id) => !left.has(id)).length / c.expect.fixed.length;
  const forbidden = c.expect.forbidden.filter((id) => left.has(id));
  const withinMoves = c.expect.maxMoves === undefined || input.plan.moves.length <= c.expect.maxMoves;
  const checks = [
    lintClean ? 1 : 0,
    met ? 1 : 0,
    recall,
    forbidden.length === 0 ? 1 : 0,
    withinMoves ? 1 : 0,
  ];
  const score = Math.round((checks.reduce((a, b) => a + b, 0) / checks.length) * 100) / 100;
  return {
    id: c.id,
    plan: input.plan.id,
    moves: input.plan.moves.length,
    lintClean,
    goalMet: met,
    recall: Math.round(recall * 100) / 100,
    forbidden,
    withinMoves,
    passed: score === 1,
    score,
  };
}

/** A case the planner could not plan at all scores 0. */
export const failedArchCase = (id: string, error: string): ArchCaseScore => ({
  id,
  plan: null,
  moves: 0,
  lintClean: false,
  goalMet: false,
  recall: 0,
  forbidden: [],
  withinMoves: false,
  passed: false,
  score: 0,
  error,
});

export function summarizeArchEval(scores: readonly ArchCaseScore[]): {
  readonly cases: number;
  readonly passed: number;
  readonly score: number;
} {
  const total = scores.reduce((s, c) => s + c.score, 0);
  return {
    cases: scores.length,
    passed: scores.filter((c) => c.passed).length,
    score: scores.length === 0 ? 0 : Math.round((total / scores.length) * 100) / 100,
  };
}
