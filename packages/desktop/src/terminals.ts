/**
 * Terminals by task (pure, tested; round 8): the tree the Terminals screen draws from the runs
 * and the panes, with no route of its own. A task is a top run (a system run, a run of its own);
 * its main terminal is the pane where the person gave the task (the intake chat whose agent
 * started it, `startedRun`), else the task run's own conductor; then one repository session per
 * child run (its conductor pane); a session's sub-terminals (its workers, its shells) are shown
 * only in that session's own view. Ended panes stay until a person closes them.
 */
import type { ContinueResult, PanePaused, PaneView, RunOverview } from "./api.ts";
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

/**
 * A pane's key in a task's views: its repository and its id. Each repository numbers its own
 * panes (`w1:p1` in billing and in shop-api), so the id alone names two panes in one task.
 */
export const paneKey = (p: Pick<TPane, "id" | "repo">): string => (p.repo ? `${p.repo}|${p.id}` : p.id);

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

/**
 * Where a pane is shown: its task, and the session whose own view holds it (a sub-terminal).
 * `key` is the pane's key (`paneKey`); a bare id (a route from a tab) is looked for after it.
 */
export function whereIs(
  tasks: readonly TerminalTask[],
  key: string,
): { readonly task: TerminalTask; readonly session?: string | undefined } | undefined {
  for (const fits of [(p: TPane) => paneKey(p) === key, (p: TPane) => p.id === key])
    for (const t of tasks) {
      if (taskView(t).some(fits)) return { task: t };
      const s = [t.own, ...t.sessions].find((x) => x.subs.some(fits));
      if (s) return { task: t, session: s.runId };
    }
  return undefined;
}

/**
 * What "Close finished" closes: on a session's view its finished terminals; on a task's view
 * every finished terminal of the task, its sub-terminals too (the badges count them), so none is
 * left open where no view shows it.
 */
export const finishedOf = (t: TerminalTask, s?: Session): TPane[] =>
  (s ? sessionView(s) : panesOfTask(t)).filter((p) => p.ended !== undefined);

/** Why a pane is paused (round 11): its host stopped with the daemon, or was lost; its work is not over. */
export const pausedOf = (p: object): PanePaused | undefined => (p as { paused?: PanePaused }).paused;

/** A pane whose work is over: the daemon says so (`ended`), or its process is gone (not paused). */
export const isEnded = (p: Pick<PaneView, "ended" | "live">): boolean =>
  p.ended !== undefined || (p.live !== undefined && !p.live.alive && pausedOf(p) === undefined);

/** The banner of a paused pane, in the neutral tone: why, and that Continue starts it again. */
export function pausedBanner(p: object): string | undefined {
  const why = pausedOf(p)?.why;
  if (!why) return undefined;
  return `Paused — ${why === "daemon-stopped" ? "the daemon stopped" : "its process was lost"}`;
}

/** The banner of an ended pane, in the done tone or, after a non-zero exit, the error tone. */
export function endedBanner(p: Pick<PaneView, "ended" | "live">): {
  readonly text: string;
  readonly tone: "done" | "error";
} {
  // A pane the daemon ended (its worker collected, its run finished, the host ended it) exits with
  // the signal the daemon sent: that code is no failure. Only a process that exited by itself has one.
  const stopped = p.ended !== undefined && p.ended.reason !== "exited";
  const code = stopped ? undefined : (p.ended?.exitCode ?? p.live?.exitCode);
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
  const states = s.subs.map((p) => (pausedOf(p) ? "paused" : isEnded(p) ? "finished" : paneStateOf(p, now)));
  const count = (w: PaneShown) =>
    states.filter((x) => x === w || (w === "finished" && x === "exited")).length;
  return [
    `${s.subs.length} sub-terminal${s.subs.length === 1 ? "" : "s"}`,
    count("asks") > 0 ? `${count("asks")} asks` : undefined,
    count("working") > 0 ? `${count("working")} working` : undefined,
    count("paused") > 0 ? `${count("paused")} paused` : undefined,
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
      const where = whereIs([t], paneKey(p));
      rows.push({
        kind: "pane",
        id: `task:${t.runId}:${paneKey(p)}`,
        path: pathOf(t, p),
        task: { runId: t.runId, session: where?.session },
        label: paneLabel(p),
        // The path names where it is; the detail what runs in it.
        detail: paneLabel(p),
        state: isEnded(p) ? "finished" : paneStateOf(p),
        paneId: p.id,
        focusKey: paneKey(p),
      });
    }
  return rows;
}

/**
 * What "Continue task" would start (round 11): the task's paused panes, and its active runs that
 * nothing drives (no live conductor, no drive). The button shows while either count is not 0.
 */
export function toContinue(
  t: TerminalTask,
  runs: readonly (Pick<RunOverview, "runId" | "status" | "driving"> & {
    readonly repo?: string | undefined;
  })[],
): { readonly paused: number; readonly undriven: number } {
  const panes = panesOfTask(t);
  const ids = [t.runId, ...t.sessions.map((s) => s.runId)].filter((id, i, all) => all.indexOf(id) === i);
  const undriven = ids.filter((id) => {
    const r = runs.find((x) => x.runId === id);
    if (r?.status !== "active" || r.driving) return false;
    return !panes.some((p) => p.runId === id && p.role === "conductor" && p.live?.alive && !pausedOf(p));
  }).length;
  return { paused: panes.filter((p) => pausedOf(p) !== undefined && !p.ended).length, undriven };
}

/** What a Continue did, in one line for its notice. */
export function continueText(r: ContinueResult): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const said = [
    r.resumed.length > 0 ? `resumed ${n(r.resumed.length, "terminal")}` : undefined,
    r.drives.length > 0 ? `restarted ${n(r.drives.length, "drive")}` : undefined,
  ].filter((x) => x !== undefined);
  const head = said.length > 0 ? `Continued: ${said.join(", ")}.` : "Nothing needed continuing.";
  if (r.skipped.length === 0) return head;
  return `${head} Skipped ${r.skipped.length}: ${r.skipped
    .map((s) => `${s.paneId ?? s.runId ?? "?"} (${s.why})`)
    .join("; ")}.`;
}

/** The sequences a full-screen program (Claude Code, vim) enters and leaves the alternate screen with. */
const ALT_ENTER = ["\u001b[?1049h", "\u001b[?1047h", "\u001b[?47h"];
const ALT_LEAVE = ["\u001b[?1049l", "\u001b[?1047l", "\u001b[?47l"];

/** Where the last of the sequences is in the text, and how long it is (-1 when none is). */
function lastOf(text: string, seqs: readonly string[]): { readonly at: number; readonly length: number } {
  let best = { at: -1, length: 0 };
  for (const s of seqs) {
    const at = text.lastIndexOf(s);
    if (at > best.at) best = { at, length: s.length };
  }
  return best;
}

/** The text a terminal shows of a stream: escapes and control characters removed, blanks trimmed. */
function printed(stream: string): string {
  let out = "";
  for (let i = 0; i < stream.length; i++) {
    const c = stream.charCodeAt(i);
    if (c === 0x1b) {
      // CSI (ESC [ … final byte) and OSC (ESC ] … BEL or ESC \); any other escape is two characters.
      const kind = stream[i + 1];
      if (kind === "[") {
        i += 2;
        while (i < stream.length && !/[@-~]/.test(stream[i] as string)) i++;
      } else if (kind === "]") {
        const bel = stream.indexOf("\u0007", i);
        const st = stream.indexOf("\u001b\\", i + 2);
        if (bel >= 0 && (st < 0 || bel < st)) i = bel;
        else i = st >= 0 ? st + 1 : stream.length;
      } else i++;
    } else if (c >= 0x20) out += stream[i];
  }
  return out.trim();
}

/**
 * What a finished pane shows (round 22): the last screen its full-screen program drew. Claude Code
 * draws in the alternate screen and leaves it when it exits, so a replay of its output ends on the
 * empty main screen with one line ("Resume this session with …"). When the stream's last
 * alternate screen was left after it was entered, and little was printed after (at most
 * `maxAfter` characters, so a shell that ran vim long ago keeps its own output), the stream is cut
 * where it left: the terminal stays on that last screen. Any other stream is returned as it is.
 */
export function lastScreen(stream: string, maxAfter = 600): string {
  const enter = lastOf(stream, ALT_ENTER);
  const leave = lastOf(stream, ALT_LEAVE);
  if (enter.at < 0 || leave.at < enter.at) return stream;
  if (printed(stream.slice(leave.at + leave.length)).length > maxAfter) return stream;
  return stream.slice(0, leave.at);
}

/**
 * The command that resumes an ended agent's session by hand (round 22), when its host can: the
 * session id a Claude Code pane was started with (`--session-id`). Another host, or none, says nothing.
 */
export function resumeCommand(
  p: Pick<PaneView, "process"> & { readonly live?: { readonly sessionId?: string } | undefined },
): string | undefined {
  if (p.process.kind !== "host" || p.process.host !== "claude") return undefined;
  const id = p.live?.sessionId ?? p.process.sessionId;
  return id ? `claude --resume ${id}` : undefined;
}

/** When an ended pane ended and how long it ran (round 22): `14:32 · 12m 04s`, local time. */
export function endedWhen(p: Pick<PaneView, "createdAt" | "ended">): string | undefined {
  if (!p.ended) return undefined;
  const end = new Date(p.ended.at);
  if (Number.isNaN(end.getTime())) return undefined;
  const two = (n: number) => String(n).padStart(2, "0");
  const at = `${two(end.getHours())}:${two(end.getMinutes())}`;
  const ms = end.getTime() - new Date(p.createdAt).getTime();
  if (!(ms >= 0)) return at;
  const s = Math.round(ms / 1000);
  const took =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)}m ${two(s % 60)}s`
        : `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
  return `${at} · ${took}`;
}
