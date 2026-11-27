/**
 * What Reviews reads from the daemon (ADR-0113): one request per list, each part of the screen
 * taking from it only what it draws, so a part draws again only when its own piece changed. The
 * daemon's address and repository are read from the store the screen was given.
 */

import { useStore } from "zustand";
import type { ReviewedRequest, ReviewView } from "../../shared/api/api.ts";
import { type Polled, usePolledAt, usePolledSelectAt } from "../../shared/api/query.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import { watchEnded } from "./model.ts";
import { mineKey, useReviews, watchedKey } from "./state.ts";

const NO_WATCHED: readonly ReviewView[] = [];
const NO_MINE: readonly ReviewedRequest[] = [];

/** One value of the daemon's state, read through Reviews' store. */
export const useReviewsDaemon = <T>(select: (d: Daemon) => T): T =>
  useStore(
    useReviews((s) => s.daemon),
    select,
  );

/** The watched MRs (empty before the first answer), or `select`'s part of them. */
export function useWatched<R>(select: (list: readonly ReviewView[]) => R): R {
  const daemon = useReviews((s) => s.daemon);
  const url = useStore(daemon, (d) => d.url);
  const repo = useStore(daemon, (d) => d.repo);
  return usePolledSelectAt(
    url,
    watchedKey(repo),
    () => daemon.getState().client.reviews(repo),
    2000,
    (d) => select(d?.reviews ?? NO_WATCHED),
  );
}

/** My MRs (empty before the first answer), or `select`'s part of them. */
export function useMine<R>(select: (list: readonly ReviewedRequest[]) => R): R {
  const daemon = useReviews((s) => s.daemon);
  const url = useStore(daemon, (d) => d.url);
  const repo = useStore(daemon, (d) => d.repo);
  return usePolledSelectAt(
    url,
    mineKey(repo),
    () => daemon.getState().client.mrs(repo),
    2000,
    (d) => select(d?.requests ?? NO_MINE),
  );
}

/** Both reads whole, for what says whether they are current (and the lists' "Reading…" lines). */
export function useReads(): { readonly watched: Polled<unknown>; readonly mine: Polled<unknown> } {
  const daemon = useReviews((s) => s.daemon);
  const url = useStore(daemon, (d) => d.url);
  const repo = useStore(daemon, (d) => d.repo);
  const watched = usePolledAt(url, watchedKey(repo), () => daemon.getState().client.reviews(repo), 2000);
  const mine = usePolledAt(url, mineKey(repo), () => daemon.getState().client.mrs(repo), 2000);
  return { watched, mine };
}

/** One watched MR by its id. */
export const useWatchedOne = (id: string): ReviewView | undefined =>
  useWatched((l) => l.find((w) => w.id === id));
/** One of my MRs by its id. */
export const useMineOne = (id: string): ReviewedRequest | undefined =>
  useMine((l) => l.find((m) => m.id === id));

/** The MR shown when the route names none (or one the lists do not have): the first watched, else mine. */
function useFallback(): string | undefined {
  const watched = useWatched((l) => l.find((w) => !watchEnded(w.status))?.id);
  const mine = useMine((l) => l[0]?.id);
  return watched ?? mine;
}

/** Whether the picked MR is in one of the lists. */
function useKnown(id: string | undefined): boolean {
  const watched = useWatched((l) => id !== undefined && l.some((w) => w.id === id));
  const mine = useMine((l) => id !== undefined && l.some((m) => m.id === id));
  return watched || mine;
}

/** The MR shown on the right, as `watched:<id>` or `mine:<id>`. */
export function useCurrent(): string | undefined {
  const picked = useReviews((s) => s.picked);
  const watched = useWatched((l) => (l.some((w) => w.id === picked) ? picked : undefined));
  const mine = useMine((l) => (l.some((m) => m.id === picked) ? picked : undefined));
  const fallback = useFallback();
  const firstWatched = useWatched((l) => l.some((w) => w.id === fallback));
  if (watched !== undefined) return `watched:${watched}`;
  if (mine !== undefined) return `mine:${mine}`;
  if (fallback === undefined) return undefined;
  return `${firstWatched ? "watched" : "mine"}:${fallback}`;
}

/**
 * Whether `id` is the MR shown on the right, for a row: a row hears only of its own yes or no, so
 * choosing another MR draws two rows again; only the fallback row follows every choice.
 */
export function useIsCurrent(id: string): boolean {
  const mine = useReviews((s) => s.picked === id);
  const fallback = useFallback() === id;
  const picked = useReviews((s) => (fallback ? s.picked : undefined));
  const known = useKnown(picked);
  return mine || (fallback && !known);
}
