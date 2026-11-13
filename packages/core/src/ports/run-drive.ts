import type { MetatorError } from "../domain/errors.ts";
import type { Result } from "../domain/result.ts";

/**
 * Starts the process that drives a run on its own, in the background. Only the program a person
 * started knows how to start itself again (its own command line), so the driving adapter gives
 * the implementation; core decides whether a drive may start, never how the process is made.
 */
export interface DetachedDrive {
  start(input: {
    readonly runId: string;
    readonly host: string;
    readonly maxSteps?: number;
  }): Promise<Result<{ readonly pid: number }, MetatorError>>;
}

/**
 * The panes a run's sessions live in. They belong to the daemon's process: inside it they are
 * closed directly, from a command through the daemon (and with no daemon there is none to close).
 */
export interface RunPanes {
  closeRun(
    runId: string,
  ): Promise<Result<{ readonly closed: number; readonly workspace?: string }, MetatorError>>;
}
