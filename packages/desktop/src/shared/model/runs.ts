/**
 * A run as the app shows it (view logic the daemon does not do): its state, stage, hosts and choices. Pure, tested in test/.
 */
import type { PaneView, RunOverview } from "../api/api.ts";
import { duration } from "./format.ts";
import type { PaneShown } from "./panes.ts";
import type { RunTab } from "./route.ts";

/**
 * A run as the app sees it: with the repository it belongs to when the daemon serves a folder,
 * and the pane in which its agent asks when the question is on the terminal and not on a card.
 */
export type Run = RunOverview & {
  readonly repo?: string | undefined;
  readonly terminalAsk?: string | undefined;
};
/**
 * Runs with what their terminals say (D2): an active run with no question on a card whose pane is
 * blocked (the agent asks on its screen) waits for you like any other, and names the pane to open.
 * Every count and order of the app reads `attention`, so they all see it.
 */
export function withTerminalAsks(
  runs: readonly Run[],
  panes: readonly (Pick<PaneView, "id" | "runId" | "state"> & { readonly repo?: string | undefined })[],
): Run[] {
  return runs.map((r) => {
    if (r.status !== "active" || r.questions.length > 0) return r;
    const asking = panes.find(
      (p) => p.runId === r.runId && (p.repo ?? "") === (r.repo ?? "") && p.state?.state === "blocked",
    );
    return asking ? { ...r, attention: "you" as const, terminalAsk: asking.id } : r;
  });
}
/**
 * Done, aborted or planned: nothing is left to do. A `planned` run (round 17, `--until plan`) ended
 * once its plan was approved; Implement starts the work from it. An escalated run is not finished,
 * it waits for a person (F1).
 */
export const isFinished = (r: Pick<RunOverview, "status">): boolean =>
  r.status === "done" || r.status === "aborted" || r.status === "planned";
/** An interactive host as `/supervisor` reports it: the program it starts, and whether it is there. */
export interface HostStatus {
  readonly id: string;
  readonly command?: string | undefined;
  readonly installed: boolean;
}
/**
 * The host of a new session (D1): the first of `hostOrder` that is installed, else any installed
 * one, else none. A daemon that does not report what is installed leaves the order to decide.
 */
export function hostChoice(
  hostOrder: readonly string[],
  status: readonly HostStatus[] | undefined,
  hosts: readonly string[] = [],
): string | undefined {
  if (!status) return hostOrder.find((h) => hosts.includes(h)) ?? hosts[0];
  const installed = status.filter((h) => h.installed).map((h) => h.id);
  return hostOrder.find((h) => installed.includes(h)) ?? installed[0];
}
const listed = (words: readonly string[]): string =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
/** What the app says when no host can start: what was looked for and where the guide is. */
export const noHostText = (status: readonly HostStatus[]): string =>
  `No AI host is installed. The daemon looked for ${listed(status.map((h) => h.command ?? h.id))} and found none. ` +
  'Install one of them (the guide page "Copilot and Claude Code", site/guide/hosts.md, says how), ' +
  "then try again.";
/** The workflow of a run started from the backlog (D5): the wanted one when the repository has it, `mt-feature`, else its first. */
export const workflowChoice = (
  workflows: readonly string[],
  wanted: string | undefined,
): string | undefined =>
  wanted && workflows.includes(wanted)
    ? wanted
    : workflows.includes("mt-feature")
      ? "mt-feature"
      : workflows[0];
/** The runs that are not finished, escalated ones included. */
export const openRuns = <R extends Pick<RunOverview, "status">>(runs: readonly R[]): R[] =>
  runs.filter((r) => !isFinished(r));
/** What the session screen says of a finished run in one line. */
export const finishedText = (r: Pick<RunOverview, "status" | "stage" | "reason" | "elapsedMs">): string =>
  r.status === "aborted"
    ? `Closed as aborted at ${r.stage}${r.reason ? `: ${r.reason}` : ""}.`
    : r.status === "planned"
      ? `Plan ready: approved in ${duration(r.elapsedMs)}. Implement starts the work from it.`
      : `Done: every stage passed, in ${duration(r.elapsedMs)}.`;
/** What a run reads as, in the sidebar and everywhere a run is one row. */
export type RunShown = "needs you" | "working" | "escalated" | "done" | "plan ready" | "aborted" | "idle";
/**
 * The state of a run in one of six words. A finished run reads `done` (its status wins over a
 * pane that is still alive); `isNews` says whether this person has seen it since. An aborted run
 * reads `aborted`, its own word: it ended without its work. A stopped run is `idle`.
 */
export function runStateOf(run: Pick<RunOverview, "attention" | "status">): RunShown {
  // The run's status wins over what its panes or its drive still say: a finished run is finished.
  if (run.status === "done") return "done";
  // A run made to plan only (`--until plan`): its plan is approved and waits for Implement.
  if (run.status === "planned") return "plan ready";
  if (run.status === "aborted") return "aborted";
  if (run.status === "escalated" || run.attention === "escalated") return "escalated";
  if (run.attention === "you") return "needs you";
  if (run.attention === "driving") return "working";
  return "idle";
}
/**
 * A finished run this person has not opened since it finished: news, drawn in its colour until
 * they look. Once seen it still reads `done`, quietly.
 */
export const isNews = (
  run: Pick<RunOverview, "status" | "updatedAt">,
  seenAt?: string | undefined,
): boolean => run.status === "done" && !(seenAt !== undefined && seenAt >= run.updatedAt);
/** What wins when states meet: a person is needed first, then work, then news, then quiet. */
const RUN_RANK: Readonly<Record<RunShown, number>> = {
  "needs you": 0,
  escalated: 1,
  working: 2,
  done: 3,
  "plan ready": 3,
  idle: 4,
  aborted: 5,
};
/** A pane's state as a run's: an agent that asks needs you, one that works is working. */
export const paneAsRun = (state: PaneShown): RunShown =>
  // A finished worker is not news of the run: the run says when it is done.
  state === "asks" ? "needs you" : state === "working" ? "working" : "idle";
/**
 * States rolled up: the panes of a run into the run, the runs of a repository into the
 * repository. The strongest one wins; nothing to roll up is `idle`.
 */
export const rollUp = (states: readonly RunShown[]): RunShown =>
  states.length === 0
    ? "idle"
    : states.reduce<RunShown>((best, s) => (RUN_RANK[s] < RUN_RANK[best] ? s : best), states[0] as RunShown);
/** A run's state with its panes: the run's own word, unless one of its panes says more. */
export const runWithPanes = (
  run: Pick<RunOverview, "attention" | "status">,
  panes: readonly PaneShown[],
): RunShown => rollUp([runStateOf(run), ...(isFinished(run) ? [] : panes.map(paneAsRun))]);
/**
 * The one dim line under a run's name: its step, that it asks on its terminal, its current
 * stage. A finished run says how it ended (`done`, `aborted`), never the stage it stopped at.
 * No host and no age: those are in the run's Details.
 */
export const runLine = (
  r: Pick<Run, "stage" | "terminalAsk"> & Partial<Pick<Run, "status">>,
  step?: string | undefined,
  elsewhere?: string | undefined,
): string =>
  [
    step,
    elsewhere,
    r.terminalAsk && !(r.status && isFinished({ status: r.status })) ? "asks in its terminal" : undefined,
    r.status && isFinished({ status: r.status }) ? r.status : r.stage,
  ]
    .filter((x) => x !== undefined)
    .join(" · ");
/**
 * The tab a run opens on from the sidebar: where the work is while it runs, the summary once it
 * is finished. A task's page (a system run, a run with child runs) has no terminal: its Overview.
 */
export const runTabFor = (
  r: Pick<RunOverview, "status"> & Partial<Pick<RunOverview, "workflow" | "children">>,
): RunTab =>
  isFinished(r) || /system/.test(r.workflow ?? "") || (r.children?.length ?? 0) > 0 ? "overview" : "terminal";
