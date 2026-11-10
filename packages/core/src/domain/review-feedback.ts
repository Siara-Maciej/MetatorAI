import { z } from "zod";
import { LENSES } from "./finding.ts";
import { defineDocument } from "./versioned.ts";

/**
 * What people did with a review comment (F5 telemetry): resolved it (the finding was right and
 * got fixed), dismissed it (noise), or left it open. One line per reaction in
 * `.metator/telemetry/reactions.jsonl`; the share dismissed is the number the review is judged by
 * (the F5 exit criterion: dismissed ≤ 15%).
 */
export const REACTION_STATES = ["resolved", "dismissed", "open"] as const;
export type ReactionState = (typeof REACTION_STATES)[number];

export const ReviewReactionSchema = z.strictObject({
  at: z.iso.datetime(),
  /** The finding the comment carried (`LOGIC-007`). */
  finding: z.string().min(1),
  lens: z.enum(LENSES).optional(),
  /** The pull request the comment is on, as the host names it (`42`, `owner/repo#42`). */
  pr: z.string().min(1),
  state: z.enum(REACTION_STATES),
  /** Who reacted: a person, or the run that read the thread. */
  by: z.string().min(1),
  reason: z.string().optional(),
});
export type ReviewReaction = z.output<typeof ReviewReactionSchema>;

export const ReviewReactionDocument = defineDocument("ReviewReaction", {
  latest: ReviewReactionSchema,
  hint: "Record one with `metator findings react <finding> --pr <n> --state resolved|dismissed|open --by <who>`.",
});

export interface ReactionCounts {
  readonly total: number;
  readonly resolved: number;
  readonly dismissed: number;
  readonly open: number;
  /** Dismissed among the decided (resolved or dismissed); 0 with nothing decided. */
  readonly dismissedShare: number;
}

export interface ReactionStats extends ReactionCounts {
  readonly byLens: Readonly<Record<string, ReactionCounts>>;
  readonly byPr: Readonly<Record<string, ReactionCounts>>;
}

const count = (list: readonly ReviewReaction[]): ReactionCounts => {
  const resolved = list.filter((r) => r.state === "resolved").length;
  const dismissed = list.filter((r) => r.state === "dismissed").length;
  const decided = resolved + dismissed;
  return {
    total: list.length,
    resolved,
    dismissed,
    open: list.length - decided,
    dismissedShare: decided === 0 ? 0 : Math.round((dismissed / decided) * 1000) / 1000,
  };
};

/** The last reaction per finding and PR counts: a comment resolved after a dismissal is resolved. */
export function reactionStats(reactions: readonly ReviewReaction[]): ReactionStats {
  const last = new Map<string, ReviewReaction>();
  for (const r of [...reactions].sort((a, b) => a.at.localeCompare(b.at)))
    last.set(`${r.pr}\u0000${r.finding}`, r);
  const latest = [...last.values()];
  const group = (key: (r: ReviewReaction) => string | undefined): Record<string, ReactionCounts> => {
    const out: Record<string, ReactionCounts> = {};
    for (const k of [...new Set(latest.map(key).filter((x): x is string => x !== undefined))].sort())
      out[k] = count(latest.filter((r) => key(r) === k));
    return out;
  };
  return { ...count(latest), byLens: group((r) => r.lens), byPr: group((r) => r.pr) };
}
