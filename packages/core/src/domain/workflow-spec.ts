import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Workflow spec: the declarative state machine behind every run (docs/design/02-workflows.md).
 * The zod schema is the single source of truth for the TypeScript type, validation and the
 * JSON Schema handed to agents (ADR-0015).
 */

const TERMINAL_STATES = ["done", "escalated", "aborted"] as const;
const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "use lowercase letters, digits and dashes");

export const StageSpecSchema = z
  .object({
    id,
    description: z.string().optional(),
    hitl: z.boolean().optional().describe("Human-in-the-loop gate: only APPROVE moves on"),
    onFail: z
      .object({ goto: id, loop: id })
      .strict()
      .optional()
      .describe("On FAIL go back to `goto`, counting against loops[loop]; escalate when exhausted"),
  })
  .strict();

export const WorkflowSpecSchema = z
  .object({
    id,
    revision: z
      .number()
      .int()
      .positive()
      .default(1)
      .describe("Revision of this workflow's content (not the file format)"),
    description: z.string().optional(),
    stages: z.array(StageSpecSchema).min(1, "a workflow needs at least one stage"),
    loops: z.record(id, z.number().int().min(0)).default({}),
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
 * Workflow files are versioned documents (ADR-0016):
 *   kind: Workflow
 *   schemaVersion: 1
 */
export const WorkflowDocument = defineDocument("Workflow", {
  latest: WorkflowSpecSchema,
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
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return err(
      new MetatorError("INVALID_CONFIG", `Invalid YAML in ${source}: ${(e as Error).message}`, {
        details: { source },
      }),
    );
  }
  return WorkflowDocument.parse(raw, source);
}

export function workflowJsonSchema(): Record<string, unknown> {
  return WorkflowDocument.jsonSchema("input");
}
