/**
 * Terminals by task (pure, tested; round 8): the tree the Terminals screen draws from the runs
 * and the panes, with no route of its own. A task is a top run (a system run, a run of its own);
 * its main terminal is the pane where the person gave the task (the intake chat whose agent
 * started it, `startedRun`), else the task run's own conductor; then one repository session per
 * child run (its conductor pane); a session's sub-terminals (its workers, its shells) are shown
 * only in that session's own view. Ended panes stay until a person closes them.
 */
import type { PaneView, RunOverview } from "./api.ts";
import { type GotoRow, type PaneShown, paneLabel, paneStateOf, sameRepo } from "./model.ts";
import { repoLabel } from "./plan-flow.ts";

type TPane = PaneView & { readonly repo?: string | undefined };
type TRun = Pick<RunOverview, "runId" | "task" | "status" | "children" | "parent"> & {
  readonly repo?: string | undefined;
};

/** One terminal session of a run: its conductor pane, and the sub-terminals under it. */
export interface Session {
  readonly runId: string;
  readonly repo?: string | undefined;
  /** What the tile says: its repository (and its step, when the task's plan names one). */
  readonly label: string;
  readonly task: string;
  /** The session's main terminal: the run's conductor. */
  readonly pane?: TPane | undefined;
  /** Its workers, shells and applications: in the session's own view only. */
  readonly subs: readonly TPane[];
}

export interface TerminalTask {
  /** The task run's id: the view's address (`#/grid/task/<run>`). */
  readonly runId: string;
  readonly repo?: string | undefined;
  readonly title: string;
  readonly status: string;
  /** Where the person gave the task, else the task run's conductor. */
  readonly main?: TPane | undefined;
  /** The task run's own session when its main terminal is that conductor (its sub-terminals). */
  readonly own: Session;
  /** One per repository session working on it: the child runs (and the task run itself when the person gave the task in an intake chat). */
  readonly sessions: readonly Session[];
}

const conductorOf = (panes: readonly TPane[], r: TRun) =>
  panes.find((p) => p.runId === r.runId && sameRepo(p.repo, r.repo) && p.role === "conductor");
const subsOf = (panes: readonly TPane[], r: TRun) =>
  panes.filter((p) => p.runId === r.runId && sameRepo(p.repo, r.repo) && p.role !== "conductor");

function sessionOf(panes: readonly TPane[], r: TRun, label: string): Session {
  return {
    runId: r.runId,
    repo: r.repo,
    label,
    task: r.task,
    pane: conductorOf(panes, r),
    subs: subsOf(panes, r),
  };
}

/**
 * Every task with a terminal, in the order of the runs: a top run (one no other run lists as its
 * child) that has a pane, or a child with one. `stepOf` names a child's step for its tile.
 */
export function terminalTasks(
  runs: readonly TRun[],
  panes: readonly TPane[],
  stepOf: (runId: string) => string | undefined = () => undefined,
): TerminalTask[] {
  const childIds = new Set(runs.flatMap((r) => r.children ?? []));
  const tops = runs.filter((r) => !childIds.has(r.runId) && !r.parent);
  const out: TerminalTask[] = [];
  for (const top of tops) {
    // A system run lists its children; a run started with `--parent` names its parent instead.
    const children = [
      ...(top.children ?? []).map((id) => runs.find((r) => r.runId === id)),
      ...runs.filter((r) => r.parent === top.runId && !(top.children ?? []).includes(r.runId)),
    ].filter((r): r is TRun => r !== undefined);
    const intake = panes.find((p) => p.startedRun === top.runId);
    const own = sessionOf(panes, top, top.repo ? repoLabel(top.repo) : "this repository");
    const childSessions = children.map((c) => {
      const step = stepOf(c.runId);
      const where = c.repo ? repoLabel(c.repo) : "this repository";
      return sessionOf(panes, c, step ? `${where} · ${step}` : where);
    });
    // Given in an intake chat: the chat is the main terminal, the task run's conductor a session.
    const sessions = intake && (own.pane || own.subs.length > 0) ? [own, ...childSessions] : childSessions;
    const main = intake ?? own.pane;
    const any = main || sessions.some((s) => s.pane || s.subs.length > 0) || own.subs.length > 0;
    if (!any) continue;
    out.push({
      runId: top.runId,
      repo: top.repo,
      title: top.task,
      status: top.status,
      main,
      own,
      sessions,
    });
  }
  return out;
}

/** Every pane a task holds: its main terminal, its sessions and all their sub-terminals. */
export const panesOfTask = (t: TerminalTask): TPane[] =>
  [
    t.main,
    ...t.own.subs,
    ...(t.own.pane && t.own.pane !== t.main ? [t.own.pane] : []),
    ...t.sessions.flatMap((s) => [s.pane, ...s.subs]),
  ].filter((p, i, all): p is TPane => p !== undefined && all.indexOf(p) === i);

/** The panes of a task's main view, side by side: the main terminal, then a tile per session. */
export const taskView = (t: TerminalTask): TPane[] =>
  [t.main, ...t.sessions.map((s) => s.pane)].filter(
    (p, i, all): p is TPane => p !== undefined && all.indexOf(p) === i,
  );

/** A session's own view: its main terminal, then its sub-terminals. */
export const sessionView = (s: Session): TPane[] =>
  [s.pane, ...s.subs].filter((p): p is TPane => p !== undefined);

/** The session of a run in a task: a child's, or the task run's own. */
export const sessionIn = (t: TerminalTask, runId: string): Session | undefined =>
  t.sessions.find((s) => s.runId === runId) ?? (t.own.runId === runId ? t.own : undefined);

/** Where a pane is shown: its task, and the session whose own view holds it (a sub-terminal). */
export function whereIs(
  tasks: readonly TerminalTask[],
  paneId: string,
): { readonly task: TerminalTask; readonly session?: string | undefined } | undefined {
  for (const t of tasks) {
    if (taskView(t).some((p) => p.id === paneId)) return { task: t };
    const s = [t.own, ...t.sessions].find((x) => x.subs.some((p) => p.id === paneId));
    if (s) return { task: t, session: s.runId };
  }
  return undefined;
}

/** A pane whose work is over: the daemon says so (`ended`), or its process is gone. */
export const isEnded = (p: Pick<PaneView, "ended" | "live">): boolean =>
  p.ended !== undefined || (p.live !== undefined && !p.live.alive);

/** The banner of an ended pane, in the done tone or, after a non-zero exit, the error tone. */
export function endedBanner(p: Pick<PaneView, "ended" | "live">): {
  readonly text: string;
  readonly tone: "done" | "error";
} {
  const code = p.ended?.exitCode ?? p.live?.exitCode;
  const why =
    p.ended?.summary ??
    (p.ended?.reason === "run-finished"
      ? "its run finished"
      : p.ended?.reason === "collected"
        ? "its result was collected"
        : p.ended?.reason === "closed-by-host"
          ? "the host ended it"
          : "its process ended");
  if (code !== undefined && code !== 0) return { text: `Ended with code ${code} — ${why}`, tone: "error" };
  return { text: `Finished — ${why}`, tone: "done" };
}

/** A session tile's badge: how many sub-terminals it has, and what they are doing. */
export function subBadge(s: Pick<Session, "subs">, now: number = Date.now()): string | undefined {
  if (s.subs.length === 0) return undefined;
  const states = s.subs.map((p) => (isEnded(p) ? "finished" : paneStateOf(p, now)));
  const count = (w: PaneShown) =>
    states.filter((x) => x === w || (w === "finished" && x === "exited")).length;
  return [
    `${s.subs.length} sub-terminal${s.subs.length === 1 ? "" : "s"}`,
    count("asks") > 0 ? `${count("asks")} asks` : undefined,
    count("working") > 0 ? `${count("working")} working` : undefined,
    count("finished") > 0 ? `${count("finished")} finished` : undefined,
  ]
    .filter((x) => x !== undefined)
    .join(" · ");
}

/** The go-to picker's hierarchy for a pane of a task: `task › shop-api › mt-implementer-1`. */
export function pathOf(t: TerminalTask, p: TPane): string {
  if (p === t.main) return `${t.title} › main terminal`;
  const s = [t.own, ...t.sessions].find((x) => x.pane === p || x.subs.includes(p));
  if (!s) return t.title;
  return s.pane === p ? `${t.title} › ${s.label}` : `${t.title} › ${s.label} › ${paneLabel(p)}`;
}

/** The go-to picker's rows for the tasks' panes: each with its place, `task › repo › worker`. */
export function taskGotoRows(tasks: readonly TerminalTask[]): GotoRow[] {
  const rows: GotoRow[] = [];
  for (const t of tasks)
    for (const p of panesOfTask(t)) {
      const where = whereIs([t], p.id);
      rows.push({
        kind: "pane",
        id: `task:${t.runId}:${p.id}`,
        path: pathOf(t, p),
        task: { runId: t.runId, session: where?.session },
        label: paneLabel(p),
        // The path names where it is; the detail what runs in it.
        detail: paneLabel(p),
        state: isEnded(p) ? "finished" : paneStateOf(p),
        paneId: p.id,
      });
    }
  return rows;
}
