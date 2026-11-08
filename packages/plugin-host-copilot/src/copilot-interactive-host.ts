import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTask,
  err,
  type InteractiveHost,
  type InteractiveSession,
  isUuid,
  type MetatorError,
  ok,
  type PtySize,
  type Result,
  sessionEnv,
  type Terminal,
} from "@metator/core";

/**
 * The session id a started session reports when the host names its sessions itself and tells
 * nobody: a resume then takes the most recent session of the working directory (`--continue`).
 * A run's worktree is its own directory, so the most recent session there is the run's.
 */
export const CONTINUE = "continue";

/**
 * InteractiveHost on GitHub Copilot CLI (D6, ADR-0077): `copilot -i <task>` in a PTY in the
 * run's worktree, with the run directory added, the run's agent when the repository has it,
 * and git push denied at the process level. The hooks (`.github/hooks/metator.json`) write the
 * run's activity; the end of the session is the process exit.
 */
export class CopilotInteractiveHost implements InteractiveHost {
  readonly id = "copilot";

  constructor(
    private readonly terminal: Terminal,
    private readonly bin: string = "copilot",
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async start(task: AgentTask, size: PtySize): Promise<Result<InteractiveSession, MetatorError>> {
    return this.spawn(task, size, ["-i", task.prompt], CONTINUE);
  }

  async resume(
    sessionId: string,
    task: AgentTask,
    size: PtySize,
  ): Promise<Result<InteractiveSession, MetatorError>> {
    const mode = isUuid(sessionId) ? ["--resume", sessionId] : ["--continue"];
    return this.spawn(task, size, mode, sessionId);
  }

  private spawn(
    task: AgentTask,
    size: PtySize,
    mode: readonly string[],
    sessionId: string,
  ): Result<InteractiveSession, MetatorError> {
    const spawned = this.terminal.spawn(copilotArgv(this.bin, task, mode), {
      cwd: task.cwd,
      env: sessionEnv(task, this.env),
      size,
    });
    if (spawned.isErr()) return err(spawned.error);
    return ok({ sessionId, pty: spawned.value });
  }
}

/** The Copilot CLI command line of a session: the mode (start or resume) first, then the run's context. */
export function copilotArgv(bin: string, task: AgentTask, mode: readonly string[]): string[] {
  const agentFile = join(task.projectRoot, ".github", "agents", `${task.agent}.agent.md`);
  return [
    bin,
    ...mode,
    ...(existsSync(agentFile) ? ["--agent", task.agent] : []),
    ...[task.runDir, ...(task.dirs ?? [])].flatMap((d) => ["--add-dir", d]),
    "--deny-tool",
    "shell(git push)",
  ];
}
