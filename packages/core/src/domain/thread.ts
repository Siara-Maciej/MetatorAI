import { z } from "zod";
import { slug } from "./ids.ts";
import { type Attention, byAttention } from "./overview.ts";
import { FOLDER_PLACE } from "./repo-set.ts";
import { defineDocument } from "./versioned.ts";

/**
 * A thread (ADR-0095): one topic a person talks about with the chat agent. It outlives the app and
 * its terminals: what MetatorAI keeps of it (the summary the agent writes, the runs started in it,
 * the facts the daemon appends) is what a new session reads first (`metator thread show`).
 * `.metator/threads/<id>.json`, next to the layout whose chat pane it opened.
 */
export const THREAD_ID = /^[0-9]{8}-[a-z0-9-]{1,60}$/;
export const THREAD_TITLE_MAX = 80;
export const THREAD_SUMMARY_MAX = 1500;
/** The facts a thread keeps: the newest; the oldest is dropped. */
export const THREAD_FACTS_MAX = 50;
/** A fact is one line. */
export const THREAD_FACT_LENGTH = 300;
/** A thread is open or closed (never deleted by itself); a review thread's states are another thing. */
const STATES = ["open", "closed"] as const;

const ThreadPaneSchema = z.strictObject({
  /** In a folder: the repository the pane is in. */
  repo: z.string().min(1).optional(),
  paneId: z.string().min(1),
  /** The host session the pane ran, kept when the pane ends: a reopened thread continues it. */
  hostSession: z.string().min(1).optional(),
  at: z.iso.datetime(),
});
export type ThreadPane = z.output<typeof ThreadPaneSchema>;

const FactSchema = z.strictObject({ at: z.iso.datetime(), text: z.string().min(1).max(THREAD_FACT_LENGTH) });
export type ThreadFact = z.output<typeof FactSchema>;

export const ThreadSchema = z.strictObject({
  id: z.string().regex(THREAD_ID),
  title: z.string().min(1).max(THREAD_TITLE_MAX),
  state: z.enum(STATES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().optional(),
  /** What the agent keeps of the topic (Markdown): decisions, what is open. Empty until it writes one. */
  summary: z.string().max(THREAD_SUMMARY_MAX),
  /** The top runs started in it, in the order they started. */
  runs: z.array(z.string().min(1)),
  /** Backlog items made in it (ADR-0096). */
  issues: z.array(z.string().min(1)),
  /** Merge requests it watches. */
  mrs: z.array(z.string().min(1)),
  /** The chat terminals it has had; the last one is current. */
  panes: z.array(ThreadPaneSchema),
  /** What opened it: a Backlog item, or another thread whose topic changed. */
  from: z
    .strictObject({ issue: z.string().min(1).optional(), thread: z.string().min(1).optional() })
    .optional(),
  /** Lines the daemon appends (a run started, finished; the thread closed), newest last. */
  facts: z.array(FactSchema).max(THREAD_FACTS_MAX),
});
export type Thread = z.output<typeof ThreadSchema>;

export const ThreadDocument = defineDocument("Thread", {
  latest: ThreadSchema,
  hint: "Written by the daemon and `metator thread`; the agent writes its summary with `metator thread summary`.",
});

/** The id of a new thread: the day and its title's words (`20261122-price-rounding`), `-2` when taken. */
export function threadId(title: string, at: Date, taken: (id: string) => boolean): string {
  const day = at.toISOString().slice(0, 10).replaceAll("-", "");
  const base = `${day}-${slug(title, 40, "chat")}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** The thread with one more fact: one line, the newest 50 kept; the thread is updated then. */
export function threadWithFact(thread: Thread, text: string, at: string): Thread {
  const line = text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim()
    .slice(0, THREAD_FACT_LENGTH);
  const facts = [...thread.facts, { at, text: line }];
  return { ...thread, facts: facts.slice(Math.max(0, facts.length - THREAD_FACTS_MAX)), updatedAt: at };
}

/** The thread that lists a run, if any. */
export const threadOfRun = <T extends Pick<Thread, "runs">>(
  threads: readonly T[],
  runId: string,
): T | undefined => threads.find((t) => t.runs.includes(runId));

/** A run as the sidebar shows it under its thread: a top run with who must act. */
export interface ThreadTask {
  readonly runId: string;
  /** In a folder: the repository the run is in. */
  readonly repo?: string;
  readonly task: string;
  readonly status: string;
  readonly stage: string;
  readonly attention: Attention;
  readonly updatedAt: string;
  readonly parent?: string;
  readonly children?: readonly string[];
}

/** A thread with its tasks, as the sidebar draws it. */
export type ThreadNode<T extends Thread = Thread> = T & {
  readonly tasks: readonly ThreadTask[];
  /** The most urgent task's attention; absent when it has none (a chat without a task). */
  readonly attention?: Attention;
};

export interface ThreadTree<T extends Thread = Thread> {
  /** Open threads: one whose task needs you first, then the most recently updated. */
  readonly threads: readonly ThreadNode<T>[];
  /** Closed threads, the most recently closed first. */
  readonly closed: readonly ThreadNode<T>[];
  /** Every top run no thread lists (the form, the intake rules, `metator run new` in a terminal, CI). */
  readonly withoutChat: readonly ThreadTask[];
}

/**
 * The sidebar's one hierarchy (ADR-0095): each thread with its own top runs, the runs no thread
 * lists apart ("Without a chat"), closed threads in their own group. A child run is never a task
 * of its own: it is under its parent. In a folder a thread's run is in the thread's repository; a thread of the folder itself lists runs of any repository.
 */
export function threadTree<T extends Thread & { readonly repo?: string }>(
  threads: readonly T[],
  runs: readonly ThreadTask[],
): ThreadTree<T> {
  const top = runs.filter((r) => !r.parent);
  const key = (repo: string | undefined, runId: string) => `${repo ?? ""}\n${runId}`;
  const byKey = new Map(top.map((r) => [key(r.repo, r.runId), r]));
  const listed = new Set<string>();
  const nodes = threads.map((t): ThreadNode<T> => {
    const tasks = byAttention(
      t.runs.flatMap((id) => {
        // A thread of the folder itself (ADR-0114) lists runs of any of its repositories.
        const r =
          t.repo === FOLDER_PLACE
            ? top.find((x) => x.runId === id && !listed.has(key(x.repo, x.runId)))
            : byKey.get(key(t.repo, id));
        if (!r) return [];
        listed.add(key(r.repo, r.runId));
        return [r];
      }),
    );
    const first = tasks[0];
    return { ...t, tasks, ...(first ? { attention: first.attention } : {}) };
  });
  // ISO times sort as text: the newest change of the thread or of one of its tasks.
  const latest = (n: ThreadNode<T>) =>
    [n.updatedAt, ...n.tasks.map((x) => x.updatedAt)].sort().at(-1) as string;
  const needsYou = (n: ThreadNode<T>) => (n.tasks.some((x) => x.attention === "you") ? 0 : 1);
  return {
    threads: nodes
      .filter((n) => n.state === "open")
      .sort(
        (a, b) => needsYou(a) - needsYou(b) || latest(b).localeCompare(latest(a)) || b.id.localeCompare(a.id),
      ),
    closed: nodes
      .filter((n) => n.state === "closed")
      .sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt)),
    withoutChat: byAttention(top.filter((r) => !listed.has(key(r.repo, r.runId)))),
  };
}
