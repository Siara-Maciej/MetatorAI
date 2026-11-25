import type { LayoutView } from "@metator/core";

/**
 * One look per interval for the whole daemon (ADR-0110): what other processes change under
 * `.metator/` (a detached drive, an agent's `metator` command) reaches the daemon only by reading
 * it again. Each tick reads every watched topic's text once; a text that differs from the last
 * tick's is that topic changed. The state and inbox sockets read the same texts instead of each
 * reading the overview on its own clock.
 *
 * It runs only while something holds it (an events, state or inbox socket); the first tick after
 * that only learns the texts, it announces nothing.
 */
export interface SweepOptions {
  readonly everyMs: number;
  /** Each watched topic's text now. */
  readonly read: () => Promise<ReadonlyMap<string, string>>;
  /** The topics whose text changed since the last tick. */
  readonly changed: (topics: readonly string[]) => void;
  /** Repeats `fn` every `ms` (setInterval); returns what stops it. Injected so tests need no clock. */
  readonly every?: (ms: number, fn: () => void) => () => void;
}

export interface Sweep {
  /** Keeps the sweep running until the returned function is called. */
  hold(): () => void;
  /** The topic's text whenever a tick reads one that differs from the last; holds the sweep too. */
  listen(topic: string, fn: (text: string) => void): () => void;
  /** One look now (a tick already under way is not started twice). */
  tick(): Promise<void>;
  stop(): void;
}

export function createSweep(opts: SweepOptions): Sweep {
  const every =
    opts.every ??
    ((ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    });
  let last = new Map<string, string>();
  const listeners = new Map<string, Set<(text: string) => void>>();
  let holders = 0;
  let cancel: (() => void) | undefined;
  let running: Promise<void> | undefined;

  const look = async () => {
    const now = await opts.read();
    const changed: string[] = [];
    for (const [topic, text] of now) {
      const before = last.get(topic);
      if (before === text) continue;
      if (before !== undefined) changed.push(topic);
      for (const fn of listeners.get(topic) ?? []) fn(text);
    }
    // Nothing held it while it read: what it learnt is stale by the next hold.
    if (holders > 0) last = new Map(now);
    if (changed.length > 0) opts.changed(changed);
  };
  const tick = () => {
    running ??= look()
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const release = () => {
    holders -= 1;
    if (holders > 0) return;
    cancel?.();
    cancel = undefined;
    last = new Map();
  };
  const hold = () => {
    holders += 1;
    if (holders === 1) {
      cancel = every(opts.everyMs, () => void tick());
      void tick();
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      release();
    };
  };
  return {
    hold,
    listen(topic, fn) {
      const set = listeners.get(topic) ?? new Set();
      set.add(fn);
      listeners.set(topic, set);
      const unhold = hold();
      return () => {
        set.delete(fn);
        unhold();
      };
    },
    tick,
    stop() {
      cancel?.();
      cancel = undefined;
      holders = 0;
      listeners.clear();
      last = new Map();
    },
  };
}

/**
 * The layout as far as a person sees a change in it: the workspaces and panes, each pane's
 * life (alive, idle, exit) and its state, without what moves on its own (output times, the
 * seconds a quiet pane has been quiet). A blocked pane keeps its prompt: a new question is a change.
 */
export function layoutSignature(view: LayoutView): string {
  return JSON.stringify({
    workspaces: view.workspaces,
    panes: view.panes.map(({ live, state, ...pane }) => ({
      ...pane,
      ...(live
        ? {
            live: {
              sessionId: live.sessionId,
              alive: live.alive,
              idle: live.idle,
              ...(live.exitCode !== undefined ? { exitCode: live.exitCode } : {}),
            },
          }
        : {}),
      ...(state
        ? {
            state:
              state.state === "blocked"
                ? { state: state.state, reason: state.reason, ...(state.menu ? { menu: state.menu } : {}) }
                : { state: state.state },
          }
        : {}),
    })),
  });
}
