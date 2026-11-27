/**
 * Fakes for the tests of a screen's store (ADR-0113): a daemon whose client records each call and
 * answers what a test says, and a counter of the draws of each named part.
 */
import { Profiler, type ReactNode } from "react";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import { createStateStore, type Store } from "../src/shared/daemon/daemon-store.ts";

export type Calls = Record<string, unknown[][]>;

/** A daemon whose client records each call and answers what `answers` says (a function: per call). */
export function fakeDaemon(
  answers: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
): { daemon: Store<Daemon>; calls: Calls } {
  const calls: Calls = {};
  const client = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        async (...args: unknown[]) => {
          calls[name] = [...(calls[name] ?? []), args];
          const a = answers[name];
          return typeof a === "function" ? a(...args) : (a ?? { ok: true, data: undefined });
        },
    },
  );
  const daemon = createStateStore({
    client,
    repo: "shop",
    url: "http://d",
    me: "ana",
    who: async () => "ana",
    ...state,
  }) as unknown as Store<Daemon>;
  return { daemon, calls };
}

/** A screen's store as its provider makes it. */
export const made = <S,>(create: StateCreator<S>): StoreApi<S> => createStore<S>()(create);

/** A part wrapped in a `<Profiler>` that counts its commits in `draws[id]`. */
export const counted = (draws: Record<string, number>, id: string, children: ReactNode) => (
  <Profiler
    id={id}
    onRender={() => {
      draws[id] = (draws[id] ?? 0) + 1;
    }}
  >
    {children}
  </Profiler>
);
