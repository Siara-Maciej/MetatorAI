/**
 * What the sidebar draws, as plain data (pure): the threads, their tasks and each task's row, every
 * value a row shows worked out once. A row reads its own entry by key (`state.ts`); kept with
 * `shared`, an entry that did not change is the same object, so only the rows that changed draw.
 * What depends on the place shown (the current row, a task unfolded because it holds it) is read
 * by the row from the route.
 */
import type { PaneAsk, PaneView, ThreadView } from "../../shared/api/api.ts";
import { type BoardCard, boardCards } from "../../shared/model/board.ts";
import { type FirstLevel, firstLevel } from "../../shared/model/look.ts";
import { paneNeedsYou } from "../../shared/model/needs.ts";
import { paneLabel, paneStateOf, panesOfRun } from "../../shared/model/panes.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { finishedText, isFinished, type Run, runLine, runWithPanes } from "../../shared/model/runs.ts";
import type { RepoSystemPlan } from "../../shared/model/system-plans.ts";
import {
  byAttentionFirst,
  subtasksByRepo,
  taskLine,
  taskState,
  type WorkTask,
  workTasks,
} from "../../shared/model/tasks.ts";
import {
  heldThread,
  type ThreadGroup,
  type ThreadWord,
  threadLine,
  threadPane,
  threadTree,
} from "../../shared/model/threads.ts";

type Pane = PaneView & { readonly repo?: string | undefined };

/** A pane of a task's own run, unfolded under it. */
export interface PaneRow {
  readonly id: string;
  readonly label: string;
  /** It asks (needs you), it works, or nothing (its finer word is in the run's terminal). */
  readonly word: "needs you" | "working" | undefined;
  readonly title: string;
}

/** A step or child run of a task, unfolded under it. */
export interface StepRow {
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  readonly word: FirstLevel;
  readonly pending: boolean;
  /** Its run, when it has started. */
  readonly runId: string | undefined;
  readonly repo: string | undefined;
  readonly terminalAsk: string | undefined;
  /** The system run whose Overview a step not started opens. */
  readonly systemRunId: string | undefined;
}

/** A task's row and what unfolds under it. */
export interface TaskRow {
  readonly key: string;
  readonly kind: WorkTask["kind"];
  readonly title: string;
  readonly word: FirstLevel;
  readonly sub: string;
  /** The hover text: a finished run says how it ended. */
  readonly hover: string;
  /** The task's own card's run: the row is current while its page shows. */
  readonly cardRunId: string | undefined;
  /** The task's own run, when the app has it (a click opens it). */
  readonly runId: string | undefined;
  readonly repo: string | undefined;
  /** The pane its run asks in, which a click shows. */
  readonly terminalAsk: string | undefined;
  /** The runs it holds (its own and its steps'): the task unfolds while one of them shows. */
  readonly holds: readonly string[];
  /** It has something to unfold: steps or child runs, or panes of its own run. */
  readonly canOpen: boolean;
  readonly panes: readonly PaneRow[];
  readonly steps: readonly { readonly repo: string; readonly rows: readonly StepRow[] }[];
}

/** A thread (or "Without a chat") and the keys of its tasks. */
interface GroupRow {
  readonly key: string;
  readonly threadId: string | undefined;
  readonly title: string;
  readonly closed: boolean;
  readonly word: ThreadWord;
  readonly line: string;
  readonly open: readonly string[];
  readonly finished: readonly string[];
}

export interface SideTree {
  /** The open threads, the closed ones, and "Without a chat", by group key. */
  readonly threads: readonly string[];
  readonly closed: readonly string[];
  readonly without: string | undefined;
  readonly groups: Readonly<Record<string, GroupRow>>;
  readonly tasks: Readonly<Record<string, TaskRow>>;
  /** The thread that holds what is shown: unfolded, whatever was folded before. */
  readonly shownThread: string | undefined;
}

export const EMPTY_TREE: SideTree = {
  threads: [],
  closed: [],
  without: undefined,
  groups: {},
  tasks: {},
  shownThread: undefined,
};

export interface SideInput {
  readonly runs: readonly Run[];
  readonly panes: readonly Pane[];
  readonly panesOf: (repo: string | undefined) => readonly Pane[];
  readonly systemPlans: readonly RepoSystemPlan[];
  readonly threads: readonly ThreadView[];
  readonly paneAsks: readonly PaneAsk[];
  /** What is shown: a thread's chat, or a run's page. */
  readonly shown: { readonly thread?: string | undefined; readonly runId?: string | undefined };
  readonly now: number;
}

/** The sidebar's tree, from the daemon's state and the place shown. */
export function sideTree(input: SideInput): SideTree {
  const { runs, panes, panesOf, systemPlans, threads, paneAsks } = input;
  const stateOf = (r: Run) =>
    runWithPanes(
      r,
      panesOfRun(panesOf(r.repo), r.runId).map((p) => paneStateOf(p)),
    );
  // The work as parent tasks (tasks.ts), from the same cards the Board shows.
  const tasks = byAttentionFirst(
    workTasks(boardCards({ runs, issues: [], plans: systemPlans, now: input.now }), systemPlans),
  );
  const runOf = (c: BoardCard) =>
    c.runId ? runs.find((r) => r.runId === c.runId && sameRepo(r.repo, c.repo)) : undefined;
  /** A task's word as its row says it: a run of its own reads its panes too (a conductor at work is working). */
  const wordOf = (t: WorkTask): FirstLevel => {
    const headRun = t.head ? runOf(t.head) : undefined;
    return t.kind === "run" && headRun && !isFinished(headRun) ? firstLevel(stateOf(headRun)) : taskState(t);
  };
  const tree = threadTree({
    threads,
    tasks,
    wordOf,
    chatAsks: (th) => {
      const p = threadPane(th, panes);
      return p !== undefined && (paneNeedsYou(p, paneAsks) || paneStateOf(p) === "asks");
    },
  });
  const taskRow = (t: WorkTask): TaskRow => {
    const headRun = t.head ? runOf(t.head) : undefined;
    const own = t.kind === "run" && headRun && !isFinished(headRun) ? headRun : undefined;
    const kids = own ? panesOfRun(panesOf(own.repo), own.runId) : [];
    return {
      key: t.key,
      kind: t.kind,
      title: t.title,
      word: wordOf(t),
      sub: t.kind === "run" && headRun ? runLine(headRun) : taskLine(t),
      hover: headRun && isFinished(headRun) ? `${t.title}\n${finishedText(headRun)}` : t.title,
      cardRunId: t.head?.runId,
      runId: headRun?.runId,
      repo: headRun?.repo,
      terminalAsk: headRun?.terminalAsk,
      holds: [t.head?.runId, ...t.subtasks.map((c) => c.runId)].filter((id) => id !== undefined),
      canOpen: t.subtasks.length > 0 || kids.length > 0,
      panes: kids.map((p) => {
        // A pane on the first level: it asks (needs you), it works, or nothing (its finer word,
        // idle or exited, is in the run's terminal).
        const st = paneStateOf(p);
        return {
          id: p.id,
          label: paneLabel(p),
          word: st === "asks" ? "needs you" : st === "working" ? "working" : undefined,
          title: `${p.id} · ${p.state?.reason ?? ""}`,
        };
      }),
      steps:
        t.kind === "run"
          ? []
          : subtasksByRepo(t).map((g) => ({
              repo: g.repo,
              rows: g.cards.map((c) => {
                const r = runOf(c);
                return {
                  key: c.key,
                  title: c.title,
                  sub: r
                    ? [
                        c.step ? `step ${c.step.at} of ${c.step.of}` : undefined,
                        isFinished(r) ? undefined : r.stage,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : c.waitsFor && c.waitsFor.length > 0
                      ? `not started · waits for ${c.waitsFor.join(", ")}`
                      : "not started · can start",
                  word: r ? firstLevel(stateOf(r)) : firstLevel(c.state),
                  pending: c.kind === "step",
                  runId: r?.runId,
                  repo: r?.repo,
                  terminalAsk: r?.terminalAsk,
                  systemRunId: c.systemRunId,
                };
              }),
            })),
    };
  };
  const rows: Record<string, TaskRow> = {};
  const groups: Record<string, GroupRow> = {};
  const add = (g: ThreadGroup<ThreadView>): string => {
    for (const t of [...g.open, ...g.finished]) rows[t.key] = taskRow(t);
    groups[g.key] = {
      key: g.key,
      threadId: g.thread?.id,
      title: g.thread?.title ?? g.title,
      closed: g.thread?.state === "closed",
      word: g.word,
      line: threadLine(g),
      open: g.open.map((t) => t.key),
      finished: g.finished.map((t) => t.key),
    };
    return g.key;
  };
  return {
    threads: tree.threads.map(add),
    closed: tree.closed.map(add),
    without: tree.without ? add(tree.without) : undefined,
    groups,
    tasks: rows,
    shownThread: heldThread(threads, tasks, input.shown)?.id,
  };
}

/** The thread with this id, to act on (its menu, a click). */
export const threadById = (threads: readonly ThreadView[], id: string | undefined): ThreadView | undefined =>
  id === undefined ? undefined : threads.find((t) => t.id === id);
