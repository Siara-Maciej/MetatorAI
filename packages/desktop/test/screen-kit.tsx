/**
 * What the screen-store tests share (ADR-0113): a daemon whose client records each call, a part
 * wrapped to count its draws, and a root to draw into under happy-dom.
 */
import { Profiler, type ReactNode } from "react";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import { createStateStore, type Store } from "../src/shared/daemon/daemon-store.ts";

export type Calls = Record<string, unknown[][]>;

/** A daemon whose client records each call and answers what `answers` says; `over` sets other fields. */
export function fakeDaemon(
  answers: Record<string, unknown> = {},
  over: Partial<Record<keyof Daemon, unknown>> = {},
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
    ...over,
  }) as unknown as Store<Daemon>;
  return { daemon, calls };
}

/** A part wrapped to count how many times it committed, under `id`. */
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

/** A root to draw into, with React's `act`. */
export async function drawRoot() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  const root = createRoot(host);
  return {
    act,
    host,
    draw: (node: ReactNode) => act(() => root.render(node)),
    done: () => act(() => root.unmount()),
  };
}
