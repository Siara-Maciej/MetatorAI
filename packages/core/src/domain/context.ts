import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Context artifacts of a run (G2 in 02-workflows): what the scout found the task touches
 * (`analysis.json`) and the exemplars the pattern miner found for what the plan will create
 * (`research.json`). Both are read by the planner and checked by `guard subagent-output`.
 */
export const AnalysisSchema = z.strictObject({
  task: z.string().min(1),
  entryFiles: z
    .array(z.strictObject({ path: z.string().min(1), owners: z.array(z.string()).default([]) }))
    .min(1, "name at least one entry file"),
  packages: z.array(z.string()),
  affected: z.strictObject({ files: z.array(z.string()), tests: z.array(z.string()) }),
  risks: z.array(z.string().min(1)).default([]),
});
export type Analysis = z.output<typeof AnalysisSchema>;

export const AnalysisDocument = defineDocument("Analysis", {
  latest: AnalysisSchema,
  hint: "Written by mt-scout; the format is docs/metator/schemas/Analysis.v1.json.",
});

export const ResearchSchema = z.strictObject({
  exemplars: z.array(
    z.strictObject({
      /** What the plan needs to create, in the planner's words. */
      need: z.string().min(1),
      pattern: z.string().optional(),
      file: z.string().min(1),
      line: z.number().int().positive().optional(),
    }),
  ),
  /** Needs without an exemplar: a new abstraction, which needs an ADR. */
  gaps: z.array(z.string().min(1)).default([]),
});
export type Research = z.output<typeof ResearchSchema>;

export const ResearchDocument = defineDocument("Research", {
  latest: ResearchSchema,
  hint: "Written by mt-pattern-miner; the format is docs/metator/schemas/Research.v1.json.",
});
