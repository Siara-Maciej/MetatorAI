/**
 * What a screen can say of data it reads from the daemon: not here yet, failed, stale (an answer
 * that was there, while the reads after it fail) or fresh. Loading and failure are never an empty
 * list: "Nothing open" is said only of an answer that has nothing.
 */
import { duration } from "./format.ts";

export type Reading = "loading" | "failed" | "stale" | "fresh";

export function readingOf(read: { readonly data: unknown; readonly error: string | undefined }): Reading {
  if (read.data === undefined) return read.error === undefined ? "loading" : "failed";
  return read.error === undefined ? "fresh" : "stale";
}

/** Several reads shown together (two lists of a screen): the one that says least. */
export function readingOfAll(
  reads: readonly { readonly data: unknown; readonly error: string | undefined }[],
): Reading {
  const all = reads.map(readingOf);
  for (const r of ["failed", "loading", "stale"] as const) if (all.includes(r)) return r;
  return "fresh";
}

const clockAt = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

/** The stale line: since when nothing good came (`since`, the last good answer) and why. */
export function staleText(since: number | undefined, now: number, error: string): string {
  return since === undefined
    ? `Not up to date: ${error}`
    : `Not up to date: no answer since ${clockAt(since)} (${duration(now - since)} ago). ${error}`;
}
