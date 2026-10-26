import { z } from "zod";
import { ApprovalSchema, AutonomySchema, type RunRecord } from "./run-record.ts";
import { defineDocument, renderFrontMatter } from "./versioned.ts";

/**
 * What a run leaves behind (`run handoff|close`): a handoff a colleague resumes from, and a
 * summary with the final telemetry once the run reached a terminal state (01-principles §T3).
 */
const EVENTS = ["PASS", "FAIL", "APPROVE", "ABORT"] as const;

export const RunSummarySchema = z.strictObject({
  runId: z.string(),
  workflow: z.strictObject({ id: z.string(), revision: z.number().int() }),
  task: z.string(),
  autonomy: AutonomySchema,
  status: z.enum(["done", "escalated", "aborted"]),
  stage: z.string(),
  createdAt: z.iso.datetime(),
  closedAt: z.iso.datetime(),
  durationMs: z.number().int().min(0),
  loops: z.record(z.string(), z.number().int().min(0)),
  events: z.strictObject(
    Object.fromEntries(EVENTS.map((e) => [e, z.number().int().min(0)])) as {
      [K in (typeof EVENTS)[number]]: z.ZodNumber;
    },
  ),
  approvals: z.record(z.string(), ApprovalSchema),
  artifacts: z.array(z.string()),
});
export type RunSummary = z.output<typeof RunSummarySchema>;

export const RunSummaryDocument = defineDocument("RunSummary", {
  latest: RunSummarySchema,
  hint: "Written by `metator run close`; do not edit it by hand.",
});

export const RunHandoffDocument = defineDocument("RunHandoff", {
  latest: z.strictObject({ runId: z.string(), writtenAt: z.iso.datetime() }),
});

export type TerminalStatus = RunSummary["status"];

export function isTerminal(status: RunRecord["state"]["status"]): status is TerminalStatus {
  return status !== "active";
}

export function summarizeRun(
  record: RunRecord & { readonly state: { readonly status: TerminalStatus } },
  closedAt: Date,
  artifacts: readonly string[],
): RunSummary {
  const events = Object.fromEntries(EVENTS.map((e) => [e, 0])) as Record<(typeof EVENTS)[number], number>;
  for (const h of record.state.context.history) events[h.event]++;
  return {
    runId: record.runId,
    workflow: { id: record.workflow.id, revision: record.workflow.revision },
    task: record.task,
    autonomy: record.autonomy,
    status: record.state.status,
    stage: record.state.stage,
    createdAt: record.createdAt,
    closedAt: closedAt.toISOString(),
    durationMs: Math.max(0, closedAt.getTime() - Date.parse(record.createdAt)),
    loops: record.state.context.loops,
    events,
    approvals: record.approvals,
    artifacts: [...artifacts].sort(),
  };
}

export interface HandoffInput {
  readonly record: RunRecord;
  readonly expects: readonly string[];
  readonly artifacts: readonly string[];
  /** The latest log entries, oldest first. */
  readonly log: readonly string[];
  readonly writtenAt: Date;
}

/** A Markdown handoff generated from the run directory: enough to resume without the chat. */
export function renderHandoff(input: HandoffInput): string {
  const { record } = input;
  const list = (items: readonly string[], empty: string) =>
    items.length === 0 ? `- ${empty}` : items.map((i) => `- ${i}`).join("\n");
  const approvals = Object.entries(record.approvals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([gate, a]) => `${gate}: ${a.by}${a.choice === undefined ? "" : ` (choice ${a.choice})`}, ${a.at}`);
  const loops = Object.entries(record.state.context.loops).map(([loop, n]) => `${loop}: ${n}`);
  const body = [
    `# Handoff: ${record.runId}`,
    "",
    `- Task: ${record.task}`,
    `- Workflow: ${record.workflow.id}@${record.workflow.revision} (${record.workflow.source})`,
    `- Autonomy: ${record.autonomy}`,
    `- Stage: ${record.state.stage} (${record.state.status})`,
    `- Expects: ${input.expects.join(", ") || "nothing (terminal)"}`,
    "",
    "## Approvals",
    "",
    list(approvals, "none"),
    "",
    "## Loops used",
    "",
    list(loops, "none"),
    "",
    "## Artifacts",
    "",
    list([...input.artifacts].sort(), "none yet"),
    "",
    "## Recent log",
    "",
    list(input.log, "empty"),
    "",
    "## Resume",
    "",
    `1. \`git checkout\` the branch and run \`metator run status --run ${record.runId}\`.`,
    "2. Read the artifacts above, then continue at the current stage; do not redo approved stages.",
    "",
  ].join("\n");
  return renderFrontMatter(
    RunHandoffDocument.stamp({ runId: record.runId, writtenAt: input.writtenAt.toISOString() }),
    body,
  );
}
