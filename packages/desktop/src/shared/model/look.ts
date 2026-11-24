/**
 * The look of a state: its tone, glyph and word, and the first level every screen speaks of.
 */
import type { RunOverview } from "../api/api.ts";
import { readableReason } from "./format.ts";

/* ---------- one vocabulary: what a state reads as, its glyph and its colour ---------- */

/** The colours a state can take; each is a class of the stylesheet (`faint` is the dim text colour). */
export type Tone = "amber" | "violet" | "red" | "green" | "blue" | "teal" | "faint";
export interface Look {
  readonly glyph: string;
  readonly tone?: Tone | undefined;
}
/** Every state the app draws with a glyph and a colour, by what it is the state of. */
export const LOOKS = {
  pane: {
    working: { glyph: "⋮", tone: "violet" },
    asks: { glyph: "?", tone: "amber" },
    idle: { glyph: "✓", tone: "faint" },
    finished: { glyph: "✓", tone: "green" },
    exited: { glyph: "✕", tone: "red" },
    paused: { glyph: "‖", tone: "blue" },
    question: { glyph: "?", tone: "amber" },
  },
  stage: {
    done: { glyph: "✓", tone: "green" },
    current: { glyph: "⟳", tone: "violet" },
    waiting: { glyph: "?", tone: "amber" },
    stopped: { glyph: "✕", tone: "red" },
    next: { glyph: "·", tone: "faint" },
  },
  step: {
    done: { glyph: "✓", tone: "green" },
    "in-progress": { glyph: "⋮", tone: "violet" },
    blocked: { glyph: "!", tone: "amber" },
    todo: { glyph: "○", tone: "faint" },
    waiting: { glyph: "?", tone: "amber" },
  },
  issue: {
    proposed: { glyph: "?", tone: "amber" },
    "in-progress": { glyph: "⋮", tone: "violet" },
    open: { glyph: "○" },
    done: { glyph: "✓", tone: "green" },
    dropped: { glyph: "✕", tone: "faint" },
  },
  note: {
    draft: { glyph: "✎", tone: "amber" },
    sent: { glyph: "→", tone: "violet" },
    addressed: { glyph: "✓", tone: "green" },
  },
  thread: {
    open: { glyph: "○", tone: "amber" },
    answered: { glyph: "↩" },
    planned: { glyph: "⋮", tone: "violet" },
    fixed: { glyph: "✓", tone: "green" },
    resolved: { glyph: "✓", tone: "green" },
  },
  /** A finding of a watched review (round 18): its state after a re-review. */
  finding: {
    open: { glyph: "○", tone: "amber" },
    fixed: { glyph: "✓", tone: "green" },
    "not-fixed": { glyph: "✕", tone: "red" },
    disputed: { glyph: "?", tone: "violet" },
    outdated: { glyph: "–", tone: "faint" },
  },
  file: {
    added: { glyph: "A", tone: "green" },
    deleted: { glyph: "D", tone: "red" },
    modified: { glyph: "M", tone: "amber" },
    renamed: { glyph: "R", tone: "amber" },
  },
  /** The first level's four words (`firstLevel`): the only looks the sidebar, Board and Home draw. */
  first: {
    "needs you": { glyph: "?", tone: "amber" },
    working: { glyph: "⋮", tone: "violet" },
    blocked: { glyph: "!", tone: "red" },
    done: { glyph: "✓", tone: "green" },
  },
  /** A thread with no task yet (round 16): its row says `chat`; a closed one `closed`; else it reads `first`. */
  chat: {
    chat: { glyph: "›", tone: "faint" },
    closed: { glyph: "–", tone: "faint" },
  },
  /** A run, a repository: `runStateOf` and `rollUp`. */
  run: {
    "needs you": { glyph: "?", tone: "amber" },
    working: { glyph: "⋮", tone: "violet" },
    escalated: { glyph: "!", tone: "red" },
    done: { glyph: "✓", tone: "green" },
    "plan ready": { glyph: "✓", tone: "teal" },
    aborted: { glyph: "⊘", tone: "faint" },
    idle: { glyph: "·", tone: "faint" },
  },
  need: {
    question: { glyph: "?", tone: "amber" },
    approval: { glyph: "?", tone: "amber" },
    permission: { glyph: "?", tone: "amber" },
    terminal: { glyph: "›", tone: "amber" },
    escalated: { glyph: "!", tone: "red" },
    review: { glyph: "?", tone: "amber" },
  },
  attention: {
    you: { glyph: "●", tone: "amber" },
    driving: { glyph: "●", tone: "violet" },
    escalated: { glyph: "●", tone: "red" },
    done: { glyph: "●", tone: "green" },
    stopped: { glyph: "●", tone: "faint" },
    aborted: { glyph: "●", tone: "faint" },
  },
} as const satisfies Record<string, Record<string, Look>>;
export type LookKind = keyof typeof LOOKS;
/**
 * The four words of the first level (the sidebar, the Board, Home, a page's head): what needs
 * the person, what works, what stands still and what is finished. The finer words (asks, idle,
 * exited, aborted, escalated, done not seen) are inside a step's Details and its terminal.
 */
export type FirstLevel = "needs you" | "working" | "blocked" | "done";
/**
 * A fine state in one of the four words. Blocked is everything that stands still without asking:
 * escalated, waiting for another step, nothing driving it (idle, exited, a task not started).
 */
export function firstLevel(fine: string | undefined): FirstLevel {
  switch (fine) {
    case "needs you":
    case "asks":
    case "proposed":
    case "question":
    case "approval":
    case "permission":
    case "terminal":
      return "needs you";
    case "working":
      return "working";
    case "done":
    case "plan ready":
    case "aborted":
    case "finished":
      return "done";
    default:
      return "blocked";
  }
}
/** Why something is blocked, in one line for its task's page and its own: what to do about it. */
export function blockedReason(x: {
  readonly run?: Pick<RunOverview, "status" | "stage" | "reason"> | undefined;
  readonly waitsFor?: readonly string[] | undefined;
}): string {
  if (x.run?.status === "escalated") {
    const why = readableReason(x.run.reason).text;
    return `escalated at ${x.run.stage}: ${why.length > 120 ? `${why.slice(0, 119)}…` : why}`;
  }
  if (x.waitsFor && x.waitsFor.length > 0) return `waits for ${x.waitsFor.join(", ")}`;
  return x.run ? "nothing drives it: Open a session" : "not started: nothing drives it yet";
}
/** The glyph and colour of a state; a state the table does not know is a faint dot. */
export function lookOf(kind: LookKind, state: string | undefined): Look {
  const table: Record<string, Look> = LOOKS[kind];
  return (state !== undefined ? table[state] : undefined) ?? { glyph: "·", tone: "faint" };
}
