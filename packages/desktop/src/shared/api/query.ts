/**
 * What the app reads from the daemon is server state (ADR-0108): one query cache for the whole
 * window. A request repeated on an interval is a query; an answer equal to the last one keeps the
 * last one's objects, so nothing that shows it draws again.
 */
import { QueryClient, queryOptions, replaceEqualDeep, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Envelope } from "./api.ts";
import { readsAgain, SWEPT, type Topic, topicOfKey } from "./events.ts";

/**
 * The window's query cache. The daemon is on this computer: a request never waits for the browser
 * to be "online", is not asked again because the window got the focus, and a refusal is shown,
 * not retried (the interval asks again anyway).
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchIntervalInBackground: true,
      },
    },
  });

export const queryClient = createQueryClient();

/** The value with every part that did not change taken from `before` (the same objects). */
export const shared = <T>(before: T | undefined, next: T): T => replaceEqualDeep(before, next) as T;

/**
 * Whether the daemon's push channel is live (ADR-0110): while it is, a polled request is asked
 * only rarely, as a fallback; what changed is read again when the daemon says so.
 */
export const pushStore = createStore<{ readonly live: boolean }>(() => ({ live: false }));
export const setPushLive = (live: boolean): void => pushStore.setState({ live });

/**
 * How often a request is asked: its own interval, or, while the push channel is live and the daemon
 * names every change of its topic (`SWEPT`), only as a fallback.
 */
export const intervalOf = (ms: number, live: boolean, topic: Topic): number | false =>
  ms > 0 ? (live && SWEPT.has(topic) ? Math.max(ms * 10, 30_000) : ms) : false;

/** Reads again what the daemon said changed, or everything ("all"), of the daemon at `scope`. */
export function readAgain(
  client: QueryClient,
  scope: string,
  read: "all" | readonly string[],
): Promise<void> {
  if (read !== "all" && read.length === 0) return Promise.resolve();
  return client.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "polled" &&
      q.queryKey[1] === scope &&
      // A request asked once (`ms` 0) is read when its screen opens, never again by itself: some
      // answers are said only once (`GET /scratch` names a gone record in one answer).
      q.meta?.once !== true &&
      (read === "all" || readsAgain(q.queryKey[2] as Topic, read)),
  });
}

/**
 * The query of one polled request: `scope` is the daemon's address (another daemon starts with
 * nothing), `key` what is asked (its first word names its topic, `topicOfKey`), `ms` how often
 * (0 asks once). An envelope that refuses, or one
 * without data, is the query's error; the data that was there stays.
 */
export function polledOptions<T>(
  scope: string,
  key: string,
  fn: () => Promise<Envelope<T>>,
  ms: number,
  live = false,
) {
  return queryOptions({
    queryKey: ["polled", scope, topicOfKey(key), key] as const,
    queryFn: async (): Promise<T> => {
      const r = await fn();
      if (r.ok && r.data !== undefined) return r.data;
      throw new Error(r.error?.message ?? "the daemon did not answer");
    },
    refetchInterval: intervalOf(ms, live, topicOfKey(key)),
    meta: { once: ms <= 0 },
  });
}

export interface Polled<T> {
  readonly data: T | undefined;
  /** The last read's failure; with `data` still there, the data is stale. */
  readonly error: string | undefined;
  /** When the last good answer came (ms since the epoch); undefined before the first. */
  readonly updatedAt: number | undefined;
  reload(): Promise<void>;
}

/**
 * `polledOptions` as a hook: the last good answer and when it came, the last failure, and a way
 * to ask again now. `enabled` false asks nothing (what is in the cache still shows).
 */
export function usePolledAt<T>(
  scope: string,
  key: string,
  fn: () => Promise<Envelope<T>>,
  ms: number,
  enabled = true,
): Polled<T> {
  const live = useStore(pushStore, (p) => p.live);
  const { data, error, dataUpdatedAt, refetch } = useQuery({
    ...polledOptions(scope, key, fn, ms, live),
    enabled,
  });
  const reload = useCallback(async () => {
    await refetch();
  }, [refetch]);
  return {
    data,
    error: error ? error.message : undefined,
    updatedAt: dataUpdatedAt > 0 ? dataUpdatedAt : undefined,
    reload,
  };
}
