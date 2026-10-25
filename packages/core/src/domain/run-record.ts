import { z } from "zod";
import type { MetatorError } from "./errors.ts";
import type { Result } from "./result.ts";
import { defineDocument, parseJsonDocument } from "./versioned.ts";

/**
 * Run documents (ADR-0016). All carry `kind` + `schemaVersion`; all are validated on read.
 *   RunRecord  · .metator/runs/<id>/state.json   (JSON)
 *   RunPointer · .metator/runs/latest.json        (JSON)
 *   RunLog     · .metator/runs/<id>/log.md        (Markdown with YAML front matter)
 */
const HistorySchema = z
  .object({
    stage: z.string(),
    event: z.enum(["PASS", "FAIL", "APPROVE", "ABORT"]),
    detail: z.string().optional(),
  })
  .strict();

export const RunStateSchema = z
  .object({
    workflow: z.string(),
    stage: z.string(),
    status: z.enum(["active", "done", "escalated", "aborted"]),
    context: z
      .object({ loops: z.record(z.string(), z.number().int().min(0)), history: z.array(HistorySchema) })
      .strict(),
  })
  .strict();

/** JSON-serializable run state produced by RunStateMachine. Types derive from the schema (DRY). */
export type RunState = z.infer<typeof RunStateSchema>;
export type RunContext = RunState["context"];
export type RunHistoryEntry = RunContext["history"][number];
export type RunStatus = RunState["status"];

export const AutonomySchema = z.enum(["L0", "L1", "L2"]);
export type Autonomy = z.infer<typeof AutonomySchema>;

const RUN_ID = /^\d{8}-[a-z0-9-]+$/;

export const RunRecordSchema = z
  .object({
    runId: z.string().regex(RUN_ID),
    workflow: z.object({ id: z.string(), revision: z.number().int(), source: z.string() }).strict(),
    task: z.string().min(1),
    autonomy: AutonomySchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    state: RunStateSchema,
  })
  .strict();

export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunRecordDocument = defineDocument("RunRecord", {
  latest: RunRecordSchema,
  hint: "Do not edit state.json by hand; use `metator run advance`.",
});

export const RunPointerDocument = defineDocument("RunPointer", {
  latest: z.object({ runId: z.string().regex(RUN_ID) }).strict(),
});

export const RunLogDocument = defineDocument("RunLog", {
  latest: z.object({ runId: z.string().regex(RUN_ID) }).strict(),
});

export function parseRunRecord(text: string, source: string): Result<RunRecord, MetatorError> {
  return parseJsonDocument(text, source).andThen((raw) => RunRecordDocument.parse(raw, source));
}
