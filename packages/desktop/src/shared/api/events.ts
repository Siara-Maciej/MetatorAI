/**
 * The daemon's push channel, as the app reads it (ADR-0110): `/ws/events` says which topics
 * changed, never their data. A message is checked before it is believed (Zod); what it means for
 * the app's queries is pure here: which topics to read again, or all of them when a message was
 * missed (a gap in `seq`) or the daemon is another one (a new `epoch`).
 */
import { z } from "zod";

/** The topics the daemon names (ADR-0110); `activity:<run>`, and `@<repo>` in a folder, narrow one. */
export const TOPICS = [
  "state",
  "inbox",
  "layout",
  "threads",
  "options",
  "plans",
  "reviews",
  "backlog",
  "activity",
] as const;
export type Topic = (typeof TOPICS)[number];

const Hello = z.object({ type: z.literal("hello"), epoch: z.string(), seq: z.number().int().nonnegative() });
const Changed = z.object({
  type: z.literal("changed"),
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  topics: z.array(z.string()),
});
export const EventMessage = z.discriminatedUnion("type", [Hello, Changed]);
export type EventMessage = z.infer<typeof EventMessage>;

/** What the app knows of the channel: the daemon's start and the last message it read. */
export interface Channel {
  readonly epoch: string | undefined;
  readonly seq: number;
}

export const NO_CHANNEL: Channel = { epoch: undefined, seq: 0 };

/** A topic without its run and repository: `activity:r1@shop` is `activity`. */
export function topicBase(topic: string): string {
  return topic.split("@")[0]?.split(":")[0] ?? topic;
}

/**
 * One message read: the channel after it, and what to read again. A hello from a daemon already
 * known at the same `seq` reads nothing again; any other hello (another daemon, or messages missed
 * while the socket was down) reads all. A change right after the last one reads its topics; a gap
 * reads all. Something that is not a message reads nothing and changes nothing.
 */
export function readEvent(
  channel: Channel,
  raw: unknown,
): { readonly channel: Channel; readonly read: "all" | readonly string[] } {
  const m = EventMessage.safeParse(raw);
  if (!m.success) return { channel, read: [] };
  const e = m.data;
  const same = channel.epoch === e.epoch;
  if (e.type === "hello") {
    const caughtUp = same && channel.seq === e.seq;
    return { channel: { epoch: e.epoch, seq: e.seq }, read: caughtUp ? [] : "all" };
  }
  const next = { epoch: e.epoch, seq: e.seq };
  if (!same || e.seq !== channel.seq + 1) return { channel: next, read: "all" };
  return { channel: next, read: [...new Set(e.topics.map(topicBase))] };
}

/**
 * The topic a polled request reads, from its key's first word. A request the table does not name
 * is read again whenever the state changes (`state`): a guess on the safe side.
 */
const BY_PREFIX: Readonly<Record<string, Topic>> = {
  layout: "layout",
  options: "options",
  supervisor: "options",
  hosts: "options",
  workflows: "options",
  "new-session": "options",
  "system-map": "options",
  "system-plans": "plans",
  "system-plans-of": "plans",
  "system-plans-all": "plans",
  "system-plan": "plans",
  "card-plan": "plans",
  "run-plan": "plans",
  plan: "plans",
  "retry-steps-plan": "plans",
  "retry-steps-of": "plans",
  "step-items": "plans",
  "from-plan": "plans",
  threads: "threads",
  reviews: "reviews",
  mrs: "reviews",
  issues: "backlog",
  "issue-detail": "backlog",
  "board-issues": "backlog",
  activity: "activity",
};

export function topicOfKey(key: string): Topic {
  return BY_PREFIX[key.split(/[:\n]/)[0] ?? ""] ?? "state";
}

/**
 * The topics the daemon names after every change, whoever made it (its sweep reads what other
 * processes write): their queries need polling only as a fallback. The others it names only after
 * a request it answered, so their queries keep their own interval as well.
 */
export const SWEPT: ReadonlySet<Topic> = new Set<Topic>(["layout", "threads"]);

/** A query of `topic` is read again for these changed topics. */
export function readsAgain(topic: Topic, changed: readonly string[]): boolean {
  return changed.includes(topic);
}
