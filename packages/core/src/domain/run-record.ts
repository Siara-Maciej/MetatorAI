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

/** v1: released before approvals were recorded. Never change it (MT-CODE-003). */
const RunRecordV1Schema = z
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
type RunRecordV1 = z.infer<typeof RunRecordV1Schema>;

/** Actions outside the workflow's stages that need a human's approval (checked by `guard pre-tool`). */
export const APPROVAL_ACTIONS = ["push", "comment"] as const;

export const ApprovalSchema = z
  .object({ by: z.string().min(1), choice: z.string().optional(), at: z.iso.datetime() })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

/** v2 adds `approvals`: HITL gates and external actions, keyed by stage id or action. Never change it. */
const RunRecordV2Schema = RunRecordV1Schema.extend({
  approvals: z.record(z.string(), ApprovalSchema),
}).strict();

/**
 * v3 (F8, ADR-0050) adds where and by whom a run is carried out, all optional: the worktree it
 * works in, the AI host and its session (to resume), and the parent and children of linked runs.
 */
export const RunRecordSchema = RunRecordV2Schema.extend({
  worktree: z.strictObject({ id: z.string(), path: z.string(), branch: z.string() }).optional(),
  host: z.string().optional(),
  hostSession: z.string().optional(),
  parent: z.string().regex(RUN_ID).optional(),
  children: z.array(z.string().regex(RUN_ID)).optional(),
}).strict();

export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunRecordDocument = defineDocument("RunRecord", {
  history: [
    { schema: RunRecordV1Schema },
    {
      schema: RunRecordV2Schema,
      // Earlier approvals live only in the history: keep who approved which stage.
      fromPrevious: (previous) => {
        const v1 = previous as RunRecordV1;
        const approvals: Record<string, Approval> = {};
        for (const h of v1.state.context.history)
          if (h.event === "APPROVE") approvals[h.stage] = { by: h.detail ?? "unknown", at: v1.updatedAt };
        return { ...v1, approvals };
      },
    },
  ],
  latest: RunRecordSchema,
  // Every v3 field is optional: a v2 record is a v3 record that ran in place.
  upgrade: (previous) => previous,
  hint: "Do not edit state.json by hand; use `metator run advance` or `metator run approve`.",
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
