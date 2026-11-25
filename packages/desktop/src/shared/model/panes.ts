/**
 * A pane as the app shows it: its label, its state from what its process does, its note.
 */
import type { PanePaused, PaneView } from "../api/api.ts";

/** The panes of a run (R4): the conductor first, then workers in order, then the rest. */
export function panesOfRun<P extends Pick<PaneView, "runId" | "role" | "id">>(
  panes: readonly P[],
  runId: string,
): P[] {
  const rank: Record<PaneView["role"], number> = { conductor: 0, worker: 1, gate: 2, apps: 3, shell: 4 };
  return panes
    .filter((p) => p.runId === runId)
    .sort((a, b) => rank[a.role] - rank[b.role] || a.id.localeCompare(b.id, undefined, { numeric: true }));
}
/** What a pane tab says: its worker's name, its agent, or its role. */
export function paneLabel(pane: Pick<PaneView, "role" | "label" | "worker" | "process">): string {
  if (pane.worker) return pane.worker.name;
  if (pane.role === "conductor")
    return `agent · ${pane.process.kind === "host" ? pane.process.agent : pane.label}`;
  return pane.label || pane.role;
}
/**
 * What a pane reads as, on every screen: an agent at work, an agent that asks (on its own screen
 * or on a card), a pane where nothing happens, a process that ended.
 */
export type PaneShown = "working" | "asks" | "idle" | "finished" | "exited" | "paused";
/** A shell with no output for this long sits at its prompt: it is idle, whatever the daemon's longer quiet time says. */
export const SHELL_QUIET_MS = 2000;
/**
 * The state of a pane as the app shows it. The daemon's `blocked` (the host's prompt is on the
 * screen) and `waiting` (a question of the run is open) both read `asks`, and only for an agent: a
 * shell of the same run does not ask, it is idle. A shell is "working" only while it prints: the
 * daemon calls a pane working for its host's whole quiet time (15 s for a program it does not
 * know), which a shell at its prompt is not. A live shell the daemon says nothing about is idle
 * too. A process that ended with code 0 is `finished`; any other end, or no process at all, `exited`.
 */
export function paneStateOf(
  pane: Pick<PaneView, "process" | "state"> & {
    readonly ended?: PaneView["ended"] | undefined;
    readonly paused?: PanePaused | undefined;
    readonly runId?: string | undefined;
    readonly live?:
      | (Pick<NonNullable<PaneView["live"]>, "alive" | "lastOutputAt"> & {
          readonly exitCode?: number | undefined;
        })
      | undefined;
  },
  now: number = Date.now(),
): PaneShown {
  const raw = pane.state?.state;
  // Its host stopped with the daemon, or was lost, and the work is not over: it can be continued.
  if (pane.paused && !pane.ended) return "paused";
  // The daemon says the pane's work is over (`ended`): finished, or a failure with its code.
  if (pane.ended)
    return pane.ended.exitCode !== undefined && pane.ended.exitCode !== 0 ? "exited" : "finished";
  // A process that ended by itself with code 0 did its work: a finished worker, not a failure.
  if (pane.live && !pane.live.alive && pane.live.exitCode === 0) return "finished";
  if (raw === "exited" || !pane.live?.alive) return "exited";
  const agent = pane.process.kind === "host";
  // A host's prompt on the screen asks, run or no run (the intake chat's leave to run a command);
  // an open question of a run is not the intake's: before its run it only waits for a task.
  if (raw === "blocked") return agent ? "asks" : "idle";
  if (raw === "waiting") return agent && !isIntake(pane) ? "asks" : "idle";
  if (raw === "idle") return "idle";
  if (agent) return "working";
  const last = Date.parse(pane.live.lastOutputAt ?? "");
  return raw === "working" && now - last < SHELL_QUIET_MS ? "working" : "idle";
}
/** The pane where a run begins: an agent of no run, to whom the person describes what to do. */
export const isIntake = (
  pane: Pick<PaneView, "process"> & { readonly runId?: string | undefined },
): boolean => pane.process.kind === "host" && pane.runId === undefined;
/** What a pane says beside its state, when the state alone would mislead: an idle intake pane is ready. */
export const paneNote = (
  pane: Pick<PaneView, "process"> & { readonly runId?: string | undefined },
  state: PaneShown,
): string | undefined => (isIntake(pane) && state === "idle" ? "ready for your task" : undefined);
