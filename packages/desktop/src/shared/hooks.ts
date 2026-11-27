/**
 * The hooks the screens share (D11): the work as tasks, an action with what it answered.
 */
import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Envelope } from "./api/api.ts";
import { useDaemon, usePolled } from "./daemon/daemon.tsx";
import { boardCards } from "./model/board.ts";
import { refusalText } from "./model/format.ts";
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

import type { Answer } from "./state/action.ts";

interface ActionNotice {
  readonly text: string | undefined;
  readonly tone: "error" | "info";
  onClose(): void;
}
export interface Action {
  /**
   * Runs a request and keeps what it answered: a refusal becomes the notice (it stays until
   * closed, D5), a success clears it (or says `done`), then the screen's data is read again.
   * With `who` the person's name is asked for first; a cancelled name dialog runs nothing.
   * Resolves to whether the daemon said yes.
   */
  run(
    fn: (by: string) => Promise<Answer>,
    options?: {
      /** Ask for the person's name first and pass it to `fn`. */
      readonly who?: boolean;
      /** What to say when the daemon refuses without a message. */
      readonly refused?: string;
      /** What to say (as information) when it worked. */
      readonly done?: string;
      /** The last refusal, for what the screen offers next (a start from the last commit). */
      onRefused?(error: Answer["error"]): void;
    },
  ): Promise<boolean>;
  /** Spread into `<Notice>`. */
  readonly notice: ActionNotice;
  readonly busy: boolean;
  say(text: string | undefined, tone?: "error" | "info"): void;
}
/** One action at a time with one notice: the request, the refusal that stays, the reload after. */
export function useAction(reload?: () => Promise<unknown> | unknown): Action {
  const { me, who } = useDaemon("me", "who");
  const [note, setNote] = useState<{ text: string; tone: "error" | "info" }>();
  const [busy, setBusy] = useState(false);
  // React Compiler keeps `run` the same while `me`, `who` and `reload` are.
  const run: Action["run"] = async (fn, options = {}) => {
    const by = options.who ? await who() : me;
    if (options.who && !by) return false;
    setBusy(true);
    const r = await fn(by);
    setBusy(false);
    if (r.ok) setNote(options.done ? { text: options.done, tone: "info" } : undefined);
    else {
      setNote({ text: refusalText(r.error, options.refused), tone: "error" });
      options.onRefused?.(r.error);
    }
    await reload?.();
    return r.ok;
  };
  return {
    run,
    busy,
    notice: { text: note?.text, tone: note?.tone ?? "error", onClose: () => setNote(undefined) },
    say: (text, tone = "error") => setNote(text ? { text, tone } : undefined),
  };
}
