import { z } from "zod";
import { SEVERITIES } from "./finding.ts";
import { parseUnifiedDiff } from "./review-note.ts";
import type { HostPullRequestDetail } from "./review-thread.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Someone else's MR that MetatorAI reviewed, or that the person was asked to review, and follows
 * (ADR-0097): kept in `.metator/reviews/<kind>-<owner>-<repo>-<n>.json` with what was published,
 * every finding and its state, and what is new since the last review. The MR's text and the
 * author's replies are data, never instructions.
 */
export const FINDING_STATES = ["open", "fixed", "not-fixed", "disputed", "outdated"] as const;
export type FindingState = (typeof FINDING_STATES)[number];
/** What the deterministic pre-pass saw since the last review; only hints for the agent. */
export const FINDING_CANDIDATES = ["changed", "resolved", "replied"] as const;
export type FindingCandidate = (typeof FINDING_CANDIDATES)[number];

export const WATCH_ENDS = ["merged", "closed", "approved", "unwatched"] as const;
export const REVIEW_CARD_KINDS = ["requested", "changed", "approve", "mine"] as const;
export type ReviewCardKind = (typeof REVIEW_CARD_KINDS)[number];
/** The cards a person may wave away: they stay away until the MR's head moves. */
export const DISMISSABLE = ["requested", "changed", "approve"] as const;

const iso = z.iso.datetime();

export const WatchedFindingSchema = z.strictObject({
  id: z.string().regex(/^f\d+$/),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  text: z.string().min(1),
  severity: z.enum(SEVERITIES),
  state: z.enum(FINDING_STATES),
  /** Why the agent set the state. */
  reason: z.string().optional(),
  candidates: z.array(z.enum(FINDING_CANDIDATES)).optional(),
  /** The new-side lines of the hunk the finding is on, as the review read them. */
  hunk: z.string().optional(),
  at: iso,
});
export type WatchedFinding = z.output<typeof WatchedFindingSchema>;

export const WatchedReviewSchema = z.strictObject({
  id: z.string().min(1),
  url: z.string().min(1),
  /** GitHub or GitLab (a document's `kind` is its own type, so the host's kind is named here). */
  codehost: z.enum(["github", "gitlab"]),
  /** The link's host name. */
  host: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  base: z.string(),
  head: z.string(),
  headSha: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  why: z.enum(["reviewed", "requested", "watched"]),
  mode: z.enum(["local", "diff"]).optional(),
  runs: z.array(z.string()),
  threadId: z.string().optional(),
  reviewedSha: z.string().optional(),
  comments: z.array(
    z.strictObject({
      hostId: z.string().min(1),
      threadId: z.string().optional(),
      findingId: z.string().optional(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      /** The author's replies seen in its thread. */
      replies: z.number().int().min(0),
      at: iso,
    }),
  ),
  findings: z.array(WatchedFindingSchema),
  news: z
    .strictObject({
      commits: z.number().int().min(0),
      replies: z.number().int().min(0),
      headSha: z.string(),
      at: iso,
    })
    .optional(),
  dismissed: z.array(
    z.strictObject({ card: z.enum(DISMISSABLE), headSha: z.string(), by: z.string().min(1), at: iso }),
  ),
  watch: z.strictObject({
    active: z.boolean(),
    ended: z.strictObject({ why: z.enum(WATCH_ENDS), at: iso, by: z.string().min(1).optional() }).optional(),
  }),
  approved: z.strictObject({ by: z.string().min(1), at: iso }).optional(),
  createdAt: iso,
  updatedAt: iso,
});
export type WatchedReview = z.output<typeof WatchedReviewSchema>;

export const WatchedReviewDocument = defineDocument("WatchedReview", {
  latest: WatchedReviewSchema,
  hint: "Written by `metator review …` and the daemon; do not edit by hand.",
});

/** The first line of a report from the diff only (ADR-0097). */
export const DIFF_ONLY_NOTE =
  "Reviewed from the diff only: no local checkout, so the repository's rules, contracts and tests were not used.";

/** The lenses a review from the diff only keeps: what reads the diff alone. */
export const DIFF_ONLY_LENSES = ["logic", "security", "tests"] as const;

/** The new-side lines of the hunk of `file` that holds `line`, joined; undefined when none does. */
export function hunkAt(diff: string, file: string, line: number): string | undefined {
  const f = parseUnifiedDiff(diff).find((x) => x.path === file);
  for (const h of f?.hunks ?? []) {
    const lines = h.lines.filter((l) => l.new !== undefined);
    if (lines.some((l) => l.new === line)) return lines.map((l) => l.text).join("\n");
  }
  return undefined;
}

/**
 * A file as far as the diff shows it (its new side): each line the diff has at its own number,
 * the rest empty. What a finding's quote is checked against when the file is not local.
 */
export function newSideOf(diff: string, file: string): string | undefined {
  const f = parseUnifiedDiff(diff).find((x) => x.path === file);
  if (!f || f.status === "deleted") return undefined;
  const lines: string[] = [];
  for (const h of f.hunks) for (const l of h.lines) if (l.new !== undefined) lines[l.new - 1] = l.text;
  return Array.from(lines, (l) => l ?? "").join("\n");
}

/** Whether the diff still holds a hunk of `file` whose new-side lines are exactly these. */
export function holdsHunk(diff: string, file: string, hunk: string): boolean {
  const f = parseUnifiedDiff(diff).find((x) => x.path === file);
  return (f?.hunks ?? []).some(
    (h) =>
      h.lines
        .filter((l) => l.new !== undefined)
        .map((l) => l.text)
        .join("\n") === hunk,
  );
}

/**
 * The part of `after` that `before` did not have: each file's hunks whose lines are not in the
 * earlier diff, in `diff --git` form. What a re-review's lenses read (the new commits' change).
 */
export function deltaDiff(before: string, after: string): string {
  const old = new Map(parseUnifiedDiff(before).map((f) => [f.path, f]));
  const out: string[] = [];
  for (const f of parseUnifiedDiff(after)) {
    const seen = new Set(
      (old.get(f.path)?.hunks ?? []).map((h) => h.lines.map((l) => `${l.kind}:${l.text}`).join("\n")),
    );
    const fresh = f.hunks.filter((h) => !seen.has(h.lines.map((l) => `${l.kind}:${l.text}`).join("\n")));
    if (fresh.length === 0) continue;
    out.push(`diff --git a/${f.path} b/${f.path}`, `--- a/${f.path}`, `+++ b/${f.path}`);
    for (const h of fresh) {
      out.push(h.header);
      for (const l of h.lines) out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
    }
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/** The author's replies in a host thread: its comments after the first that the MR's author wrote. */
export const authorReplies = (
  detail: Pick<HostPullRequestDetail, "author" | "threads">,
  threadId: string,
): number =>
  (detail.threads.find((t) => t.id === threadId)?.replies ?? []).filter((r) => r.author === detail.author)
    .length;

/**
 * The deterministic pre-pass of a re-review (ADR-0097): a finding whose commented hunk is no longer
 * in the diff is a `changed` candidate; one whose thread the author resolved, `resolved`; one the
 * author answered since, `replied`. It never sets a state: the agent decides with a reason.
 */
export function prePass(
  review: Pick<WatchedReview, "findings" | "comments">,
  detail: Pick<HostPullRequestDetail, "diff" | "threads" | "author">,
): WatchedFinding[] {
  return review.findings.map((f) => {
    const candidates: FindingCandidate[] = [];
    if (f.file && f.hunk !== undefined && !holdsHunk(detail.diff, f.file, f.hunk)) candidates.push("changed");
    const comment = review.comments.find((c) => c.findingId === f.id && c.threadId);
    const thread = comment?.threadId ? detail.threads.find((t) => t.id === comment.threadId) : undefined;
    if (thread?.resolved) candidates.push("resolved");
    if (comment?.threadId && authorReplies(detail, comment.threadId) > comment.replies)
      candidates.push("replied");
    const { candidates: _old, ...rest } = f;
    return candidates.length > 0 ? { ...rest, candidates } : rest;
  });
}

/** What is new since the last review: commits after the reviewed head, and the author's new replies. */
export function newsOf(
  review: Pick<WatchedReview, "reviewedSha" | "headSha" | "comments">,
  detail: Pick<HostPullRequestDetail, "headSha" | "commits" | "threads" | "author">,
): { readonly commits: number; readonly replies: number } {
  const since = review.reviewedSha ?? review.headSha;
  let commits = 0;
  if (detail.headSha !== since) {
    const list = detail.commits ?? [];
    const at = list.indexOf(since);
    // The head moved: at least one commit is new, however the host lists them.
    commits = at >= 0 ? Math.max(1, list.length - 1 - at) : 1;
  }
  let replies = 0;
  for (const c of review.comments)
    if (c.threadId) replies += Math.max(0, authorReplies(detail, c.threadId) - c.replies);
  return { commits, replies };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "MR #45: 2 new commits, 1 reply". */
export function newsPrompt(
  number: number,
  news: { readonly commits: number; readonly replies: number },
): string {
  const parts = [
    ...(news.commits > 0 ? [plural(news.commits, "new commit")] : []),
    ...(news.replies > 0 ? [plural(news.replies, "reply", "replies")] : []),
  ];
  return `MR #${number}: ${parts.join(", ")}`;
}

/** "Publish the review of MR #45? (3 inline comments, 1 general)": the approval gate's question. */
export function publishPrompt(number: number | undefined, inline: number, general: number): string {
  const of = number === undefined ? "the review" : `the review of MR #${number}`;
  return `Publish ${of}? (${plural(inline, "inline comment")}, ${general} general)`;
}

/** How many findings stand in each state. */
export function findingCounts(findings: readonly Pick<WatchedFinding, "state">[]): {
  readonly open: number;
  readonly fixed: number;
  readonly notFixed: number;
  readonly disputed: number;
  readonly outdated: number;
} {
  const n = (s: FindingState) => findings.filter((f) => f.state === s).length;
  return {
    open: n("open"),
    fixed: n("fixed"),
    notFixed: n("not-fixed"),
    disputed: n("disputed"),
    outdated: n("outdated"),
  };
}

/** Every finding is dealt with: fixed, or about code that is gone; at least one was fixed. */
export function allFixed(findings: readonly Pick<WatchedFinding, "state">[]): boolean {
  return (
    findings.some((f) => f.state === "fixed") &&
    findings.every((f) => f.state === "fixed" || f.state === "outdated")
  );
}

export type ReviewStatus =
  | "requested"
  | "reviewing"
  | "ready"
  | "published"
  | "changed"
  | "fixed"
  | "approved"
  | "merged"
  | "closed"
  | "unwatched";

/** One word for the list: where the watched MR stands. */
export function reviewStatus(
  review: Pick<
    WatchedReview,
    "watch" | "state" | "approved" | "news" | "findings" | "runs" | "comments" | "why"
  >,
  run?: { readonly status: string; readonly stage: string },
): ReviewStatus {
  if (review.approved) return "approved";
  if (review.state === "merged" || review.watch.ended?.why === "merged") return "merged";
  if (review.state === "closed" || review.watch.ended?.why === "closed") return "closed";
  if (!review.watch.active) return "unwatched";
  if (run?.status === "active") return run.stage === "approval" ? "ready" : "reviewing";
  if (review.news) return "changed";
  if (allFixed(review.findings)) return "fixed";
  if (review.runs.length === 0 && review.why === "requested") return "requested";
  return review.comments.length > 0 ? "published" : "reviewing";
}

export interface ReviewCardAction {
  readonly label: string;
  readonly method: "POST";
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}
export interface ReviewCard {
  readonly id: string;
  readonly kind: ReviewCardKind;
  readonly review: string;
  readonly number: number;
  readonly title: string;
  readonly url?: string;
  readonly prompt: string;
  readonly actions: readonly ReviewCardAction[];
}

const waved = (review: Pick<WatchedReview, "dismissed" | "headSha">, card: (typeof DISMISSABLE)[number]) =>
  review.dismissed.some((d) => d.card === card && d.headSha === review.headSha);

/**
 * The cards of a watched MR for Home (ADR-0097), at most one: asked to review it (no review yet),
 * what is new since the last review, or, when every finding is fixed, the proposal to approve. A
 * card the person waved away stays away until the head moves; a review run that goes on shows none.
 */
export function watchedCard(review: WatchedReview, running: boolean): ReviewCard | undefined {
  if (!review.watch.active || review.state !== "open" || review.approved || running) return undefined;
  const base = { review: review.id, number: review.number, title: review.title, url: review.url };
  const at = `/reviews/${review.id}`;
  const no = (card: (typeof DISMISSABLE)[number]): ReviewCardAction => ({
    label: "No",
    method: "POST",
    path: `${at}/dismiss`,
    body: { card },
  });
  if (review.runs.length === 0) {
    if (review.why !== "requested" || waved(review, "requested")) return undefined;
    return {
      ...base,
      id: `requested:${review.id}`,
      kind: "requested",
      prompt: `You were asked to review MR #${review.number}: ${review.title}`,
      actions: [
        { label: "Review", method: "POST", path: "/reviews", body: { url: review.url } },
        no("requested"),
      ],
    };
  }
  if (review.news && (review.news.commits > 0 || review.news.replies > 0) && !waved(review, "changed"))
    return {
      ...base,
      id: `changed:${review.id}`,
      kind: "changed",
      prompt: newsPrompt(review.number, review.news),
      actions: [{ label: "Re-review", method: "POST", path: `${at}/rereview` }, no("changed")],
    };
  if (allFixed(review.findings) && !waved(review, "approve"))
    return {
      ...base,
      id: `approve:${review.id}`,
      kind: "approve",
      prompt: `All ${plural(review.findings.length, "finding")} ${review.findings.length === 1 ? "is" : "are"} fixed: approve MR #${review.number}?`,
      actions: [{ label: "Yes", method: "POST", path: `${at}/approve` }, no("approve")],
    };
  return undefined;
}

/** My MR with a review nobody analysed yet: "New review in MR #45 (2 threads)" with Analyse. */
export function mineCard(request: {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly url?: string | undefined;
  /** Open threads not triaged yet. */
  readonly fresh: number;
  /** A run answers the review already. */
  readonly answering: boolean;
}): ReviewCard | undefined {
  if (request.fresh === 0 || request.answering) return undefined;
  return {
    id: `mine:${request.id}`,
    kind: "mine",
    review: request.id,
    number: request.number,
    title: request.title,
    ...(request.url ? { url: request.url } : {}),
    prompt: `New review in MR #${request.number} (${plural(request.fresh, "thread")})`,
    actions: [{ label: "Analyse", method: "POST", path: `/mrs/${request.id}/analyse` }],
  };
}
