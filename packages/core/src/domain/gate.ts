import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/** Result of `metator gate quick|full` (ADR-0029), written to `.metator/gates/<gate>.json`. */
export const GateStepResultSchema = z.strictObject({
  id: z.string(),
  status: z.enum(["pass", "fail", "error", "skipped"]),
  command: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int(),
  /** Why a step was skipped or errored, or the failing tail of its output. */
  detail: z.string().optional(),
});
export type GateStepResult = z.output<typeof GateStepResultSchema>;

export const GateReportSchema = z.strictObject({
  gate: z.enum(["quick", "full"]),
  /** Files the gate was scoped to; null for the whole project. */
  files: z.array(z.string()).nullable(),
  startedAt: z.iso.datetime(),
  passed: z.boolean(),
  steps: z.array(GateStepResultSchema),
});
export type GateReport = z.output<typeof GateReportSchema>;

export const GateReportDocument = defineDocument("GateReport", { latest: GateReportSchema });

/** The last lines of a command's output: enough to act on, bounded for the envelope. */
export function outputTail(text: string, lines = 20, maxChars = 2000): string {
  const tail = text.trimEnd().split("\n").slice(-lines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}
