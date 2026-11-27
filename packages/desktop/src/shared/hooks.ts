/**
 * The hooks the screens share (D11): what a route names, the work as tasks, a kept yes/no.
 */
import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Envelope } from "./api/api.ts";
import { useDaemon, usePolled } from "./daemon/daemon.tsx";
import { boardCards } from "./model/board.ts";
import { type Found, found } from "./model/found.ts";
import { type WorkTask, workTasks } from "./model/tasks.ts";

/**
 * Whether what a route names (`key`: `run:<id>`, `thread:<id>`) is there. While the window does not
 * know it (`present`), the daemon is asked (`ask`, then `has` of its answer) every few seconds;
 * only its answer read after the screen opened for this key can say "missing": a run or a chat
 * just made is "waiting" until the window's state catches up.
 */
export function useFound<T>(
  key: string,
  present: boolean,
  ask: () => Promise<Envelope<T>>,
  has: (data: T) => boolean,
): Found {
  // When the screen opened for this key; another key in the same screen (one missing run, then
  // another) has its own opening time.
  const openedAt = useMemo(() => openingTime(key), [key]);
  const check = usePolled(
    `exists:${key}`,
    async (): Promise<Envelope<boolean>> => {
      const r = await ask();
      return r.ok && r.data !== undefined
        ? { ok: true, data: has(r.data) }
        : { ok: false, ...(r.error ? { error: r.error } : {}) };
    },
    3000,
    !present,
  );
  return found(present, check, openedAt);
}

/** The time a screen opened for `key` (the key names which opening it is). */
const openingTime = (_key: string): number => Date.now();

/** The work as parent tasks (tasks.ts), from the runs and system plans: the sidebar's, Home's and a page's. */
export function useTasks(): WorkTask[] {
  const { runs, systemPlans } = useDaemon("runs", "systemPlans");
  return useMemo(
    () => workTasks(boardCards({ runs, issues: [], plans: systemPlans, now: Date.now() }), systemPlans),
    [runs, systemPlans],
  );
}
/** The yes/nos the window keeps, by key (app-wide, ADR-0113): what was set in this window. */
const keptFlags = createStore<Readonly<Record<string, boolean>>>(() => ({}));
/** What each key's storage said when it was first read: read once. */
const firstRead = new Map<string, boolean>();

/**
 * A yes/no the window keeps (round 22: a sidebar folded to its narrow version): read once from the
 * window's storage, written on each change; both under try/catch, so a window without storage
 * keeps it until it closes. Every part that reads the same key reads the same value.
 */
export function useKeptFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const value = useStore(keptFlags, (s) => s[key]) ?? readOnce(key, fallback);
  return [value, (v) => setKeptFlag(key, v)];
}

/** Sets a kept yes/no: every part that reads it draws again, and the window's storage keeps it. */
function setKeptFlag(key: string, v: boolean): void {
  keptFlags.setState({ [key]: v });
  writeFlag(key, v);
}

function readOnce(key: string, fallback: boolean): boolean {
  const known = firstRead.get(key);
  if (known !== undefined) return known;
  const v = readFlag(key, fallback);
  firstRead.set(key, v);
  return v;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, v: boolean): void {
  try {
    window.localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // A window without storage keeps it until it closes.
  }
}
