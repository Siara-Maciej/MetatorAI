import { z } from "zod";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import { defineDocument, parseYamlDocument } from "./versioned.ts";

/**
 * Workflow spec: the declarative state machine behind every run (docs/design/02-workflows.md).
 * The zod schema is the single source of truth for the TypeScript type, validation and the
 * JSON Schema handed to agents (ADR-0015).
 */

const TERMINAL_STATES = ["done", "escalated", "aborted"] as const;
const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "use lowercase letters, digits and dashes");

const stageV1 = {
  id,
  description: z.string().optional(),
  hitl: z.boolean().optional().describe("Human-in-the-loop gate: only APPROVE moves on"),
  onFail: z
    .object({ goto: id, loop: id })
    .strict()
    .optional()
    .describe("On FAIL go back to `goto`, counting against loops[loop]; escalate when exhausted"),
};

/** An owner: a canonical agent id, `skill:<name>` or `script:<command>`. */
const Owner = z
  .string()
  .regex(
    /^([a-z][a-z0-9-]*|skill:[a-z][a-z0-9-]*|script:.+)$/,
    "expected an agent id, skill:<name> or script:<command>",
  );
const AUTONOMY = z.enum(["L0", "L1", "L2"]);

/** v2 anatomy of a stage (02-workflows §1): who owns it, what it produces, how it is gated. */
const stageV2 = {
  ...stageV1,
  owner: z.union([Owner, z.array(Owner).min(1)]).optional(),
  /** Workers that run side by side in this stage. */
  parallel: z.array(Owner).optional(),
  produces: z.array(z.string().min(1)).optional().describe("artifacts in the run directory, e.g. plan.json"),
  gate: z
    .strictObject({ script: z.string().min(1).optional(), llm: id.optional() })
    .optional()
    .describe("script first, then an LLM critic; a human gate is `hitl`"),
  /** Autonomy levels that skip this HITL gate (never for a stage marked `neverSkip`). */
  skipAt: z.array(AUTONOMY).optional(),
  neverSkip: z.boolean().optional(),
  optional: z.boolean().optional(),
};

/** v2 anatomy of a workflow: the 16 sections `workflow lint` requires (02-workflows §1). */
const anatomy = {
  entry: z
    .strictObject({ prompt: z.string().optional(), ci: z.boolean().optional(), cron: z.string().optional() })
    .optional(),
  input: z
    .strictObject({
      oneOf: z.array(z.string()).optional(),
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
  preconditions: z.array(z.string().min(1)).optional(),
  limits: z.strictObject({ parallel: z.number().int().positive() }).optional(),
  escalation: z
    .strictObject({ onLoopExhausted: z.string().min(1), onAmbiguity: z.string().min(1) })
    .optional(),
  autonomy: z.array(AUTONOMY).min(1).optional(),
  permissions: z
    .strictObject({ edit: z.string().min(1), external: z.array(z.string()).default([]) })
    .optional(),
  done: z.array(z.string().min(1)).min(1).optional(),
  recovery: z.array(z.string().min(1)).min(1).optional(),
  resume: z.string().min(1).optional(),
  telemetry: z.array(z.string().min(1)).min(1).optional(),
  report: z.string().min(1).optional(),
};

const workflowFields = {
  id,
  revision: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe("Revision of this workflow's content (not the file format)"),
  description: z.string().optional(),
};
const loops = z.record(id, z.number().int().min(0)).default({});

export const StageSpecSchema = z.object(stageV2).strict();

/** v1 (released): stages with hitl and onFail only. Never change it (MT-CODE-003). */
const WorkflowSpecV1Schema = z
  .object({
    ...workflowFields,
    stages: z.array(z.object(stageV1).strict()).min(1, "a workflow needs at least one stage"),
    loops,
  })
  .strict();

export const WorkflowSpecSchema = z
  .object({
    ...workflowFields,
    stages: z.array(StageSpecSchema).min(1, "a workflow needs at least one stage"),
    loops,
    ...anatomy,
  })
  .strict()
  .superRefine((spec, ctx) => {
    const ids = spec.stages.map((s) => s.id);
    spec.stages.forEach((stage, i) => {
      const at = ["stages", i, "id"];
      if ((TERMINAL_STATES as readonly string[]).includes(stage.id)) {
        ctx.addIssue({ code: "custom", path: at, message: `Stage id "${stage.id}" is reserved` });
      }
      if (ids.indexOf(stage.id) !== i) {
        ctx.addIssue({ code: "custom", path: at, message: `Duplicate stage "${stage.id}"` });
      }
      if (stage.onFail && !ids.includes(stage.onFail.goto)) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", i, "onFail", "goto"],
          message: `Stage "${stage.id}" loops to unknown stage "${stage.onFail.goto}"`,
        });
      }
      if (stage.onFail && spec.loops[stage.onFail.loop] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", i, "onFail", "loop"],
          message: `Stage "${stage.id}" uses undefined loop limit "${stage.onFail.loop}" (add loops.${stage.onFail.loop})`,
        });
      }
    });
  });

export type WorkflowSpec = z.output<typeof WorkflowSpecSchema>;
export type WorkflowSpecInput = z.input<typeof WorkflowSpecSchema>;
export type StageSpec = WorkflowSpec["stages"][number];

export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Workflow files are versioned documents (ADR-0016). v2 (ADR-0042) adds the anatomy sections;
 * they are optional in the schema, so every v1 file is a v2 file, and required by `workflow lint`.
 */
export const WorkflowDocument = defineDocument("Workflow", {
  history: [{ schema: WorkflowSpecV1Schema }],
  latest: WorkflowSpecSchema,
  upgrade: (v1) => v1,
  errorCode: "INVALID_CONFIG",
  hint: "Fix the listed issues; `metator workflow schema` prints the JSON Schema.",
});

/** Validates a workflow body (no header), e.g. a spec built in code. */
export function validateWorkflowSpec(raw: unknown, source = "<inline>"): Result<WorkflowSpec, MetatorError> {
  const parsed = WorkflowSpecSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issues: SpecIssue[] = parsed.error.issues.map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    message: i.message,
  }));
  return err(
    new MetatorError(
      "INVALID_CONFIG",
      `Invalid workflow spec ${source}: ${issues[0]?.message ?? "unknown error"}`,
      {
        hint: "Fix the listed issues; `metator workflow schema` prints the JSON Schema.",
        details: { source, issues },
      },
    ),
  );
}

/** Parses a workflow file: YAML → header (kind, schemaVersion) → versioned schema → spec. */
export function parseWorkflowYaml(text: string, source: string): Result<WorkflowSpec, MetatorError> {
  return parseYamlDocument(text, source).andThen((raw) => WorkflowDocument.parse(raw, source));
}

export function workflowJsonSchema(): Record<string, unknown> {
  return WorkflowDocument.jsonSchema("input");
}
