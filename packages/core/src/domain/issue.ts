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

export const IssueSchema = z.strictObject({
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
export type Issue = z.output<typeof IssueSchema>;

export const IssueDocument = defineDocument("Issue", {
  latest: IssueSchema,
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
export const issueTask = (issue: Issue): string =>
  issue.body.trim() ? `${issue.title}\n\n${issue.body.trim()}` : issue.title;

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
