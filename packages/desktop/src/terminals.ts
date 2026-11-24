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

/* ---------- every terminal at once: rows, filters, groups (round 22) ---------- */

/** One terminal of the All view: its pane, where it sits in its task, and what the filters read. */
export interface TerminalRow {
  /** The pane's key (`paneKey`): repository and id. */
  readonly key: string;
  readonly pane: TPane;
  readonly task: TerminalTask;
  /** Its repository's label (`shop-api`), `this repository` without one. */
  readonly repo: string;
  readonly role: PaneView["role"];
  readonly state: PaneShown;
  /** The terminal that started it: a session's conductor for its sub-terminals, the main terminal for a session. */
  readonly parent?: string | undefined;
  /** The session it belongs to, when it is a session's (its conductor or a sub-terminal). */
  readonly session?: Session | undefined;
  /** What it is in its task: `main terminal`, `<repo> · conductor`, a worker's name. */
  readonly name: string;
}

const HERE = "this repository";

/** A row's state: paused and ended first (a pane the daemon ended keeps its own tone), then the pane's own. */
const shownOf = (p: TPane, now: number): PaneShown =>
  pausedOf(p) && !p.ended
    ? "paused"
    : isEnded(p)
      ? endedBanner(p).tone === "error"
        ? "exited"
        : "finished"
      : paneStateOf(p, now);

/**
 * Every terminal of every task as rows, in the tasks' order: the main terminal, then per session
 * its conductor and its sub-terminals. Each row knows its parent: a session's conductor was
 * started from the main terminal, a sub-terminal from its session's conductor.
 */
export function terminalRows(tasks: readonly TerminalTask[], now: number = Date.now()): TerminalRow[] {
  const rows: TerminalRow[] = [];
  const seen = new Set<string>();
  const add = (row: Omit<TerminalRow, "key" | "repo" | "role" | "state">) => {
    const key = paneKey(row.pane);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      ...row,
      key,
      repo: repoLabel(row.pane.repo ?? row.task.repo ?? "") || HERE,
      role: row.pane.role,
      state: shownOf(row.pane, now),
    });
  };
  for (const t of tasks) {
    const main = t.main ? paneKey(t.main) : undefined;
    if (t.main) add({ pane: t.main, task: t, name: "main terminal" });
    // The task run's own sub-terminals, when its session is not one of the tiles (its conductor is the main terminal).
    if (!t.sessions.includes(t.own))
      for (const p of t.own.subs) add({ pane: p, task: t, parent: main, session: t.own, name: paneLabel(p) });
    for (const s of t.sessions) {
      const head = s.pane ? paneKey(s.pane) : main;
      if (s.pane)
        add({
          pane: s.pane,
          task: t,
          parent: main !== head ? main : undefined,
          session: s,
          name: `${s.label} · conductor`,
        });
      for (const p of s.subs) add({ pane: p, task: t, parent: head, session: s, name: paneLabel(p) });
    }
  }
  return rows;
}

/** The rows started from a row, and from those, nearest first. */
export function rowsBelow(rows: readonly TerminalRow[], key: string): TerminalRow[] {
  const out: TerminalRow[] = [];
  let level = rows.filter((r) => r.parent === key);
  while (level.length > 0) {
    out.push(...level);
    const keys = new Set(level.map((r) => r.key));
    level = rows.filter((r) => r.parent !== undefined && keys.has(r.parent) && !out.includes(r));
  }
  return out;
}

/** The three things the filter bar chooses by. */
export type FilterDimension = "repo" | "state" | "role";

/**
 * What the filter bar hides (round 22): values per dimension, and words a row must hold. What is
 * hidden is kept rather than what is shown, so a repository or a state that appears later shows.
 */
export interface TerminalFilter {
  readonly hide: Readonly<Record<FilterDimension, readonly string[]>>;
  readonly text: string;
}

export const NO_FILTER: TerminalFilter = { hide: { repo: [], state: [], role: [] }, text: "" };

const rowValue = (r: TerminalRow, d: FilterDimension): string =>
  d === "repo" ? r.repo : d === "state" ? r.state : r.role;

/** Whether a row passes the filter: none of its values hidden, and every word of the text in it. */
export function passes(r: TerminalRow, f: TerminalFilter): boolean {
  for (const d of ["repo", "state", "role"] as const) if (f.hide[d].includes(rowValue(r, d))) return false;
  const hay = `${r.name} ${r.repo} ${r.task.title} ${r.role} ${r.state} ${paneLabel(r.pane)}`.toLowerCase();
  return f.text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .every((w) => hay.includes(w));
}

/**
 * A click on a chip of the filter bar. A plain click hides or shows that value; hiding the last
 * shown one shows them all again, so the bar never hides everything. Alt+click shows only that
 * value; an Alt+click on the only one shown shows them all again.
 */
export function toggleFilter(
  f: TerminalFilter,
  d: FilterDimension,
  value: string,
  only: boolean,
  values: readonly string[],
): TerminalFilter {
  const hidden = f.hide[d];
  const shown = values.filter((v) => !hidden.includes(v));
  let next: string[];
  if (only) next = shown.length === 1 && shown[0] === value ? [] : values.filter((v) => v !== value);
  else if (hidden.includes(value)) next = hidden.filter((v) => v !== value);
  else next = shown.length === 1 && shown[0] === value ? [] : [...hidden, value];
  return { ...f, hide: { ...f.hide, [d]: next } };
}

/** The filter changed just enough to show a row (a link to a terminal the filter hides). */
export function showing(f: TerminalFilter, r: TerminalRow): TerminalFilter {
  const hide = { ...f.hide };
  for (const d of ["repo", "state", "role"] as const) hide[d] = hide[d].filter((v) => v !== rowValue(r, d));
  return { hide, text: passes(r, { hide, text: f.text }) ? f.text : "" };
}

/** Each value of a dimension among the rows, in the order first met, with how many rows have it. */
export function filterValues(
  rows: readonly TerminalRow[],
  d: FilterDimension,
): { value: string; count: number }[] {
  const out: { value: string; count: number }[] = [];
  for (const r of rows) {
    const v = rowValue(r, d);
    const known = out.find((x) => x.value === v);
    if (known) known.count++;
    else out.push({ value: v, count: 1 });
  }
  return out;
}

/** How the All view groups its tiles. */
export type TerminalGrouping = "task" | "repo" | "state" | "flat";

export interface TerminalGroup {
  readonly key: string;
  readonly title: string;
  /** Set when the group is one repository's (its band's colour). */
  readonly repo?: string | undefined;
  /** A task's group holds its sessions as sub-groups. */
  readonly sessions?: readonly TerminalGroup[] | undefined;
  readonly rows: readonly TerminalRow[];
}

/** The states in the order a person deals with them: what asks first, what is finished last. */
const STATE_ORDER: readonly PaneShown[] = ["asks", "exited", "working", "paused", "idle", "finished"];

/**
 * The shown rows in groups: by task (its main terminal, then a sub-group per repository session),
 * by repository, by state (what asks first) or one flat group. Empty groups are left out.
 */
export function groupRows(rows: readonly TerminalRow[], by: TerminalGrouping): TerminalGroup[] {
  if (by === "flat") return rows.length > 0 ? [{ key: "all", title: "All terminals", rows }] : [];
  if (by === "state")
    return STATE_ORDER.map((s) => ({
      key: `state:${s}`,
      title: s,
      rows: rows.filter((r) => r.state === s),
    })).filter((g) => g.rows.length > 0);
  if (by === "repo") {
    const repos = [...new Set(rows.map((r) => r.repo))];
    return repos.map((repo) => ({
      key: `repo:${repo}`,
      title: repo,
      repo,
      rows: rows.filter((r) => r.repo === repo),
    }));
  }
  const groups: TerminalGroup[] = [];
  for (const task of [...new Set(rows.map((r) => r.task))]) {
    const own = rows.filter((r) => r.task === task);
    const sessions = [...new Set(own.map((r) => r.session).filter((s): s is Session => s !== undefined))];
    groups.push({
      key: `task:${task.runId}`,
      title: task.title,
      rows: own.filter((r) => r.session === undefined),
      sessions: sessions.map((s) => ({
        key: `session:${task.runId}:${s.runId}`,
        title: `${s.label} session`,
        repo: repoLabel(s.repo ?? task.repo ?? "") || HERE,
        rows: own.filter((r) => r.session === s),
      })),
    });
  }
  return groups;
}

/** The hues a repository's band takes: light tints, apart from the states' violet, amber, green, red, blue and teal. */
export const REPO_HUES = [
  "#7dd3fc",
  "#f472b6",
  "#fdba74",
  "#bef264",
  "#d6c7a1",
  "#cbd5e1",
  "#f0abfc",
  "#fda4af",
];

/**
 * A repository's mark (round 22): its two letters and its hue, the same on every screen. In a
 * folder the repositories it holds (`known`) take the hues in their sorted order, so up to eight
 * never share one; a repository not among them takes a hue from its name.
 */
export function repoMark(
  repo: string,
  known: readonly string[] = [],
): { readonly letters: string; readonly hue: string } {
  const words = repo.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  const letters =
    repo === HERE
      ? "··"
      : words.length > 1
        ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
        : (words[0] ?? repo).slice(0, 2);
  const sorted = [...new Set(known)].sort();
  let at = sorted.indexOf(repo);
  if (at < 0) {
    // FNV-1a: close names (shop-api, shop-web) still spread.
    let h = 0x811c9dc5;
    for (let i = 0; i < repo.length; i++) h = Math.imul(h ^ repo.charCodeAt(i), 0x01000193) >>> 0;
    at = h;
  }
  return { letters: letters.toUpperCase(), hue: REPO_HUES[at % REPO_HUES.length] as string };
}

/** The filter as the window keeps it (`metator.terminals`), read back; anything unreadable is no filter. */
export function terminalViewFromStorage(raw: string | null | undefined): {
  readonly filter: TerminalFilter;
  readonly grouping: TerminalGrouping;
} {
  const none = { filter: NO_FILTER, grouping: "task" as const };
  if (!raw) return none;
  try {
    const v = JSON.parse(raw) as {
      filter?: { hide?: Record<string, unknown>; text?: unknown };
      grouping?: unknown;
    };
    const strings = (x: unknown) =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
    const hide = v.filter?.hide ?? {};
    const grouping = (["task", "repo", "state", "flat"] as const).find((g) => g === v.grouping) ?? "task";
    return {
      filter: {
        hide: { repo: strings(hide.repo), state: strings(hide.state), role: strings(hide.role) },
        text: typeof v.filter?.text === "string" ? v.filter.text : "",
      },
      grouping,
    };
  } catch {
    return none;
  }
}
