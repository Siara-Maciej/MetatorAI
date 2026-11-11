import { z } from "zod";
import type { RunMessage } from "./run-message.ts";
import { defineDocument } from "./versioned.ts";

/**
 * A person's notes on a run's change (S5, design/13 §5): written while reading the diff in the
 * app or with `metator review notes add`, kept in `.metator/runs/<id>/review/notes.json`, and
 * sent to the run's agents as one `RunMessage` (topic `review`) when the person says so. The
 * note remembers which message carried it and whether the agent has addressed it.
 */
export const NOTE_STATUSES = ["draft", "sent", "addressed"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
const NOTE_ID = /^n\d{3,}$/;

export const ReviewNoteSchema = z.strictObject({
  id: z.string().regex(NOTE_ID, "a note id: n001"),
  /** Repo-relative path; absent for a note on the whole change. */
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  /** Which side of the diff the line is on. */
  side: z.enum(["old", "new"]).optional(),
  text: z.string().min(1),
  by: z.string().min(1),
  at: z.iso.datetime(),
  status: z.enum(NOTE_STATUSES),
  /** The message that carried it to the agents. */
  sentIn: z.string().optional(),
});
export type ReviewNote = z.output<typeof ReviewNoteSchema>;

export const ReviewNotesSchema = z.strictObject({ notes: z.array(ReviewNoteSchema) });
export type ReviewNotesData = z.output<typeof ReviewNotesSchema>;

export const ReviewNotesDocument = defineDocument("ReviewNotes", {
  latest: ReviewNotesSchema,
  hint: "Written by `metator review notes …` and the app's Changes screen; do not edit by hand.",
});

/** `n001`, `n002`, …: the next free id after the ones taken. */
export function nextNoteId(taken: readonly string[]): string {
  const max = taken.reduce((m, id) => Math.max(m, Number(id.replace(/^n/, "")) || 0), 0);
  return `n${String(max + 1).padStart(3, "0")}`;
}

/** `src/invoice.ts:10 (new)`, `src/invoice.ts`, or `the change` for a note without a file. */
export const noteRef = (n: Pick<ReviewNote, "file" | "line" | "side">): string =>
  n.file
    ? `${n.file}${n.line ? `:${n.line}` : ""}${n.line && n.side === "old" ? " (old)" : ""}`
    : "the change";

/** The text of the message that carries the notes: one line per note, the file and line first. */
export function notesMessage(notes: readonly ReviewNote[]): string {
  return [
    "Review notes from a person on this change:",
    ...notes.map((n) => `- ${noteRef(n)}: ${n.text}`),
  ].join("\n");
}

/** The refs of that message: the files the notes name, once each. */
export const notesRefs = (notes: readonly ReviewNote[]): string[] => [
  ...new Set(notes.flatMap((n) => (n.file ? [n.file] : []))),
];

/** A note is addressed when the agents replied on the review, or the file changed since it was sent. */
export const isReviewReply = (m: Pick<RunMessage, "topic">): boolean => m.topic === "review-reply";

/** One line of a parsed hunk: context, added or deleted, with its old and new line numbers. */
export interface DiffLine {
  readonly kind: "context" | "add" | "del";
  readonly old?: number;
  readonly new?: number;
  readonly text: string;
}
export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}
export interface FileDiff {
  readonly path: string;
  readonly status: "modified" | "added" | "deleted" | "renamed";
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
}

/** A unified diff (`git diff`) as files, hunks and numbered lines: what the Review screen draws. */
export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current:
    | { path: string; status: FileDiff["status"]; hunks: DiffHunk[]; added: number; removed: number }
    | undefined;
  let hunk: { header: string; lines: DiffLine[] } | undefined;
  let oldLine = 0;
  let newLine = 0;
  const flush = () => {
    if (current) files.push({ ...current });
    current = undefined;
    hunk = undefined;
  };
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      const a = m?.[1] ?? "";
      const b = m?.[2] ?? a;
      current = { path: b, status: a === b ? "modified" : "renamed", hunks: [], added: 0, removed: 0 };
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("new file mode") || raw === "--- /dev/null") current.status = "added";
    else if (raw.startsWith("deleted file mode") || raw === "+++ /dev/null") current.status = "deleted";
    else if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = Number(m?.[1] ?? 1);
      newLine = Number(m?.[2] ?? 1);
      hunk = { header: raw, lines: [] };
      current.hunks.push(hunk);
    } else if (hunk && (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ") || raw === "")) {
      if (raw.startsWith("+")) {
        hunk.lines.push({ kind: "add", new: newLine++, text: raw.slice(1) });
        current.added++;
      } else if (raw.startsWith("-")) {
        hunk.lines.push({ kind: "del", old: oldLine++, text: raw.slice(1) });
        current.removed++;
      } else if (raw.startsWith(" "))
        hunk.lines.push({ kind: "context", old: oldLine++, new: newLine++, text: raw.slice(1) });
    }
  }
  flush();
  return files;
}
