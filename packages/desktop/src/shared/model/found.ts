/**
 * Whether the thing a route names (a run, a chat) is there. The window's state can lag a moment
 * behind a thing just made, so "missing" needs the daemon's own word, read after the screen opened.
 */
import type { StateData, ThreadsView } from "../api/api.ts";
import { flattenState } from "./places.ts";

export type Found = "found" | "waiting" | "missing";

/**
 * `present`: the window knows it. `check`: the daemon's answer to "do you have it" and when it was
 * read; only an answer read after `openedAt` that says no is "missing". An older answer (the
 * cache's), none yet, or a yes the window has not caught up with is "waiting".
 */
export function found(
  present: boolean,
  check: { readonly data: boolean | undefined; readonly updatedAt: number | undefined } | undefined,
  openedAt: number,
): Found {
  if (present) return "found";
  return check?.data === false && (check.updatedAt ?? 0) >= openedAt ? "missing" : "waiting";
}

/** The run is in the daemon's state: in a list, or among the runs it cannot read. */
export function stateHasRun(state: StateData, runId: string): boolean {
  const { runs, unreadable } = flattenState(state);
  return runs.some((r) => r.runId === runId) || unreadable.some((u) => u.runId === runId);
}

/** The chat is one of the daemon's threads, open or closed. */
export const threadsHave = (view: ThreadsView, id: string): boolean =>
  [...(view.threads ?? []), ...(view.closed ?? [])].some((t) => t.id === id);
