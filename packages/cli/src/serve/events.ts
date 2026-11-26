import { randomUUID } from "node:crypto";

/**
 * The daemon's push channel (`/ws/events`, ADR-0110): it tells a client WHICH things changed,
 * never what they are now. A client re-reads the GET endpoint of each topic it shows.
 *
 * A topic is one of these names. `activity` carries the run: `activity:<runId>`. In a daemon that
 * serves a folder, a topic whose endpoint reads one repository (`scope: "repo"`) carries it after
 * an `@`: `layout@shop`, `activity:<runId>@shop`; a daemon of one repository never adds `@`.
 * Topics whose endpoint spans every repository (`scope: "daemon"`) never carry one.
 *
 * The client mirrors this list. A topic may be announced for a change it already read (two
 * sources saw the same change): re-reading is always safe.
 */
export const TOPICS = {
  /** `GET /state`: runs, their questions and stages, the scratch count, the threads mark. */
  state: { scope: "daemon" },
  /** `GET /inbox`: decisions, escalations, panes' questions, review cards. */
  inbox: { scope: "daemon" },
  /** `GET /layout?repo=`: workspaces, tabs and panes, and each pane's state (asks, working, idle, exited). */
  layout: { scope: "repo" },
  /** `GET /threads`: the threads and what they hold. */
  threads: { scope: "daemon" },
  /** `GET /options?repo=`: the options a person set. */
  options: { scope: "repo" },
  /** `GET /system/plans?repo=`, `GET /runs/<run>/plan`, `GET /system/map`: plans and the map they come from. */
  plans: { scope: "repo" },
  /** `GET /reviews`, `GET /mrs`: watched merge requests and reviews of my own. */
  reviews: { scope: "daemon" },
  /** `GET /issues?repo=`: the Backlog. */
  backlog: { scope: "repo" },
  /** `GET /runs/<run>/activity?repo=`: one run's activity; the topic is `activity:<runId>`. */
  activity: { scope: "repo" },
} as const satisfies Record<string, { readonly scope: "daemon" | "repo" }>;

export type TopicName = keyof typeof TOPICS;

/** How long publications gather before one message goes out. */
export const COALESCE_MS = 50;

/**
 * A topic as it goes on the wire: the name, the run of `activity`, and the repository of a
 * repo-scoped topic when the daemon serves a folder (`repo` given).
 */
export function topic(
  name: TopicName,
  opts: { readonly repo?: string; readonly runId?: string } = {},
): string {
  const base = name === "activity" ? `activity:${opts.runId ?? ""}` : name;
  return TOPICS[name].scope === "repo" && opts.repo ? `${base}@${opts.repo}` : base;
}

interface Hello {
  readonly type: "hello";
  /** Different after every daemon start: a client that saw another epoch re-reads everything. */
  readonly epoch: string;
  /** The last `changed` sent (0: none yet); a gap after a reconnect means something was missed. */
  readonly seq: number;
}

interface Changed {
  readonly type: "changed";
  readonly epoch: string;
  /** One more than the last message's. */
  readonly seq: number;
  /** Sorted, each once. */
  readonly topics: readonly string[];
}

export type EventMessage = Hello | Changed;

export interface EventHubOptions {
  readonly windowMs?: number;
  /** Schedules the flush (setTimeout); returns what cancels it. Injected so tests need no clock. */
  readonly after?: (ms: number, fn: () => void) => () => void;
  readonly epoch?: string;
}

export interface EventHub {
  readonly epoch: string;
  /** The seq of the last message sent. */
  seq(): number;
  /** These topics changed: they go out together with whatever else changes within the window. */
  publish(topics: Iterable<string>): void;
  /** Hello now, every `changed` after; returns what unsubscribes. */
  subscribe(send: (message: EventMessage) => void): () => void;
  /** Drops what waits to go out. */
  stop(): void;
}

/**
 * Collects published topics for `windowMs` and sends them as one `changed`. The seq moves even
 * when nobody listens, so a client that reconnects sees that it missed something.
 */
export function createEventHub(opts: EventHubOptions = {}): EventHub {
  const windowMs = opts.windowMs ?? COALESCE_MS;
  const after =
    opts.after ??
    ((ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const epoch = opts.epoch ?? randomUUID();
  const subscribers = new Set<(message: EventMessage) => void>();
  const pending = new Set<string>();
  let seq = 0;
  let cancel: (() => void) | undefined;
  const flush = () => {
    cancel = undefined;
    if (pending.size === 0) return;
    seq += 1;
    const message: Changed = { type: "changed", epoch, seq, topics: [...pending].sort() };
    pending.clear();
    for (const send of subscribers) send(message);
  };
  return {
    epoch,
    seq: () => seq,
    publish(topics) {
      for (const t of topics) if (t !== "") pending.add(t);
      if (pending.size > 0 && !cancel) cancel = after(windowMs, flush);
    },
    subscribe(send) {
      subscribers.add(send);
      send({ type: "hello", epoch, seq });
      return () => {
        subscribers.delete(send);
      };
    },
    stop() {
      cancel?.();
      cancel = undefined;
      pending.clear();
      subscribers.clear();
    },
  };
}
