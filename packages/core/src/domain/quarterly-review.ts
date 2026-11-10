import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * The quarterly review (F6): one document with what the canon, the memory, the docs, the lessons
 * and the evals look like today, so the people who own them decide what to retire, raise or
 * promote. Every number comes from a command a person can run alone.
 */
export const QuarterlyReviewSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  /** Documents and lessons older than this many days are listed as stale. */
  staleDays: z.number().int().positive(),
  rules: z.strictObject({
    active: z.number().int().min(0),
    e1: z.number().int().min(0),
    e1Percent: z.number().min(0).max(100),
    /** Active rules whose applyTo matches no file: candidates to retire. */
    dead: z.array(z.string()),
    e1WithoutTest: z.array(z.string()),
    e1Disabled: z.array(z.string()),
  }),
  memory: z.strictObject({
    items: z.number().int().min(0),
    overBudget: z.array(z.strictObject({ item: z.string(), path: z.string(), over: z.array(z.string()) })),
  }),
  docs: z.strictObject({
    total: z.number().int().min(0),
    stale: z.array(z.strictObject({ path: z.string(), ageDays: z.number().int().min(0) })),
    deadLinks: z.number().int().min(0),
  }),
  lessons: z.strictObject({
    total: z.number().int().min(0),
    /** Lessons older than `staleDays` that no rule of the canon cites: promote or retire. */
    unpromoted: z.array(z.strictObject({ id: z.string(), ageDays: z.number().int().min(0) })),
  }),
  evals: z.union([
    z.strictObject({ status: z.literal("compared"), regressions: z.array(z.string()) }),
    z.strictObject({ status: z.literal("no-baseline"), hint: z.string() }),
  ]),
  /** What the review asks the owners to do, derived from the numbers above. */
  actions: z.array(z.string()),
});
export type QuarterlyReview = z.output<typeof QuarterlyReviewSchema>;

export const QuarterlyReviewDocument = defineDocument("QuarterlyReview", {
  latest: QuarterlyReviewSchema,
  hint: "Written by `metator meta quarterly`.",
});

/** The actions the numbers imply, in the order to take them. */
export function reviewActions(r: Omit<QuarterlyReview, "actions">): string[] {
  const out: string[] = [];
  if (r.rules.dead.length > 0)
    out.push(
      `retire or re-scope ${r.rules.dead.length} rule(s) that apply to no file: ${r.rules.dead.join(", ")}`,
    );
  if (r.rules.e1WithoutTest.length > 0)
    out.push(
      `give a test to ${r.rules.e1WithoutTest.length} tool rule(s): ${r.rules.e1WithoutTest.join(", ")}`,
    );
  if (r.rules.e1Disabled.length > 0)
    out.push(
      `turn on or drop ${r.rules.e1Disabled.length} disabled tool rule(s): ${r.rules.e1Disabled.join(", ")}`,
    );
  if (r.rules.e1Percent < 100)
    out.push(`raise E1 coverage from ${r.rules.e1Percent}%: every rule a tool can decide, a tool decides`);
  if (r.memory.overBudget.length > 0)
    out.push(`shorten or re-tier ${r.memory.overBudget.length} knowledge file(s) over budget`);
  if (r.docs.stale.length > 0)
    out.push(
      `read ${r.docs.stale.length} document(s) untouched for ${r.staleDays}+ days: still true, or drift?`,
    );
  if (r.docs.deadLinks > 0) out.push(`fix ${r.docs.deadLinks} dead link(s)`);
  if (r.lessons.unpromoted.length > 0)
    out.push(
      `promote to a rule or retire ${r.lessons.unpromoted.length} lesson(s) older than ${r.staleDays} days`,
    );
  if (r.evals.status === "compared" && r.evals.regressions.length > 0)
    out.push(`the review evals regressed: ${r.evals.regressions.join("; ")}`);
  if (r.evals.status === "no-baseline")
    out.push("commit an eval baseline so the next quarter compares against it");
  if (out.length === 0) out.push("nothing to retire, raise or promote this quarter");
  return out;
}
