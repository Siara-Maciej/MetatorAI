import type {
  Attention,
  EscalatedItem,
  InboxItem,
  Inspection,
  Overview,
  RunOverview,
  StageProgress,
  StartedStep,
} from "@metator/core";
import { startedHow } from "@metator/core";
import type { PaneAsk } from "./pane-asks.ts";

/**
 * A command's data as a person reads it (ADR-0052): at a terminal the text goes to stderr and
 * stdout keeps the one JSON line, so a pipe and a script see what they always saw. Pure
 * functions over the same data the envelope carries; `--json` leaves them out.
 */

export const ATTENTION: Readonly<Record<Attention, { readonly icon: string; readonly label: string }>> = {
  you: { icon: "?", label: "needs you" },
  driving: { icon: "⟳", label: "working" },
  stopped: { icon: "‖", label: "stopped" },
  done: { icon: "✓", label: "done" },
  escalated: { icon: "!", label: "escalated" },
  aborted: { icon: "✗", label: "aborted" },
};

const STAGE_MARK: Readonly<Record<StageProgress["state"], string>> = {
  done: "✓",
  current: "⟳",
  waiting: "?",
  next: "·",
  stopped: "!",
};

/** `intake ✓ ─ plan ✓ ─ [plan-approval ?] ─ build ·`: the current stage in brackets. */
export function stageBar(stages: readonly StageProgress[]): string {
  return stages
    .map((s) => {
      const label = `${s.id} ${STAGE_MARK[s.state]}`;
      return s.state === "current" || s.state === "waiting" || s.state === "stopped" ? `[${label}]` : label;
    })
    .join(" ─ ");
}

/** `45 s`, `12 min`, `3 h 05 min`, `2 d 4 h`. */
export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** One line on what the run needs now, with the command that does it. */
export function nextStep(run: RunOverview): string {
  const q = run.questions[0];
  if (q)
    return `waits for you: ${q.prompt}  (metator run answer ${q.id} --run ${run.runId} --choice <label>)`;
  if (run.attention === "you")
    return `waits at ${run.stage}: metator run approve ${run.stage} --by <name> --run ${run.runId}`;
  if (run.attention === "driving") return `working${run.last ? `: ${run.last.text}` : ""}`;
  if (run.died) return `the drive died at ${run.stage}  (metator run continue ${run.runId})`;
  if (run.attention === "stopped") return `stopped at ${run.stage}  (metator run continue ${run.runId})`;
  if (run.attention === "escalated")
    return `at ${run.stage}: fix the cause, then metator run resume --run ${run.runId} --drive`;
  if (run.attention === "aborted") return `at ${run.stage}`;
  return "every stage passed";
}

/** The text on one line, cut to a width with an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width));
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

const WIDTH = 100;

interface Listed {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
}

/** `metator help`: every command, one line each. */
export function renderCommandList(data: {
  readonly commands: readonly Listed[];
  readonly audience?: string;
}): string {
  const width = Math.max(0, ...data.commands.map((c) => c.name.length));
  const cut = (line: string) => (line.length <= WIDTH + 40 ? line : `${line.slice(0, WIDTH + 39)}…`);
  const lines = data.commands.map((c) => cut(`  metator ${c.name.padEnd(width)}  ${c.summary}`));
  const whose = data.audience ? ` for ${data.audience}` : "";
  return [
    ...lines,
    "",
    `${data.commands.length} commands${whose}; one command: \`metator <command> --help\`.`,
  ].join("\n");
}

/** `metator <command> --help`: the usage, the options, a group's commands. */
export function renderCommandHelp(help: {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly options: readonly {
    readonly flags: string;
    readonly description: string;
    readonly default?: unknown;
  }[];
  readonly commands?: readonly Listed[];
}): string {
  const lines = [help.usage, "", help.summary];
  if (help.options.length > 0) {
    const width = Math.max(...help.options.map((o) => o.flags.length));
    lines.push("", "Options");
    for (const o of help.options) {
      const def =
        o.default === undefined || o.default === false ? "" : ` (default: ${JSON.stringify(o.default)})`;
      lines.push(`  ${o.flags.padEnd(width)}  ${o.description}${def}`);
    }
  }
  if (help.commands && help.commands.length > 0) {
    const width = Math.max(...help.commands.map((c) => c.name.length));
    lines.push("", "Commands");
    for (const c of help.commands) lines.push(`  metator ${c.name.padEnd(width)}  ${c.summary}`);
  }
  return lines.join("\n");
}

function runLines(run: RunOverview): string[] {
  const a = ATTENTION[run.attention];
  return [
    `${a.icon} ${run.runId}  ${a.label} · ${run.workflow} · ${duration(run.elapsedMs)}`,
    `    ${fit(run.task, WIDTH - 4)}`,
    `    ${stageBar(run.stages)}`,
    `    ${nextStep(run)}`,
  ];
}

const countsLine = (c: Overview["counts"]) =>
  `${c.you} need you · ${c.driving} working · ${c.stopped} stopped${c.escalated > 0 ? ` · ${c.escalated} escalated` : ""} · ${c.services} services`;

function overviewLines(o: Overview): string[] {
  if (o.runs.length === 0) return ["  no runs yet: `metator run` starts one"];
  const lines = o.runs.flatMap(runLines);
  if (o.conversations.length > 0) {
    lines.push("", "  Conversations");
    for (const c of o.conversations)
      lines.push(`  ✦ ${fit(c.title, WIDTH - 20)} · ${c.host} · ${c.turns} turn(s)`);
  }
  return lines;
}

type Readout = Overview | { readonly error: string };
type FolderOverview = {
  readonly folder: string;
  readonly repos: readonly ({
    readonly name: string;
    /** Its worktrees' work, each named `shop (fix-tax)`. */
    readonly worktrees?: readonly ({ readonly label: string } & Readout)[];
  } & Readout)[];
  readonly counts: Overview["counts"];
};

/**
 * `metator status`: each run with its stages and what it needs now; in a folder, per repository
 * (counted once), with the work of its worktrees under it.
 */
export function renderStatus(data: Overview | FolderOverview): string {
  if (!("repos" in data)) return [countsLine(data.counts), "", ...overviewLines(data)].join("\n");
  const lines = [
    `${data.folder} · ${plural(data.repos.length, "repository", "repositories")}`,
    countsLine(data.counts),
  ];
  const body = (r: Readout) => ("error" in r ? [`  ! ${r.error}`] : overviewLines(r));
  for (const r of data.repos) {
    const worktrees = r.worktrees ?? [];
    lines.push("", worktrees.length > 0 ? `${r.name} · ${plural(worktrees.length, "worktree")}` : r.name);
    lines.push(...body(r));
    for (const w of worktrees) lines.push("", w.label, ...body(w));
  }
  return lines.join("\n");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `metator inbox`: every open decision with the command that answers it, then the escalated runs. */
export function renderInbox(data: {
  readonly decisions: readonly (InboxItem & { readonly repo?: string })[];
  readonly escalated: readonly (EscalatedItem & { readonly repo?: string })[];
  /** The questions of panes the daemon owns (ADR-0091): a host's approval, an agent's words. */
  readonly panes?: readonly PaneAsk[];
}): string {
  const panes = data.panes ?? [];
  if (data.decisions.length + data.escalated.length + panes.length === 0) return "Nothing waits for you.";
  const lines: string[] = [];
  for (const d of data.decisions) {
    const q = d.question;
    const where = d.repo ? `${d.repo} · ` : "";
    lines.push(
      `? ${where}${d.runId} · ${d.stage} · waited ${duration(d.waitedMs)}${d.driving ? " · the run stands still" : ""}`,
      `    ${fit(q.prompt, WIDTH - 4)}`,
      `    ${q.options.map((o) => o.label).join(" / ")}`,
      `    metator run answer ${q.id} --run ${d.runId} --choice <label>`,
    );
  }
  for (const e of data.escalated) {
    const where = e.repo ? `${e.repo} · ` : "";
    lines.push(
      `! ${where}${e.runId} · escalated at ${e.stage} · waited ${duration(e.waitedMs)}`,
      ...(e.reason ? [`    ${fit(e.reason, WIDTH - 4)}`] : []),
      ...e.next.map((n) => `    ${n}`),
    );
  }
  for (const p of panes) {
    const where = p.repo ? `${p.repo} · ` : "";
    const q = p.question;
    lines.push(
      `? ${where}${p.label} (pane ${p.paneId}) · ${p.host} ${q.source === "permission" ? "asks for approval" : "asks"}`,
      `    ${fit(q.prompt, WIDTH - 4)}`,
      ...(q.reason ? [`    why: ${fit(q.reason, WIDTH - 9)}`] : []),
      `    ${q.options.map((o) => o.label).join(" / ")}`,
      `    answer it on Home in the app, or in pane ${p.paneId}`,
    );
  }
  return lines.join("\n");
}

/** `metator run status`: where the run stands, what its stage expects, the last transitions. */
export function renderRunStatus(v: {
  readonly runId: string;
  readonly workflow: string;
  readonly task: string;
  readonly autonomy: string;
  readonly stage: string;
  readonly status: string;
  readonly expects: readonly string[];
  readonly recent: readonly {
    readonly stage: string;
    readonly event: string;
    readonly detail?: string | undefined;
  }[];
  readonly worktree?: { readonly path: string; readonly branch?: string } | undefined;
  readonly escalated?:
    | { readonly stage: string; readonly reason?: string; readonly next: readonly string[] }
    | undefined;
}): string {
  const lines = [
    `${v.runId} · ${v.workflow} · ${v.autonomy}`,
    `  ${fit(v.task, WIDTH - 2)}`,
    `  ${v.status} at ${v.stage}${v.expects.length > 0 ? ` · expects ${v.expects.join(", ")}` : ""}`,
  ];
  if (v.worktree)
    lines.push(`  worktree ${v.worktree.path}${v.worktree.branch ? ` (${v.worktree.branch})` : ""}`);
  if (v.escalated) {
    if (v.escalated.reason) lines.push(`  ! ${fit(v.escalated.reason, WIDTH - 4)}`);
    lines.push(...v.escalated.next.map((n) => `    ${n}`));
  }
  if (v.recent.length > 0) {
    lines.push("", "  Last events");
    for (const h of v.recent)
      lines.push(`    ${h.stage} · ${h.event}${h.detail ? ` · ${fit(h.detail, WIDTH - 30)}` : ""}`);
  }
  return lines.join("\n");
}

const CHECK_MARK: Readonly<Record<string, string>> = { ok: "✓", warn: "!", fail: "✗" };

/** `metator doctor`: each check with its mark, and the fix where there is one. */
export function renderDoctor(r: {
  readonly ready: boolean;
  readonly place: string;
  readonly checks: readonly {
    readonly id: string;
    readonly status: string;
    readonly message: string;
    readonly fix?: string;
  }[];
}): string {
  const width = Math.max(0, ...r.checks.map((c) => c.id.length));
  const lines = [`${r.place}: ${r.ready ? "ready for a run" : "not ready for a run"}`, ""];
  for (const c of r.checks) {
    lines.push(`  ${CHECK_MARK[c.status] ?? "·"} ${c.id.padEnd(width)}  ${c.message}`);
    if (c.fix) lines.push(`  ${" ".repeat(width + 2)}  fix: ${c.fix}`);
  }
  return lines.join("\n");
}

const NEXT: Readonly<Record<Inspection["next"], string>> = {
  "choose-another": "nothing is there: choose another folder",
  "install-git": "install git first",
  "git-init": "not a git repository: `git init` makes it one",
  setup: "not set up: `metator setup` sets it up",
  add: "set up: open it in the app, or `metator serve`",
  "setup-repos": "set up each repository that is not (`metator -C <repository> setup`)",
  "update-app": "written by a newer MetatorAI: update the app (or metator-ai) before using it here",
};

/** `metator inspect` as a person reads it: what the folder is, the machine's git and hosts, what comes next. */
export function renderInspection(i: Inspection): string {
  const mark = (ok: boolean | null) => (ok === null ? "·" : ok ? "✓" : "✗");
  const repo = (r: NonNullable<Inspection["repository"]>) =>
    `${r.name} (${r.root})${r.worktree ? ", from its worktree" : ""}: set up ${r.setUp}${r.uncommitted.length > 0 ? `, ${r.uncommitted.length} uncommitted file(s)` : ""}`;
  const lines = [`${i.path}: ${i.kind}`];
  if (i.repository) lines.push(`  ${repo(i.repository)}`);
  for (const r of i.folder?.repos ?? []) lines.push(`  ${repo(r)}`);
  lines.push("", `  ${mark(i.git.installed)} git ${i.git.version ?? `not installed (${i.git.install.url})`}`);
  for (const h of i.hosts)
    lines.push(
      `  ${mark(h.installed)} ${h.program} ${h.installed ? (h.loggedIn ? "logged in" : `no login found: ${h.login}`) : `not installed: ${h.install.command}`}`,
    );
  const writes = i.defaultHost ? i.writes[i.defaultHost] : undefined;
  if (writes) lines.push("", `  setup --host ${i.defaultHost} writes ${writes.length} file(s)`);
  lines.push("", `next: ${NEXT[i.next]}`);
  return lines.join("\n");
}

/** A command that failed, as a person reads it: what is wrong, then what to do about it. */
export function renderError(e: {
  readonly code: string;
  readonly message: string;
  readonly hint?: string | undefined;
}): string {
  return [`✗ ${e.message} (${e.code})`, ...(e.hint ? [`  ${e.hint}`] : [])].join("\n");
}

/** Columns padded to the widest cell of each, joined by two spaces; trailing blanks dropped. */
function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/** `system plan run`: each step started, its run, and how (its session's pane, else its drive and why). */
export function renderPlanRun(v: {
  readonly plan: { readonly id: string };
  readonly started: readonly Pick<
    StartedStep,
    "step" | "app" | "run" | "session" | "noSession" | "drive" | "driveError"
  >[];
}): string {
  if (v.started.length === 0) return `${v.plan.id}: no step can start yet`;
  const rows = columns(v.started.map((s) => ["", s.step, s.app, s.run, startedHow(s)]));
  return [`${v.plan.id}: started ${v.started.length} step(s)`, ...rows].join("\n");
}

interface PlanStep {
  readonly id: string;
  readonly app: string;
  readonly summary?: string;
  readonly dependsOn?: readonly string[];
}
interface PlanView {
  readonly id: string;
  readonly task: string;
  readonly status: string;
  readonly approval?: { readonly by: string } | undefined;
  readonly steps: readonly PlanStep[];
}

const planHead = (plan: PlanView): string[] => [
  `${plan.id} · ${plan.status}${plan.approval ? ` · approved by ${plan.approval.by}` : ""}`,
  `  ${fit(plan.task, WIDTH - 2)}`,
];

/** The steps in waves (each after the steps it depends on); one wave when they cannot be ordered. */
function wavesOf(steps: readonly PlanStep[]): string[][] {
  const done = new Set<string>();
  const waves: string[][] = [];
  let left = [...steps];
  while (left.length > 0) {
    const wave = left.filter((s) => (s.dependsOn ?? []).every((d) => done.has(d)));
    if (wave.length === 0) return [...waves, left.map((s) => s.id)];
    waves.push(wave.map((s) => s.id));
    for (const s of wave) done.add(s.id);
    left = left.filter((s) => !wave.includes(s));
  }
  return waves;
}

const STEP_MARK: Readonly<Record<string, string>> = { done: "✓", running: "…", blocked: "!", pending: "·" };

/** `metator system plan status`: the waves, each step with its repository, its state and its run. */
export function renderPlanStatus(v: {
  readonly plan?: PlanView;
  /** `--gate`: what the children say about going on, without the plan. */
  readonly message?: string;
  readonly steps: readonly {
    readonly id: string;
    readonly app: string;
    readonly status: string;
    readonly run?: string;
    readonly runStatus?: string;
    readonly stage?: string;
  }[];
}): string {
  if (!v.plan) return v.message ?? "";
  const lines = planHead(v.plan);
  const byId = new Map(v.steps.map((s) => [s.id, s]));
  const rows: string[][] = [];
  const waves = wavesOf(v.plan.steps);
  const heads = new Map<number, string>();
  waves.forEach((wave, i) => {
    heads.set(rows.length, `  Wave ${i + 1}`);
    for (const id of wave) {
      const s = byId.get(id);
      if (!s) continue;
      const stuck = s.runStatus === "escalated" || s.runStatus === "aborted";
      const mark = stuck ? "!" : (STEP_MARK[s.status] ?? "·");
      const run = s.run
        ? `${s.run} (${s.runStatus ?? s.status}${s.runStatus && s.runStatus !== "done" && s.stage ? ` at ${s.stage}` : ""})`
        : "not started";
      rows.push([`    ${mark} ${s.id}`, s.app, s.status, run]);
    }
  });
  columns(rows).forEach((row, i) => {
    const head = heads.get(i);
    if (head) lines.push(head);
    lines.push(row);
  });
  return lines.join("\n");
}

/** `metator system plan show`: the plan's waves with each step's repository, summary and what it waits for. */
export function renderPlanShow(v: {
  readonly plan: PlanView;
  readonly waves: readonly (readonly string[])[] | null;
}): string {
  const lines = planHead(v.plan);
  const byId = new Map(v.plan.steps.map((s) => [s.id, s]));
  const waves = v.waves ?? wavesOf(v.plan.steps);
  waves.forEach((wave, i) => {
    lines.push(`  Wave ${i + 1}`);
    const rows = wave.flatMap((id) => {
      const s = byId.get(id);
      if (!s) return [];
      const after = (s.dependsOn ?? []).length > 0 ? `(after ${(s.dependsOn ?? []).join(", ")})` : "";
      return [[`    ${s.id}`, s.app, fit(s.summary ?? "", 60), after]];
    });
    lines.push(...columns(rows));
  });
  return lines.join("\n");
}

interface AskedQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string }[];
}

const askedHead = (q: AskedQuestion) => `${q.id} · ${fit(q.prompt, WIDTH - 8)}`;
const optionsLine = (q: AskedQuestion) => `  options: ${q.options.map((o) => o.label).join(" · ")}`;

/** `metator run ask --wait`, before the answer: the question, its options, that it waits. */
export function renderAsking(q: AskedQuestion): string {
  return [askedHead(q), optionsLine(q), "  waiting for an answer…"].join("\n");
}

/** `metator run ask`: the answer and who gave it, or that the question waits in the inbox. */
export function renderAsked(v: {
  readonly question: AskedQuestion;
  readonly answer?: { readonly choices: readonly string[]; readonly text?: string; readonly by: string };
}): string {
  if (!v.answer)
    return [askedHead(v.question), optionsLine(v.question), "  asked: it waits in the person's inbox"].join(
      "\n",
    );
  const chosen = v.answer.choices.filter((c) => c !== "Other");
  const words = [...chosen, ...(v.answer.text ? [v.answer.text] : [])].join(", ");
  return [askedHead(v.question), `  answer: ${words || "(none)"} · ${v.answer.by}`].join("\n");
}

/** `metator issue list`: one line per task, the most pressing first, with the run working on it. */
export function renderIssues(v: {
  readonly issues: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly priority: string;
    readonly runId?: string;
  }[];
}): string {
  if (v.issues.length === 0) return "The backlog is empty.";
  return columns(
    v.issues.map((i) => [
      i.id,
      i.status,
      i.priority,
      `${fit(i.title, 60)}${i.runId ? `  → ${i.runId}` : ""}`,
    ]),
  ).join("\n");
}

/** A thread's task, as one line: its state, its id, its words. */
interface ThreadTaskLine {
  readonly runId: string;
  readonly repo?: string;
  readonly task: string;
  readonly stage: string;
  readonly attention: Attention;
}
interface ThreadLines {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly summary: string;
  readonly facts: readonly { readonly at: string; readonly text: string }[];
  readonly issues: readonly string[];
  readonly tasks?: readonly ThreadTaskLine[];
  readonly attention?: Attention;
  readonly chat?: { readonly paneId: string; readonly status: string };
}

const taskLine = (t: ThreadTaskLine): string =>
  `${ATTENTION[t.attention].icon} ${t.runId}${t.repo ? ` (${t.repo})` : ""}  ${ATTENTION[t.attention].label} at ${t.stage}  ${fit(t.task, 60)}`;

/**
 * `metator thread show`: what a new session of the thread's chat reads first: the topic, the
 * summary the agent kept, the runs with their state, the Backlog items and what happened, newest last.
 */
export function renderThread(t: ThreadLines): string {
  const tasks = t.tasks ?? [];
  return [
    `${t.title}  (${t.id}, ${t.state}${t.chat ? `, chat ${t.chat.paneId} ${t.chat.status}` : ""})`,
    "",
    "Summary:",
    t.summary.trim() === ""
      ? "  (none yet: write one with `metator thread summary --text …`)"
      : indent(t.summary),
    "",
    `Runs (${tasks.length}):`,
    ...(tasks.length === 0 ? ["  none"] : tasks.map((x) => `  ${taskLine(x)}`)),
    ...(t.issues.length > 0 ? ["", `Issues: ${t.issues.join(", ")}`] : []),
    "",
    "Facts:",
    ...(t.facts.length === 0
      ? ["  none"]
      : t.facts.map((f) => `  ${f.at.slice(0, 16).replace("T", " ")}  ${f.text}`)),
  ].join("\n");
}

const indent = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

/** `metator thread list`: the sidebar's hierarchy as text: threads, the runs without a chat, closed threads. */
export function renderThreadTree(v: {
  readonly threads: readonly ThreadLines[];
  readonly closed: readonly ThreadLines[];
  readonly withoutChat: readonly ThreadTaskLine[];
}): string {
  const thread = (t: ThreadLines) => [
    `${t.attention ? ATTENTION[t.attention].icon : "·"} ${fit(t.title, 50)}  (${t.id}, ${t.tasks?.length ?? 0} tasks)`,
    ...(t.tasks ?? []).map((x) => `    ${taskLine(x)}`),
  ];
  const out = v.threads.length === 0 ? ["No open thread."] : v.threads.flatMap(thread);
  if (v.withoutChat.length > 0)
    out.push("", "Without a chat:", ...v.withoutChat.map((x) => `    ${taskLine(x)}`));
  if (v.closed.length > 0)
    out.push("", `Closed (${v.closed.length}):`, ...v.closed.map((t) => `  ${fit(t.title, 50)}  (${t.id})`));
  return out.join("\n");
}

/** `metator host conformance`: each check with its result, the failed ones with why, and the report. */
export function renderConformanceRun(r: {
  readonly host: string;
  readonly cliVersion: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly report: string;
  readonly rendered: string;
  readonly kept?: string;
  readonly checks: readonly { readonly id: string; readonly result: string; readonly last: string }[];
}): string {
  const mark: Readonly<Record<string, string>> = { pass: "✓", fail: "✗", skipped: "·" };
  return [
    `${r.host} ${r.cliVersion}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`,
    ...r.checks.map(
      (c) => `  ${mark[c.result] ?? "?"} ${c.id}${c.result === "fail" ? `: ${fit(c.last, WIDTH - 8)}` : ""}`,
    ),
    `report: ${r.report} (${r.rendered})`,
    ...(r.kept ? [`kept: ${r.kept}`] : []),
  ].join("\n");
}

/** `metator host conformance diff`: the checks two runs disagree on, the parity gaps. */
export function renderConformanceDiff(d: {
  readonly a: { readonly host: string; readonly cliVersion: string };
  readonly b: { readonly host: string; readonly cliVersion: string };
  readonly differ: readonly { readonly id: string; readonly a: string; readonly b: string }[];
  readonly same: number;
}): string {
  const head = `${d.a.host} ${d.a.cliVersion} vs ${d.b.host} ${d.b.cliVersion}`;
  if (d.differ.length === 0) return `${head}: no parity gap (${d.same} checks alike)`;
  return [
    `${head}: ${d.differ.length} parity gap(s), ${d.same} checks alike`,
    ...d.differ.map((x) => `  ${x.id}: ${d.a.host} ${x.a}, ${d.b.host} ${x.b}`),
  ].join("\n");
}
