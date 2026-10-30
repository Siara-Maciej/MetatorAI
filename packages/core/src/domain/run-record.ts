import { z } from "zod";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
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
 * Never change it.
 */
const RunRecordV3Schema = RunRecordV2Schema.extend({
  worktree: z.strictObject({ id: z.string(), path: z.string(), branch: z.string() }).optional(),
  host: z.string().optional(),
  hostSession: z.string().optional(),
  parent: z.string().regex(RUN_ID).optional(),
  children: z.array(z.string().regex(RUN_ID)).optional(),
}).strict();

/**
 * v4 (F7.6, ADR-0071) adds, optionally, the system plan step a child run carries out: the plan,
 * the step and the application whose repository it runs in.
 */
const RunRecordV4Schema = RunRecordV3Schema.extend({
  system: z
    .strictObject({ plan: z.string().min(1), step: z.string().min(1), app: z.string().min(1) })
    .optional(),
}).strict();

/** An input name a workflow declares (`input.required`, `oneOf`, `optional`): `base`, `task_ref`. */
export const INPUT_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * v5 adds, optionally, the values of the workflow's inputs the run was started with
 * (`run init --input base=main`): its scripts read them as `{base}`. Never change v1–v4.
 */
export const RunRecordSchema = RunRecordV4Schema.extend({
  inputs: z.record(z.string().regex(INPUT_NAME), z.string().min(1)).optional(),
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
    // Every v3 field is optional: a v2 record is a v3 record that ran in place.
    { schema: RunRecordV3Schema, fromPrevious: (previous) => previous },
    // `system` is optional: a v3 record is a v4 record of a run outside any system plan.
    { schema: RunRecordV4Schema, fromPrevious: (previous) => previous },
  ],
  latest: RunRecordSchema,
  // `inputs` is optional: a v4 record is a v5 record started without inputs.
  upgrade: (previous) => previous,
  hint: "Do not edit state.json by hand; use `metator run advance` or `metator run approve`.",
});

export const RunPointerDocument = defineDocument("RunPointer", {
  latest: z.object({ runId: z.string().regex(RUN_ID) }).strict(),
});

export const RunLogDocument = defineDocument("RunLog", {
  latest: z.object({ runId: z.string().regex(RUN_ID) }).strict(),
});

/**
 * A workflow script with the run's inputs filled in: `{name}` is the input's value and
 * `{name|default}` falls back to the default when the run was started without it. A placeholder
 * of an input with neither is an error that says how to start the run.
 */
export function fillInputs(
  script: string,
  inputs: Readonly<Record<string, string>>,
): Result<string, MetatorError> {
  const missing: string[] = [];
  const filled = script.replace(
    /\{([a-z][a-z0-9_]*)(?:\|([^{}]*))?\}/g,
    (whole, name: string, fallback?: string) => {
      if (name === "runDir") return whole; // the drive's own placeholder
      const value = inputs[name] ?? fallback;
      if (value === undefined || value === "") {
        missing.push(name);
        return whole;
      }
      return value;
    },
  );
  return missing.length > 0
    ? err(
        MetatorError.usage(
          `the script needs the input ${missing.map((m) => `\`${m}\``).join(", ")}: ${script}`,
          `Start the run with ${missing.map((m) => `--input ${m}=<value>`).join(" ")}.`,
        ),
      )
    : ok(filled);
}

export function parseRunRecord(text: string, source: string): Result<RunRecord, MetatorError> {
  return parseJsonDocument(text, source).andThen((raw) => RunRecordDocument.parse(raw, source));
}
