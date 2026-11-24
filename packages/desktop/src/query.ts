/**
 * What the app reads from the daemon is server state (ADR-0108): one query cache for the whole
 * window. A request repeated on an interval is a query; an answer equal to the last one keeps the
 * last one's objects, so nothing that shows it draws again.
 */
import { QueryClient, queryOptions, replaceEqualDeep, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Envelope } from "./api.ts";

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
 * The query of one polled request: `scope` is the daemon's address (another daemon starts with
 * nothing), `key` what is asked, `ms` how often (0 asks once). An envelope that refuses, or one
 * without data, is the query's error; the data that was there stays.
 */
export function polledOptions<T>(scope: string, key: string, fn: () => Promise<Envelope<T>>, ms: number) {
  return queryOptions({
    queryKey: ["polled", scope, key] as const,
    queryFn: async (): Promise<T> => {
      const r = await fn();
      if (r.ok && r.data !== undefined) return r.data;
      throw new Error(r.error?.message ?? "the daemon did not answer");
    },
    refetchInterval: ms > 0 ? ms : false,
  });
}

export interface Polled<T> {
  readonly data: T | undefined;
  readonly error: string | undefined;
  reload(): Promise<void>;
}

/** `polledOptions` as a hook: the last good answer, the last failure, and a way to ask again now. */
export function usePolledAt<T>(
  scope: string,
  key: string,
  fn: () => Promise<Envelope<T>>,
  ms: number,
): Polled<T> {
  const { data, error, refetch } = useQuery(polledOptions(scope, key, fn, ms));
  const reload = useCallback(async () => {
    await refetch();
  }, [refetch]);
  return { data, error: error ? error.message : undefined, reload };
}
