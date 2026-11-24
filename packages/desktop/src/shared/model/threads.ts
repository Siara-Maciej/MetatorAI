/**
 * Threads in the sidebar (pure, tested; round 16, ADR-0095): one hierarchy, thread → its tasks
 * (the rows of `tasks.ts`, unchanged inside) → repositories → steps. A thread is one topic with
 * its chat terminal; a task belongs to the thread whose `runs` hold its top run. Every task no
 * thread holds is in "Without a chat" (derived, no document); closed threads go under
 * "Closed (N)". A thread row says one word: its most urgent task's, or `chat` when it has none.
 */
import type { PaneView } from "../api/api.ts";
import { plural } from "./format.ts";
import type { FirstLevel } from "./look.ts";
import { sameRepo } from "./places.ts";
import { taskState, type WorkTask } from "./tasks.ts";

/** What the sidebar reads of a thread (`GET /threads`, core's `Thread` v1). */
export interface ThreadLike {
  readonly id: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly updatedAt: string;
  readonly closedAt?: string | undefined;
  /** The top runs started in it. */
  readonly runs: readonly string[];
  /** The chat terminals it has had; the last one is current. */
  readonly panes: readonly { readonly repo?: string | undefined; readonly paneId: string }[];
  /** The repository whose daemon keeps it, when the daemon serves a folder. */
  readonly repo?: string | undefined;
}

/** A thread row's word: one of the first level's four, or `chat` when no task is in it. */
export type ThreadWord = FirstLevel | "chat";

/** One group of the sidebar: a thread with its tasks, or "Without a chat". */
export interface ThreadGroup<T extends ThreadLike = ThreadLike> {
  readonly key: string;
  /** None for "Without a chat". */
  readonly thread?: T | undefined;
  readonly title: string;
  /** Its tasks that are not finished, what needs the person first (the order they came in). */
  readonly open: readonly WorkTask[];
  /** Its finished tasks, behind "Show finished (N)". */
  readonly finished: readonly WorkTask[];
  readonly word: ThreadWord;
  /** The newest change of the thread or of any of its tasks. */
  readonly updatedAt: string;
}

export interface ThreadTree<T extends ThreadLike = ThreadLike> {
  /** Open threads: what needs the person first, then the most recently updated. */
  readonly threads: readonly ThreadGroup<T>[];
  /** Tasks no thread holds; absent when there is none. */
  readonly without?: ThreadGroup<T> | undefined;
  /** Closed threads, the most recently closed first. */
  readonly closed: readonly ThreadGroup<T>[];
}

/** The key of the "Without a chat" group. */
export const WITHOUT_CHAT = "without-chat";

/** The runs of a task that a thread may name: its head's, then its steps' and child runs'. */
const runsOfTask = (t: Pick<WorkTask, "head" | "subtasks">): string[] =>
  [t.head?.runId, ...t.subtasks.map((c) => c.runId)].filter((r): r is string => r !== undefined);

/** The repository of a task: its head's, else its first card's. */
const repoOfTask = (t: Pick<WorkTask, "head" | "subtasks">): string | undefined =>
  t.head?.repo ?? t.subtasks[0]?.repo;

/**
 * The thread a task belongs to: the one whose `runs` hold its top run (or one of its runs, for a
 * task whose head is not a run yet). In a folder a thread's runs are in its own repository.
 */
export function threadOfTask<T extends ThreadLike>(
  threads: readonly T[],
  task: Pick<WorkTask, "head" | "subtasks">,
): T | undefined {
  const runs = runsOfTask(task);
  if (runs.length === 0) return undefined;
  const repo = repoOfTask(task);
  return threads.find(
    (th) =>
      (th.repo === undefined || repo === undefined || sameRepo(th.repo, repo)) &&
      th.runs.some((r) => runs.includes(r)),
  );
}

/** What wins when tasks meet in a thread: the person first, then what stands still, then work. */
const URGENCY: Readonly<Record<FirstLevel, number>> = {
  "needs you": 0,
  blocked: 1,
  working: 2,
  done: 3,
};

/**
 * A thread's word: `needs you` when its chat asks, else its most urgent task's word among the
 * open ones, `done` when all its tasks are finished, `chat` when it has none.
 */
export function threadWord(
  open: readonly WorkTask[],
  finished: readonly WorkTask[],
  chatAsks = false,
  wordOf: (t: WorkTask) => FirstLevel = taskState,
): ThreadWord {
  if (chatAsks) return "needs you";
  if (open.length > 0)
    return open.map(wordOf).reduce<FirstLevel>((best, w) => (URGENCY[w] < URGENCY[best] ? w : best), "done");
  return finished.length > 0 ? "done" : "chat";
}

const newest = (dates: readonly string[]): string =>
  dates.reduce((best, d) => (d.localeCompare(best) > 0 ? d : best), "");

/**
 * The sidebar's tree: each thread with its tasks, the tasks no thread holds, the closed threads.
 * `tasks` come in the sidebar's order (`byAttentionFirst`) and keep it inside a group. A task is
 * finished when its column is Done.
 */
export function threadTree<T extends ThreadLike>(input: {
  readonly threads: readonly T[];
  readonly tasks: readonly WorkTask[];
  /** The thread's chat terminal asks the person. */
  readonly chatAsks?: ((thread: T) => boolean) | undefined;
  /** A task's word as its row shows it (a run of its own reads its panes too). */
  readonly wordOf?: ((t: WorkTask) => FirstLevel) | undefined;
}): ThreadTree<T> {
  const { threads, tasks } = input;
  const wordOf = input.wordOf ?? taskState;
  const isDone = (t: WorkTask) => t.column === "done";
  const held = new Map<string, WorkTask[]>();
  const without: WorkTask[] = [];
  for (const t of tasks) {
    const th = threadOfTask(threads, t);
    if (th) held.set(th.id, [...(held.get(th.id) ?? []), t]);
    else without.push(t);
  }
  const groupOf = (th: T): ThreadGroup<T> => {
    const all = held.get(th.id) ?? [];
    const open = all.filter((t) => !isDone(t));
    const finished = all.filter(isDone);
    return {
      key: `thread:${th.id}`,
      thread: th,
      title: th.title,
      open,
      finished,
      word: threadWord(open, finished, input.chatAsks?.(th) ?? false, wordOf),
      updatedAt: newest([th.updatedAt, ...all.map((t) => t.updatedAt)]),
    };
  };
  const open = threads
    .filter((th) => th.state === "open")
    .map(groupOf)
    .sort(
      (a, b) =>
        Number(b.word === "needs you") - Number(a.word === "needs you") ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.key.localeCompare(b.key),
    );
  const closed = threads
    .filter((th) => th.state === "closed")
    .map(groupOf)
    .sort(
      (a, b) =>
        (b.thread?.closedAt ?? b.updatedAt).localeCompare(a.thread?.closedAt ?? a.updatedAt) ||
        a.key.localeCompare(b.key),
    );
  const loose =
    without.length > 0
      ? (() => {
          const o = without.filter((t) => !isDone(t));
          const f = without.filter(isDone);
          return {
            key: WITHOUT_CHAT,
            title: "Without a chat",
            open: o,
            finished: f,
            word: threadWord(o, f, false, wordOf),
            updatedAt: newest(without.map((t) => t.updatedAt)),
          };
        })()
      : undefined;
  return { threads: open, ...(loose ? { without: loose } : {}), closed };
}

/** A thread row's dim line: how many tasks it holds; nothing when it holds none. */
export function threadLine(g: Pick<ThreadGroup, "open" | "finished">): string {
  const n = g.open.length + g.finished.length;
  return n === 0 ? "" : plural(n, "task");
}

/**
 * A thread's chat terminal in the layout: the last pane it names that the layout still has, else
 * the newest pane the layout marks with its id (Layout v5 `threadId`).
 */
export function threadPane<P extends Pick<PaneView, "id"> & { readonly repo?: string | undefined }>(
  thread: Pick<ThreadLike, "id" | "panes" | "repo">,
  panes: readonly (P & { readonly threadId?: string | undefined })[],
): P | undefined {
  for (const named of [...thread.panes].reverse()) {
    const repo = named.repo ?? thread.repo;
    const p = panes.find((x) => x.id === named.paneId && sameRepo(x.repo, repo));
    if (p) return p;
  }
  return [...panes].reverse().find((x) => x.threadId === thread.id);
}

/** The title of the thread a task belongs to, for Home's dim prefix. */
export const threadTitleOf = (
  threads: readonly ThreadLike[],
  task: Pick<WorkTask, "head" | "subtasks">,
): string | undefined => threadOfTask(threads, task)?.title;

/** The thread that holds what the route shows: the thread itself, or a task of it. */
export function heldThread<T extends ThreadLike>(
  threads: readonly T[],
  tasks: readonly WorkTask[],
  shown: { readonly thread?: string | undefined; readonly runId?: string | undefined },
): T | undefined {
  if (shown.thread) return threads.find((t) => t.id === shown.thread);
  if (!shown.runId) return undefined;
  const runId = shown.runId;
  const task = tasks.find((t) => t.head?.runId === runId || t.subtasks.some((c) => c.runId === runId));
  return task ? threadOfTask(threads, task) : undefined;
}

/** A thread's title is at most this long (core's `Thread` v1). */
export const TITLE_MAX = 80;

/**
 * The title of a chat started from a person's words (Home's "Describe a task"): their first line,
 * cut at a word to fit the title's limit.
 */
export function chatTitleOf(words: string): string {
  const line = (words.split("\n").find((l) => l.trim() !== "") ?? "").trim().replace(/\s+/g, " ");
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What `/state` says of the threads (round 16): how many, and when one last changed. */
interface ThreadsCount {
  readonly open?: number;
  readonly closed?: number;
  readonly updatedAt?: string;
}

/**
 * A stamp of the threads from `/state` (a repository's, or each of a folder's): when it changes,
 * a thread changed and `GET /threads` is read again. Empty from a daemon that does not count them.
 */
export function threadsStamp(state: unknown): string {
  const one = (x: unknown): string => {
    const t = (x as { readonly threads?: ThreadsCount } | undefined)?.threads;
    return t ? `${t.open ?? 0}/${t.closed ?? 0}/${t.updatedAt ?? ""}` : "";
  };
  const repos = (state as { readonly repos?: readonly unknown[] } | undefined)?.repos;
  return Array.isArray(repos) ? repos.map(one).join("|") : one(state);
}

/**
 * The thread to switch to (a topic change): a thread that was not there before, opened from the
 * thread on screen (`from.thread`). The agent's `metator thread new` makes it; the app follows.
 */
export function followedThread<
  T extends Pick<ThreadLike, "id"> & { readonly from?: { readonly thread?: string | undefined } | undefined },
>(before: readonly string[], threads: readonly T[], shown: string | undefined): T | undefined {
  if (shown === undefined) return undefined;
  return threads.find((t) => t.from?.thread === shown && !before.includes(t.id));
}
