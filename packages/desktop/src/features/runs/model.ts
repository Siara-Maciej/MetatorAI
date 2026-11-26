/**
 * A run's page: its phase, its conductor, its terminal's ports, why it stopped, the new-run form's choices.
 */
import type { Activity, PaneView, PlanLintProblem, RunOverview } from "../../shared/api/api.ts";
import { idleRuns } from "../../shared/model/needs.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { isFinished, type Run } from "../../shared/model/runs.ts";

/** The button of a start refused for uncommitted changes. */
export const START_FROM_COMMIT = "Start from the last commit";
/** A start refused because tracked files have uncommitted changes: the app offers to start without them. */
export const refusedForDirtyTree = (
  error: { readonly details?: Readonly<Record<string, unknown>> } | undefined,
): boolean => error?.details?.check === "tree";
/** An autonomy level with words beside it: `L0: every approval waits for you`. */
export const autonomyLabel = (level: string): string =>
  level === "L0"
    ? "L0: every approval waits for you"
    : level === "L1"
      ? "L1: skips the approvals the workflow lets it skip"
      : level === "L2"
        ? "L2: no person at hand; only the approvals that are never skipped wait"
        : level;
/** The autonomy levels the form offers for a workflow: the ones it lists; L0 and L1 when the daemon does not say. */
export const autonomyLevels = (
  workflow: { readonly autonomy?: readonly string[] | undefined } | undefined,
): readonly string[] => (workflow?.autonomy?.length ? workflow.autonomy : ["L0", "L1"]);
/**
 * Where a run stands for the session screen's bar: `escalated` and `finished` runs have no
 * driver to show and nothing to attach to.
 */
export const runPhase = (r: Pick<RunOverview, "status">): "active" | "escalated" | "finished" =>
  r.status === "escalated" ? "escalated" : isFinished(r) ? "finished" : "active";
/** Events grouped by the stage they happened in, in the order the stages first appear. */
export function byStage<E extends Pick<Activity, "stage">>(entries: readonly E[]): [string, E[]][] {
  const groups = new Map<string, E[]>();
  for (const e of entries) groups.set(e.stage ?? "run", [...(groups.get(e.stage ?? "run") ?? []), e]);
  return [...groups.entries()];
}
/** The ports of a service as text: `web 3000, db 5432`; `no port` when it holds none. */
export const portsText = (ports: Readonly<Record<string, number>>): string =>
  Object.entries(ports)
    .map(([name, port]) => `${name} ${port}`)
    .join(", ") || "no port";
/**
 * A run that asks on a card while no session runs for it and nothing drives it: its question
 * waits on Home, and its conductor can still be opened in a terminal (the question stays).
 */
export function asksWithoutSession<R extends Run>(
  r: R,
  panes: readonly (Pick<PaneView, "runId" | "live"> & { readonly repo?: string | undefined })[],
): boolean {
  return (
    r.status === "active" &&
    r.questions.length > 0 &&
    !r.driving &&
    r.driver !== "human" &&
    !panes.some((p) => p.runId === r.runId && sameRepo(p.repo, r.repo) && p.live?.alive)
  );
}
/**
 * A run its conductor moves on: active, at a stage that is no human gate, nothing driving it in
 * the background and nobody asked, while its conductor's pane lives. Without this it would look
 * stuck; the person talks to the conductor in its terminal.
 */
export function conductorMoves(
  r: Pick<Run, "status" | "driving" | "driver" | "questions" | "terminalAsk" | "stages" | "runId" | "repo">,
  panes: readonly (Pick<PaneView, "runId" | "role" | "live"> & { readonly repo?: string | undefined })[],
): boolean {
  if (r.status !== "active" || r.driving || r.driver === "human") return false;
  if (r.questions.length > 0 || r.terminalAsk !== undefined) return false;
  if (r.stages.some((s) => s.state === "waiting" && s.hitl)) return false;
  return panes.some(
    (p) => p.runId === r.runId && sameRepo(p.repo, r.repo) && p.role === "conductor" && p.live?.alive,
  );
}
/** The problems of one step (or one field of it), and the ones about the whole plan. */
export const problemsAt = <P extends Pick<PlanLintProblem, "step" | "field">>(
  problems: readonly P[],
  step: string | undefined,
  field?: string | undefined,
): P[] =>
  problems.filter(
    (p) => p.step === step && (field === undefined || p.field === field || p.field?.endsWith(`.${field}`)),
  );
/**
 * The run's page offers "Open a session" in its bar above the tabs (an idle run, or one whose
 * question waits on a card): the Terminal tab points there instead of offering it twice.
 */
export const sessionOfferedAbove = <R extends Run>(
  r: R,
  panes: readonly (Pick<PaneView, "runId" | "live"> & { readonly repo?: string | undefined })[],
): boolean => runPhase(r) === "active" && (asksWithoutSession(r, panes) || idleRuns([r], panes).length > 0);
/** An event's line in a plain list: its agent first, unless the text already starts with it. */
export const activityLine = (e: Pick<Activity, "agent" | "text">): string =>
  e.agent && !e.text.startsWith(`${e.agent} `) ? `${e.agent} ${e.text}` : e.text;
