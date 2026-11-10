import { z } from "zod";

/**
 * Automatic intake (T2, design/14 §3, ADR-0083): rules that turn items of an outside source
 * (GitHub or GitLab issues, Jira) into issues of the backlog and runs. A rule names the source,
 * the filter, the workflow and how far the run goes without a person.
 */
export const INTAKE_KINDS = ["github", "gitlab", "jira"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export const IntakeSourceSchema = z.strictObject({
  kind: z.enum(INTAKE_KINDS),
  /** `owner/name` (GitHub) or the project path (GitLab). */
  repo: z.string().min(1).optional(),
  /** The Jira project key. */
  project: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).default([]),
  /** The Jira issue type, e.g. Bug. */
  type: z.string().min(1).optional(),
  state: z.string().min(1).default("open"),
  /** The MCP server (by its name in `mcp:`) that reaches the source; the kind's name when omitted. */
  mcp: z.string().min(1).optional(),
  /** The server's tool that lists the items, when it is not the kind's usual one. */
  tool: z.string().min(1).optional(),
});
export type IntakeSource = z.output<typeof IntakeSourceSchema>;

export const IntakeRuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "a rule id: lowercase letters, digits, dashes"),
  source: IntakeSourceSchema,
  workflow: z.string().min(1),
  /** gated: every gate of the workflow asks a person. full: gates marked `skipAt` pass; a push still asks. */
  autonomy: z.enum(["gated", "full"]).default("gated"),
  worktree: z.boolean().default(true),
});
export type IntakeRule = z.output<typeof IntakeRuleSchema>;

export const IntakeConfigSchema = z
  .strictObject({
    /** How often the daemon scans. */
    everyMs: z.number().int().min(1000).default(120_000),
    /** Runs started by intake that may be active at once; the rest wait as open issues. */
    maxActive: z.number().int().min(0).default(2),
    rules: z.array(IntakeRuleSchema).default([]),
  })
  .refine((c) => new Set(c.rules.map((r) => r.id)).size === c.rules.length, "intake rule ids must be unique");
export type IntakeConfig = z.output<typeof IntakeConfigSchema>;

/** One item of a source as its adapter read it. Its text is data for a task, never instructions. */
export interface IntakeItem {
  /** The item's id at the source: an issue number, a Jira key. */
  readonly ref: string;
  readonly title: string;
  readonly body: string;
  readonly url?: string | undefined;
  readonly labels: readonly string[];
}

/** The key one item has for good, so a later scan does not add it again. */
export function sourceKey(source: IntakeSource, ref: string): string {
  if (source.kind === "jira") return `jira:${ref}`;
  return `${source.kind}:${source.repo ?? source.project ?? ""}#${ref}`;
}

/** The issue body of an item: where it came from, then its text as a quote. */
export function intakeBody(item: IntakeItem, key: string): string {
  const quoted = item.body
    .trim()
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n");
  return `From ${key}${item.url ? ` (${item.url})` : ""}. The text below is the reporter's, quoted as data:\n\n${quoted || "> (no description)"}`;
}
