import { z } from "zod";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * The persisted run (`.metator/runs/<id>/state.json`). Validated on every load: a hand-edited
 * or corrupted state file is reported, never trusted.
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

export const RunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().regex(/^\d{8}-[a-z0-9-]+$/),
    workflow: z.object({ id: z.string(), version: z.number().int(), source: z.string() }).strict(),
    task: z.string().min(1),
    autonomy: AutonomySchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    state: RunStateSchema,
  })
  .strict();

export type RunRecord = z.infer<typeof RunRecordSchema>;

export function parseRunRecord(text: string, source: string): Result<RunRecord, MetatorError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return err(new MetatorError("INVALID_ARTIFACT", `${source} is not valid JSON: ${(e as Error).message}`));
  }
  const parsed = RunRecordSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  return err(
    new MetatorError("INVALID_ARTIFACT", `${source} does not match the run schema`, {
      hint: "Do not edit state.json by hand; use `metator run advance`.",
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    }),
  );
}
