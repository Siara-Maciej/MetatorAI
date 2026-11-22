import type { AgentTask } from "../domain/drive.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { InteractiveHost, InteractiveSession, PtySize, Terminal } from "../ports/index.ts";

/** What one host CLI is started with, and the id its session is resumed by. */
export interface PtyLaunch {
  readonly argv: readonly string[];
  readonly sessionId: string;
}

/** The one thing that differs between host CLIs: the command line of a new or a resumed session. */
export interface PtyHostSpec {
  readonly id: string;
  /** The session's command line and id; with `resume`, the one that continues that session. */
  launch(task: AgentTask, resume?: string): Promise<Result<PtyLaunch, MetatorError>>;
  /** The session's environment; a host that returns none leaves it to the terminal. */
  env?(task: AgentTask): Record<string, string>;
}

/**
 * InteractiveHost on a host CLI in a PTY (D6, ADR-0077): every such host starts and resumes the
 * same way (the command line in the task's directory, at the given size); `spec` says which
 * command line. An error of `launch` or of the terminal is the result, never a throw.
 */
export class PtyInteractiveHost implements InteractiveHost {
  readonly id: string;

  constructor(
    private readonly terminal: Terminal,
    private readonly spec: PtyHostSpec,
  ) {
    this.id = spec.id;
  }

  start(task: AgentTask, size: PtySize): Promise<Result<InteractiveSession, MetatorError>> {
    return this.spawn(task, size);
  }

  resume(
    sessionId: string,
    task: AgentTask,
    size: PtySize,
  ): Promise<Result<InteractiveSession, MetatorError>> {
    return this.spawn(task, size, sessionId);
  }

  private async spawn(
    task: AgentTask,
    size: PtySize,
    resume?: string,
  ): Promise<Result<InteractiveSession, MetatorError>> {
    const launch = await this.spec.launch(task, resume);
    if (launch.isErr()) return err(launch.error);
    const env = this.spec.env?.(task);
    const spawned = this.terminal.spawn(launch.value.argv, {
      cwd: task.cwd,
      ...(env ? { env } : {}),
      size,
    });
    if (spawned.isErr()) return err(spawned.error);
    return ok({ sessionId: launch.value.sessionId, pty: spawned.value });
  }
}

/**
 * The session id a started session reports when the host names its sessions itself and tells
 * nobody: a resume then takes the most recent session of the working directory (`--continue`).
 * A run's worktree is its own directory, so the most recent session there is the run's.
 */
export const CONTINUE_SESSION = "continue";
