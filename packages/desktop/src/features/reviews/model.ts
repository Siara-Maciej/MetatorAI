/**
 * Reviews (round 18, stage 3; pure, tested): what the app says of a watched MR (others', reviewed
 * by MetatorAI or where the person is a requested reviewer) and of my MRs. The one word of a row
 * in the Reviews place, the badge of a finding's state, the cards Home shows (composed by the
 * daemon: asked to review, new commits or replies, a new review on my MR, approve once all is
 * fixed) as rows of the queue, the publish gate's Yes/No, which proposed replies "Send selected"
 * sends, and the terminal a started agent works in. The daemon decides what is new, each
 * finding's state and each MR's status (`GET /reviews`, `GET /mrs`, `/inbox`); nothing here
 * computes them again.
 */
import type {
  Question,
  ReviewCardView,
  ReviewStarted,
  ReviewStatus,
  WatchedFinding,
} from "../../shared/api/api.ts";
import { plural } from "../../shared/model/format.ts";
import { type FirstLevel, lookOf, type Tone } from "../../shared/model/look.ts";
import type { NeedRow } from "../../shared/model/needs.ts";
import type { Route } from "../../shared/model/route.ts";
import { shownRoute } from "../backlog/model.ts";

/* ---------- findings ---------- */

/** A finding's state, as the re-review leaves it (WatchedReview v1). */
export type FindingState = WatchedFinding["state"];
export const FINDING_STATES = [
  "open",
  "fixed",
  "not-fixed",
  "disputed",
  "outdated",
] as const satisfies readonly FindingState[];

/** `not fixed`, `open`, …: the badge's words. */
export const findingText = (state: FindingState): string => (state === "not-fixed" ? "not fixed" : state);

/** The badge of a finding's state: its words and its tone (`LOOKS.finding`). */
export function findingBadge(state: FindingState): {
  readonly text: string;
  readonly tone: Tone | undefined;
} {
  return { text: findingText(state), tone: lookOf("finding", state).tone };
}

/** Where a finding is: `src/a.ts:12`, the file alone, or nothing for a general one. */
export const findingPlace = (f: {
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}): string | undefined => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined);

/** How many findings are in each state (`ReviewView.counts`). */
export interface FindingCounts {
  readonly open: number;
  readonly fixed: number;
  readonly notFixed: number;
  readonly disputed: number;
  readonly outdated: number;
}

/** `2 open · 1 not fixed`: the states with findings in them, in the order of `FINDING_STATES`. */
export function countsText(c: FindingCounts): string | undefined {
  const parts = FINDING_STATES.flatMap((s) => {
    const n = s === "not-fixed" ? c.notFixed : c[s];
    return n > 0 ? [`${n} ${findingText(s)}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/* ---------- a watched MR ---------- */

/** What changed at the host since the last review: new commits, new replies of the author. */
export interface NewsLike {
  readonly commits: number;
  readonly replies: number;
}

/** `2 new commits, 1 reply`, or undefined when nothing is new. */
export function newsText(news: NewsLike | undefined): string | undefined {
  if (!news) return undefined;
  const parts = [
    news.commits > 0 ? plural(news.commits, "new commit") : undefined,
    news.replies > 0 ? plural(news.replies, "reply", "replies") : undefined,
  ].filter((x): x is string => x !== undefined);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * The one word of a watched MR's row, from the daemon's `status`: the person was asked to review
 * it (`asked`), an agent reviews it (`reviewing`), the review waits for Publish (`to publish`), it is
 * published and watched (`watching`), commits or replies came (`changed`), every finding is fixed
 * (`all fixed`), or watching ended (`approved`, `merged`, `closed`, `stopped`).
 */
const STATUS_WORDS = {
  requested: "asked",
  reviewing: "reviewing",
  ready: "to publish",
  published: "watching",
  changed: "changed",
  fixed: "all fixed",
  approved: "approved",
  merged: "merged",
  closed: "closed",
  unwatched: "stopped",
} as const satisfies Record<ReviewStatus, string>;

export type WatchedWord = (typeof STATUS_WORDS)[ReviewStatus];

export const watchedWord = (status: ReviewStatus): WatchedWord => STATUS_WORDS[status];

/** Watching ended: approved, merged, closed or stopped. Such an MR is under "ended" in the list. */
export const watchEnded = (status: ReviewStatus): boolean =>
  status === "approved" || status === "merged" || status === "closed" || status === "unwatched";

/** A row's dim line: what is new, else how its findings stand, else that it was not reviewed yet. */
export function watchedLine(w: {
  readonly status: ReviewStatus;
  readonly news?: NewsLike | undefined;
  readonly counts: FindingCounts;
}): string {
  const news = watchEnded(w.status) ? undefined : newsText(w.news);
  return news ?? countsText(w.counts) ?? (w.status === "requested" ? "not reviewed yet" : "no findings");
}

/* ---------- my MRs ---------- */

/** One review thread on my MR, as the app reads it. */
export interface MineThreadLike {
  readonly id: string;
  readonly state: string;
  readonly reply?: string | undefined;
  readonly repliedAt?: string | undefined;
}

/** My MR, as the app reads it (`GET /mrs`). */
export interface MineLike {
  readonly threads: readonly MineThreadLike[];
  /** Open threads not triaged yet: a new review that waits for Analyse. */
  readonly fresh?: number | undefined;
}

/** A proposed reply not sent yet: what "Send selected" can send. */
export const toSend = (t: MineThreadLike): boolean => t.reply !== undefined && t.reply !== "" && !t.repliedAt;

/** The one word of my MR's row. */
export type MineWord = "new review" | "replies ready" | "open" | "done";

/**
 * My MR in one word: `new review` while new threads wait for Analyse; `replies ready` when proposed
 * replies wait to be sent; `open` with open threads; else `done`.
 */
export function mineWord(m: MineLike): MineWord {
  if ((m.fresh ?? 0) > 0) return "new review";
  if (m.threads.some(toSend)) return "replies ready";
  if (m.threads.some((t) => t.state === "open")) return "open";
  return "done";
}

/** My MR's dim line: `2 open · 1 reply to send`. */
export function mineLine(m: MineLike): string {
  const open = m.threads.filter((t) => t.state === "open").length;
  const send = m.threads.filter(toSend).length;
  return [`${open} open`, send > 0 ? `${plural(send, "reply", "replies")} to send` : undefined]
    .filter((x): x is string => x !== undefined)
    .join(" · ");
}

/* ---------- the looks of a row ---------- */

/** The tone of a row's word: what waits for the person is amber, work violet, an approval green. */
export function reviewTone(word: WatchedWord | MineWord): Tone {
  switch (word) {
    case "asked":
    case "to publish":
    case "changed":
    case "all fixed":
    case "new review":
    case "replies ready":
      return "amber";
    case "reviewing":
      return "violet";
    case "approved":
    case "done":
      return "green";
    default:
      return "faint";
  }
}

/** A row's glyph in the first level's looks: what waits `needs you`, work `working`, an approval `done`. */
export function reviewGlyph(word: WatchedWord | MineWord): FirstLevel | undefined {
  const tone = reviewTone(word);
  return tone === "amber"
    ? "needs you"
    : tone === "violet"
      ? "working"
      : tone === "green"
        ? "done"
        : undefined;
}

/* ---------- sending replies ---------- */

/** The replies checked at first: every one that waits to be sent. */
export const initialChecked = (threads: readonly MineThreadLike[]): ReadonlySet<string> =>
  new Set(threads.filter(toSend).map((t) => t.id));

/**
 * What "Send selected" sends: the checked threads that have a reply to send, named one by one
 * (`only`), so nothing the person did not see checked goes with them; nothing when none is checked.
 * Words to the chat agent take the same route (`metator mrs send --only`).
 */
export function sendSelection(
  threads: readonly MineThreadLike[],
  checked: ReadonlySet<string>,
): { readonly only: readonly string[] } | undefined {
  const only = threads.filter((t) => toSend(t) && checked.has(t.id)).map((t) => t.id);
  return only.length > 0 ? { only } : undefined;
}

/** `Send selected (2)`. */
export const sendLabel = (selection: { readonly only: readonly string[] } | undefined): string =>
  `Send selected (${selection?.only.length ?? 0})`;

/* ---------- the cards on Home ---------- */

/** A card's address on Home: `review/<repo>/<card id>` (no repository when there is one). */
export const reviewCardKey = (c: Pick<ReviewCardView, "id" | "repo">): string =>
  ["review", c.repo, c.id].filter((x) => x !== undefined && x !== "").join("/");

/** A row of Home's queue that is a review's card. */
export const isReviewCard = (n: Pick<NeedRow, "kind">): boolean => n.kind === "review";

/** The daemon's review cards as rows of the queue Home shows and the sidebar counts, after the questions. */
export function reviewNeeds(cards: readonly ReviewCardView[]): NeedRow[] {
  return cards.map((c) => ({
    key: reviewCardKey(c),
    kind: "review",
    title: c.prompt,
    sub: c.title,
    runId: "",
    repo: c.repo,
    hint: c.actions.map((a) => a.label).join(" · "),
  }));
}

/** The card's own word for declining: `No` sends nothing outward (the daemon only notes it). */
export const isNo = (a: { readonly label: string }): boolean => a.label === "No";

/** The body of a card's action: what the daemon put in it, with the person's name. */
export const actionBody = (a: { readonly body?: object | undefined }, by: string): object => ({
  ...(a.body ?? {}),
  by,
});

/* ---------- the publish gate ---------- */

/** The words a review run's approval gate asks with: `Publish the review of MR #45? (…)`. */
const PUBLISH = /^Publish the review of MR #\d+\?/;

/**
 * The publish card is the review run's approval gate: one Yes/No for the whole review (Yes is the
 * gate's Approve, No its Reject). Any other gate keeps its own options.
 */
export const isPublishGate = (q: Pick<Question, "source" | "prompt">): boolean =>
  q.source === "gate" && PUBLISH.test(q.prompt);

/** What a No on the publish card says to the run: Reject needs words, and these are the person's choice. */
export const NOT_PUBLISHED = "Not published: the person said No to publishing the review.";

/* ---------- after a button started an agent ---------- */

/** The terminal the started agent works in, shown at once: its run's pane, or its pane alone. */
export const startedRoute = (r: ReviewStarted | undefined): Route | undefined =>
  shownRoute({ runId: r?.runId ?? r?.pane?.runId, paneId: r?.session?.paneId ?? r?.pane?.id });
