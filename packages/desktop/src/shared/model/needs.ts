/**
 * What needs the person: the queue of decisions, pane questions and terminal asks, and where each is answered.
 */
import type { InboxItem, PaneAsk, PaneView, Question, ResolvedOption, RunOverview } from "../api/api.ts";
import { commandText, duration } from "./format.ts";
import { paneLabel } from "./panes.ts";
import { sameRepo } from "./places.ts";
import type { Run } from "./runs.ts";

/** The key of an escalated run in the inbox's selection, apart from a question's `<run>/<question>`. */
export const escalatedKey = (r: { readonly runId: string; readonly repo?: string | undefined }): string =>
  `escalated:${r.repo ?? ""}:${r.runId}`;
/**
 * What a question is: a gate's APPROVAL, an agent's QUESTION, a host's PERMISSION prompt, or a
 * TERMINAL question (an agent asking a person in its pane what it should do: not a permission).
 * A kind the daemon sends on the question wins.
 */
export function questionKind(
  q: Pick<Question, "source"> & Partial<Pick<Question, "prompt" | "options">>,
): "APPROVAL" | "PERMISSION" | "QUESTION" | "TERMINAL" {
  const sent = (q as { readonly kind?: unknown }).kind;
  if (sent === "terminal" || sent === "permission" || sent === "question" || sent === "approval")
    return sent.toUpperCase() as "APPROVAL" | "PERMISSION" | "QUESTION" | "TERMINAL";
  if (q.source === "gate") return "APPROVAL";
  if (q.options && isTerminalQuestion({ source: q.source, options: q.options })) return "TERMINAL";
  if (q.source !== "permission") return "QUESTION";
  const host = q.prompt ? hostPromptOf(q.prompt) : undefined;
  return host && !PERMISSION_WORDS.test(host.text) ? "TERMINAL" : "PERMISSION";
}
/** A host's prompt that asks for a permission: to allow, run, trust, proceed. */
const PERMISSION_WORDS = /\b(allow|permission|permit|proceed|trust|approve|run this|execute|grant)\b/i;
/** What a host prompt in a pane asks, read from the daemon's line: who, where, the question, its answers. */
export interface HostPrompt {
  readonly asker: string;
  readonly pane: string;
  /** The question as the agent wrote it, without the screen's frame and the answers in brackets. */
  readonly text: string;
  /** The answers the agent offered (`[PLN / EUR]`), when it offered some. */
  readonly options: readonly string[];
}
/**
 * `mt-planner-1 waits for your answer in pane w1:p2: Which currency …? [PLN / EUR]` read into its
 * parts; nothing for another prompt. The screen's frame (`│ ❯ ╭`) is dropped.
 */
export function hostPromptOf(prompt: string): HostPrompt | undefined {
  const m = /^(\S+) waits for your answer in pane (\S+?): ([\s\S]*)$/.exec(prompt.trim());
  if (!m) return undefined;
  const line = (m[3] ?? "").replace(/^[\s│┃|╭╮╰╯─❯›>●○◯✻*]+|[\s│┃|╭╮╰╯─]+$/g, "");
  const offered = /\[([^\]]+)\]\s*$/.exec(line);
  const options = offered
    ? (offered[1] ?? "")
        .split("/")
        .map((o) => o.trim())
        .filter((o) => o !== "")
    : [];
  const fits = options.length >= 2 && options.length <= 6 && options.every((o) => o.length <= 40);
  return {
    asker: m[1] ?? "",
    pane: m[2] ?? "",
    text: (fits && offered ? line.slice(0, offered.index) : line).trim(),
    options: fits ? options : [],
  };
}
/** The chips of an inbox row (spec §6.3): reversible, how many files it touches, whether the answer can be remembered, blocks a wave. */
export function inboxChips(item: Pick<InboxItem, "question" | "driving">): string[] {
  const card = item.question.card;
  const chips: string[] = [];
  if (card) chips.push(card.reversible ? "reversible" : "not reversible");
  if (card?.blastRadius && card.blastRadius.files > 0) chips.push(`touches ${card.blastRadius.files} files`);
  if (item.question.source === "permission") chips.push("can be allowed always");
  if (card?.costOfDelay?.some((c) => /blocks/.test(c))) chips.push("blocks wave");
  if (item.driving) chips.push("agent idle");
  return chips;
}
/** Whether the app may announce a question (its toast, the system notification): `notify.channel` is not `off`. */
export const notifies = (options: readonly Pick<ResolvedOption, "key" | "value">[]): boolean =>
  options.find((o) => o.key === "notify.channel")?.value !== "off";
type NeedKind = "question" | "approval" | "permission" | "terminal" | "escalated" | "pane" | "review";
/** One thing that needs the person: a question on a card, a question on a terminal, an escalated run. */
export interface NeedRow {
  /**
   * What the Inbox route picks: `<run>/<question>`, `terminal:<repo>:<run>`, `escalated:<repo>:<run>`,
   * `pane/<repo>/<pane>/<question>` for a pane without a run (no run id: `runId` is empty).
   */
  readonly key: string;
  readonly kind: NeedKind;
  readonly title: string;
  /** One line under it: where it comes from and how long it has waited. */
  readonly sub: string;
  readonly runId: string;
  readonly repo?: string | undefined;
  /** The pane that asks, for a question on a terminal. */
  readonly pane?: string | undefined;
  /** What the row says on hover: the chips of the card. */
  readonly hint: string;
}
export const terminalKey = (r: { readonly runId: string; readonly repo?: string | undefined }): string =>
  `terminal:${r.repo ?? ""}:${r.runId}`;
/**
 * A run that asks on its terminal with no card for it: the row opens the pane. A question the
 * daemon read from a terminal (kind `terminal` too) has its card in the Inbox.
 */
export const isTerminalAsk = (n: Pick<NeedRow, "key">): boolean => n.key.startsWith("terminal:");
/**
 * Everything that needs the person, in one queue: the questions in the inbox's order (the ones a
 * live drive waits on first), then the runs that ask on their terminal, then the escalated runs.
 */
export function needsQueue(
  inbox: readonly InboxItem[],
  runs: readonly Run[],
  panes: readonly (Pick<PaneView, "id" | "worker" | "role" | "label" | "process"> & {
    readonly repo?: string | undefined;
  })[] = [],
  paneAsks: readonly PaneAsk[] = [],
  now: number = Date.now(),
): NeedRow[] {
  const taskOf = (runId: string, repo: string | undefined) =>
    runs.find((r) => r.runId === runId && sameRepo(r.repo, repo))?.task;
  /** Who asks and in which stage: the worker of the pane when the question names one, else the question's agent. */
  const asker = (paneId: string | undefined, repo: string | undefined, agent?: string, stage?: string) => {
    const pane = paneId ? panes.find((p) => p.id === paneId && sameRepo(p.repo, repo)) : undefined;
    const who = pane ? paneLabel(pane) : agent;
    return [who, pane?.worker?.stage ?? stage].filter((x) => x !== undefined && x !== "").join(" · ");
  };
  return [
    ...inbox.map(
      (i): NeedRow => ({
        key: decisionKey(i),
        kind: questionKind(i.question).toLowerCase() as NeedKind,
        // A host prompt reads as its question; who asks, and in which pane, is in the line below.
        // A host's question: the start of its whole command, cut to a line or two (round 11).
        title:
          i.question.source === "permission"
            ? commandText({
                prompt: hostPromptOf(i.question.prompt)?.text || humanPrompt(i.question.prompt),
                command: (i.question as { command?: string }).command,
              }).short
            : hostPromptOf(i.question.prompt)?.text || humanPrompt(i.question.prompt),
        sub: [
          taskOf(i.runId, i.repo) ?? i.task,
          i.repo,
          asker(paneOfQuestion(i.question, panes), i.repo, i.question.agent, i.stage),
          duration(i.waitedMs),
        ]
          .filter((x) => x !== undefined && x !== "")
          .join(" · "),
        runId: i.runId,
        repo: i.repo,
        hint: [i.question.prompt, ...inboxChips(i)].join(" · "),
      }),
    ),
    // A pane without a run that asks (the intake chat's host wants leave to run a command).
    ...paneAsks.map(
      (a): NeedRow => ({
        key: paneAskKey(a),
        kind: "pane",
        title: a.question.prompt,
        sub: [
          a.runId ? taskOf(a.runId, a.repo) : undefined,
          a.label,
          a.repo,
          duration(now - Date.parse(a.question.askedAt)),
        ]
          .filter((x) => x !== undefined && x !== "")
          .join(" · "),
        runId: a.runId ?? "",
        repo: a.repo,
        pane: a.paneId,
        hint:
          a.question.source === "agent"
            ? `The ${a.label}'s agent asks: answer it here, or attach and answer in the pane`
            : `The ${a.label}'s host asks: answer it here, or attach and answer in the pane`,
      }),
    ),
    ...runs
      .filter((r) => r.terminalAsk !== undefined)
      .map(
        (r): NeedRow => ({
          key: terminalKey(r),
          kind: "terminal",
          title: r.task,
          sub: ["answers in its terminal", r.repo, asker(r.terminalAsk, r.repo, undefined, r.stage)]
            .filter((x) => x !== undefined && x !== "")
            .join(" · "),
          runId: r.runId,
          repo: r.repo,
          pane: r.terminalAsk,
          hint: "The agent asks on its terminal: open the pane and answer there",
        }),
      ),
    ...runs
      .filter((r) => r.status === "escalated")
      .map(
        (r): NeedRow => ({
          key: escalatedKey(r),
          kind: "escalated",
          title: r.task,
          sub: [`stopped at ${r.stage}`, r.repo, r.runId].filter((x) => x !== undefined).join(" · "),
          runId: r.runId,
          repo: r.repo,
          hint: r.reason ?? "The run stopped and needs work from you",
        }),
      ),
  ];
}
/** The address of a pane's question on Home: `pane/<repo>/<pane>/<question>` (no repository when there is one). */
export const paneAskKey = (a: Pick<PaneAsk, "repo" | "paneId" | "question">): string =>
  ["pane", a.repo, a.paneId, a.question.id].filter((x) => x !== undefined && x !== "").join("/");
/** A row of the queue that is a pane's question (no run). */
export const isPaneAsk = (n: Pick<NeedRow, "kind">): boolean => n.kind === "pane";
/** The pane question a row's key names. */
export const paneAskOf = (asks: readonly PaneAsk[], key: string | undefined): PaneAsk | undefined =>
  key ? asks.find((a) => paneAskKey(a) === key) : undefined;
/** A pane whose question waits for the person (its tile says "needs you"). */
export const paneNeedsYou = (
  pane: { readonly id: string; readonly repo?: string | undefined },
  asks: readonly PaneAsk[],
): boolean => asks.some((a) => a.paneId === pane.id && sameRepo(a.repo, pane.repo));
/**
 * The stable address of one decision on Home: its repository (when the daemon serves a folder),
 * its run and its question, `#/inbox/<repo>/<run>/<question>`. Opening it from anywhere shows
 * exactly that card; Previous and Next go on from there.
 */
export const decisionKey = (i: {
  readonly repo?: string | undefined;
  readonly runId: string;
  readonly question: { readonly id: string };
}): string => [i.repo, i.runId, i.question.id].filter((x) => x !== undefined && x !== "").join("/");
/** The row the Inbox shows: the picked one while it is there, else the first. */
export const pickedNeed = (rows: readonly NeedRow[], pick: string | undefined): NeedRow | undefined =>
  rows.find((r) => r.key === pick) ?? rows[0];
/** The row before or after the shown one (`j`/`k`, the arrows), around the ends. */
export function stepNeed(
  rows: readonly NeedRow[],
  pick: string | undefined,
  step: 1 | -1,
): NeedRow | undefined {
  if (rows.length === 0) return undefined;
  const i = rows.findIndex((r) => r.key === pickedNeed(rows, pick)?.key);
  return rows[(i + step + rows.length) % rows.length];
}
/** What the app says once an answer went through. */
/**
 * The confirmation of an answer, saying what the run did with it (read back from the daemon
 * after the answer): escalated, closed, done, sent back to an earlier stage, or going on. With
 * nothing read back it claims nothing about the run.
 */
export function answeredText(
  choices: readonly string[],
  after?: Pick<RunOverview, "status" | "stage"> | undefined,
  askedAt?: string | undefined,
): string {
  const said = choices.join(", ");
  const rejected = choices.length === 1 && choices[0] === "Reject";
  const head = rejected ? "Rejected" : `Answered: ${said}`;
  if (!after) return `${head}.`;
  if (after.status === "escalated")
    return rejected
      ? "Rejected: the run escalated with your reason. It waits for a person to resume or close it."
      : `${head}. The run escalated: it waits for a person to resume or close it.`;
  if (after.status === "aborted") return `${head}. The run is closed.`;
  if (after.status === "done") return `${head}. The run is done.`;
  if (rejected && askedAt && after.stage !== askedAt)
    return `Rejected: the run goes back to ${after.stage} with your reason.`;
  return `${head}. The run goes on.`;
}
/* ---------- round 3: what the scenario test found ---------- */

/** The pane a host's permission prompt names (`… waits for your answer in pane w1:p4: …`). */
export const paneOfPrompt = (prompt: string): string | undefined =>
  /\bin pane (w\d+:p\d+)\b/.exec(prompt)?.[1];
/**
 * The answer that sends the person to the pane (`Attach and answer in the pane`): the card does
 * not answer for them, it takes them to the terminal where they answer the host themselves.
 */
const ATTACH_PANE = "Attach and answer in the pane";
export const goesToPane = (_q: Pick<Question, "source">, choice: string | undefined): boolean =>
  choice === ATTACH_PANE;
/**
 * A question an agent asks on its terminal, as the daemon reads it: the agent's own words and
 * options, plus the way into the pane. An answer chosen on the card is typed there for the person.
 */
export const isTerminalQuestion = (q: Pick<Question, "source" | "options">): boolean =>
  q.source === "agent" && q.options.some((o) => o.label === ATTACH_PANE);
/**
 * The pane a question asks in: the one its prompt names (a host's prompt), else the pane of the
 * agent that asks (a worker by its name, the conductor by its agent), in the question's run.
 */
export function paneOfQuestion(
  q: Pick<Question, "prompt" | "agent" | "runId">,
  panes: readonly (Pick<PaneView, "id" | "runId" | "role" | "label" | "worker" | "process"> & {
    readonly repo?: string | undefined;
  })[],
): string | undefined {
  const named = paneOfPrompt(q.prompt);
  if (named) return named;
  if (!q.agent) return undefined;
  const own = panes.filter((p) => p.runId === q.runId);
  return (
    own.find((p) => p.worker?.name === q.agent)?.id ??
    own.find((p) => p.role === "conductor" && p.process.kind === "host" && p.process.agent === q.agent)?.id
  );
}
/**
 * Open runs nothing works on: active, no question, no drive, no live session and no person at the
 * keyboard. The Inbox says so instead of "every run is working", with the way to start each.
 */
export function idleRuns<R extends Run>(
  runs: readonly R[],
  panes: readonly (Pick<PaneView, "runId" | "live"> & { readonly repo?: string | undefined })[],
): R[] {
  return runs.filter(
    (r) =>
      r.status === "active" &&
      r.attention !== "you" &&
      r.terminalAsk === undefined &&
      r.questions.length === 0 &&
      !r.driving &&
      r.driver !== "human" &&
      !panes.some((p) => p.runId === r.runId && sameRepo(p.repo, r.repo) && p.live?.alive),
  );
}
/**
 * A gate's prompt as a person reads it: the command a script would run, in backticks and
 * parentheses, is dropped (`A person approves the system plan (\`metator …\`) and …`).
 */
export const humanPrompt = (prompt: string): string =>
  prompt
    .replace(/\s*\(`[^`]*`\)/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
