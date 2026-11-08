import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTask,
  err,
  type InteractiveHost,
  type InteractiveSession,
  type MetatorError,
  ok,
  type PtySize,
  type Result,
  sessionEnv,
  type Terminal,
} from "@metator/core";

/** See `CONTINUE` in the Copilot host: OpenCode names its sessions itself (`ses_…`). */
export const CONTINUE = "continue";

/**
 * InteractiveHost on OpenCode (D6, ADR-0077): `opencode <worktree> --prompt <task>` in a PTY,
 * with the run's agent when the repository defines it (`.opencode/agent/<id>.md`);
 * `opencode --session <id>` or `--continue` resumes. An OpenCode plugin writes the run's
 * activity from its hooks; the end of the session is the process exit.
 */
export class OpencodeInteractiveHost implements InteractiveHost {
  readonly id = "opencode";

  constructor(
    private readonly terminal: Terminal,
    private readonly bin: string = "opencode",
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async start(task: AgentTask, size: PtySize): Promise<Result<InteractiveSession, MetatorError>> {
    return this.spawn(task, size, ["--prompt", task.prompt], CONTINUE);
  }

  async resume(
    sessionId: string,
    task: AgentTask,
    size: PtySize,
  ): Promise<Result<InteractiveSession, MetatorError>> {
    const mode = sessionId.startsWith("ses_") ? ["--session", sessionId] : ["--continue"];
    return this.spawn(task, size, mode, sessionId);
  }

  private spawn(
    task: AgentTask,
    size: PtySize,
    mode: readonly string[],
    sessionId: string,
  ): Result<InteractiveSession, MetatorError> {
    const spawned = this.terminal.spawn(opencodeArgv(this.bin, task, mode), {
      cwd: task.cwd,
      env: sessionEnv(task, this.env),
      size,
    });
    if (spawned.isErr()) return err(spawned.error);
    return ok({ sessionId, pty: spawned.value });
  }
}

/** The OpenCode command line of a session: the project directory, the mode, the run's agent. */
export function opencodeArgv(bin: string, task: AgentTask, mode: readonly string[]): string[] {
  const agentFile = join(task.projectRoot, ".opencode", "agent", `${task.agent}.md`);
  return [bin, task.cwd, ...mode, ...(existsSync(agentFile) ? ["--agent", task.agent] : [])];
}
