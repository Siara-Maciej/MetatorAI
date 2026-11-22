import { z } from "zod";
import type { Question } from "./drive.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Local tasks (S4, design/13 §4): the repository's backlog in `.metator/issues/iNNN.json`, one
 * `Issue` v1 per task. An agent only proposes; a task exists when a person adds it (the proposal
 * is a question in the inbox, the answer the decision). Every issue says where it came from.
 */
export const ISSUE_STATUSES = ["proposed", "open", "in-progress", "done", "dropped"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const ISSUE_PRIORITIES = ["low", "normal", "high"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

const ISSUE_ID = /^i\d{3,}$/;

/** What the task points at: a run and its step, a file and a line, a review note. */
export const IssueRefSchema = z.strictObject({
  run: z.string().optional(),
  step: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  note: z.string().optional(),
});
export type IssueRef = z.output<typeof IssueRefSchema>;

const IssueV1Schema = z.strictObject({
  id: z.string().regex(ISSUE_ID, "an issue id: i001"),
  title: z.string().min(1).max(200),
  /** What and why, with the acceptance criterion; Markdown. */
  body: z.string(),
  status: z.enum(ISSUE_STATUSES),
  priority: z.enum(ISSUE_PRIORITIES),
  labels: z.array(z.string().min(1)),
  refs: z.array(IssueRefSchema),
  /** The agent that proposed it, from which run, when; absent when a person wrote it. */
  proposedBy: z
    .strictObject({
      agent: z.string().min(1),
      runId: z.string().optional(),
      at: z.iso.datetime(),
      questionId: z.string().optional(),
    })
    .optional(),
  /** The person who added (or dropped) it and when: the consent the product requires. */
  decidedBy: z
    .strictObject({ by: z.string().min(1), at: z.iso.datetime(), decision: z.enum(["added", "dropped"]) })
    .optional(),
  /** The run started from it (`issue start`). */
  runId: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
/**
 * v2 (T2) adds `source`: the outside item an intake rule made the issue from, by the key that
 * item has for good (`github:acme/shop#12`), so a later scan does not add it again.
 */
const IssueV2Schema = z.strictObject({
  ...IssueV1Schema.shape,
  source: z
    .strictObject({ key: z.string().min(1), rule: z.string().min(1), url: z.string().optional() })
    .optional(),
});

/**
 * What an analysis or a plan was made from (ADR-0096), so its freshness is decided without a
 * model: the text's file, when, at which commit, every file it cites with its content hash, the
 * workspace packages those files belong to, and the files of those packages that had already
 * changed against the commit then (so only a later change counts).
 */
const FileHashSchema = z.strictObject({ path: z.string().min(1), sha256: z.string() });
export const SnapshotSchema = z.strictObject({
  /** Repository-relative: `.metator/issues/<id>/analysis.md`, `…/plan.json`, `…/system-plan.yml`. */
  file: z.string().min(1),
  at: z.iso.datetime(),
  commit: z.string().min(1),
  cites: z.array(FileHashSchema),
  packages: z.array(z.string().min(1)),
  dirty: z.array(FileHashSchema).optional(),
});
export type Snapshot = z.output<typeof SnapshotSchema>;

/**
 * v3 (ADR-0096) adds the item's analysis and plan (snapshots), the thread it was made in, its
 * parent and the items it waits for, and the system plan step a child carries out.
 */
export const IssueSchema = z.strictObject({
  ...IssueV2Schema.shape,
  threadId: z.string().min(1).optional(),
  parent: z.string().regex(ISSUE_ID).optional(),
  dependsOn: z.array(z.string().regex(ISSUE_ID)).default([]),
  analysis: SnapshotSchema.optional(),
  plan: SnapshotSchema.extend({
    /** The run that made the plan (stopped `planned`, or any run whose plan was approved). */
    runId: z.string().min(1),
    kind: z.enum(["plan", "system-plan"]),
  }).optional(),
  /** A child made from a system plan step: the system run, its plan and the step. */
  step: z
    .strictObject({ runId: z.string().min(1), plan: z.string().min(1), stepId: z.string().min(1) })
    .optional(),
});
export type Issue = z.output<typeof IssueSchema>;

export const IssueDocument = defineDocument("Issue", {
  history: [{ schema: IssueV1Schema }, { schema: IssueV2Schema, fromPrevious: (v1) => v1 }],
  latest: IssueSchema,
  // Every v3 field is optional (`dependsOn` defaults to none): a v2 item is a v3 item without them.
  upgrade: (v2) => v2,
  hint: "Written by `metator issue …`; do not edit by hand.",
});

/** `i001`, `i002`, …: the next free id after the ones taken. */
export function nextIssueId(taken: readonly string[]): string {
  const max = taken.reduce((m, id) => Math.max(m, Number(id.replace(/^i/, "")) || 0), 0);
  return `i${String(max + 1).padStart(3, "0")}`;
}

/** The inbox question an agent's proposal becomes: add it, add it and start, or drop it. */
export const PROPOSAL_ADD = "Add to the backlog";
export const PROPOSAL_START = "Add and start a run";
export const PROPOSAL_DROP = "Drop";

export function proposalQuestion(
  issue: Issue,
  stage: string,
): Pick<Question, "stage" | "source" | "prompt" | "options" | "multiSelect"> & {
  readonly agent?: string;
  readonly card: NonNullable<Question["card"]>;
} {
  const agent = issue.proposedBy?.agent ?? "an agent";
  return {
    stage,
    source: "agent",
    ...(issue.proposedBy ? { agent: issue.proposedBy.agent } : {}),
    prompt: `${agent} proposes a task: ${issue.title}`,
    options: [
      { label: PROPOSAL_ADD, description: "a task in .metator/issues, decided by you" },
      { label: PROPOSAL_START, description: "the task, and a run on it now" },
      { label: PROPOSAL_DROP, description: "not a task; the proposal is kept as dropped" },
    ],
    multiSelect: false,
    card: {
      task: issue.title,
      done: [],
      artifacts: issue.refs.map(refText).filter((r) => r !== ""),
      recommended: PROPOSAL_ADD,
      reversible: true,
      soFar: issue.body ? [issue.body] : [],
      consequences: {
        [PROPOSAL_ADD]: "the task is open in the backlog; nobody works on it yet",
        [PROPOSAL_START]: "the task is open and a run starts on it in a new worktree",
        [PROPOSAL_DROP]: "the proposal stays, marked dropped, for the record",
      },
    },
  };
}

/** `src/invoice.ts:10`, `run 2026…/S2`, a note. */
export const refText = (r: IssueRef): string =>
  r.file
    ? `${r.file}${r.line ? `:${r.line}` : ""}`
    : r.run
      ? `run ${r.run}${r.step ? `/${r.step}` : ""}`
      : (r.note ?? "");

/** The decision a proposal's answer means, or undefined while it waits (or for another answer). */
export function proposalDecision(
  answer: Question["answer"] | undefined,
): "added" | "start" | "dropped" | undefined {
  if (!answer) return undefined;
  const choice = answer.choices[0];
  if (choice === PROPOSAL_ADD) return "added";
  if (choice === PROPOSAL_START) return "start";
  if (choice === PROPOSAL_DROP) return "dropped";
  return undefined;
}

/** The task text a run on the issue gets: its title, then its body. */
/**
 * A run's `task.md` from the issue it started from: the title, the body, and where it came from.
 * The run's task is the title alone; the agents read the rest from here.
 */
export const issueBrief = (issue: Issue): string =>
  `# ${issue.title}\n\n${issue.body.trim() ? `${issue.body.trim()}\n\n` : ""}From issue ${issue.id}.\n`;

/** Open first by priority (high first), then in progress, then proposed, then done and dropped; ties by id. */
const STATUS_RANK: Record<IssueStatus, number> = {
  proposed: 0,
  "in-progress": 1,
  open: 2,
  done: 3,
  dropped: 4,
};
const PRIORITY_RANK: Record<IssuePriority, number> = { high: 0, normal: 1, low: 2 };
export const byBacklogOrder = (a: Issue, b: Issue): number =>
  STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  a.id.localeCompare(b.id);
