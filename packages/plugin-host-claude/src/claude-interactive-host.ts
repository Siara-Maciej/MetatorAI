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

/**
 * InteractiveHost on Claude Code (D6, ADR-0077): `claude <task> --session-id <uuid>` in a PTY in
 * the run's worktree, with the run directory added and the run's agent when the repository has
 * it; `claude --resume <uuid>` continues. The project's hooks (`.claude/settings.json`) write
 * the run's activity; the end of the session is the process exit.
 */
export class ClaudeInteractiveHost implements InteractiveHost {
  readonly id = "claude";

  constructor(
    private readonly terminal: Terminal,
    private readonly bin: string = "claude",
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async start(task: AgentTask, size: PtySize): Promise<Result<InteractiveSession, MetatorError>> {
    const sessionId = this.newId();
    return this.spawn(task, size, [task.prompt, "--session-id", sessionId], sessionId);
  }

  async resume(
    sessionId: string,
    task: AgentTask,
    size: PtySize,
  ): Promise<Result<InteractiveSession, MetatorError>> {
    return this.spawn(task, size, ["--resume", sessionId], sessionId);
  }

  private spawn(
    task: AgentTask,
    size: PtySize,
    mode: readonly string[],
    sessionId: string,
  ): Result<InteractiveSession, MetatorError> {
    const spawned = this.terminal.spawn(claudeArgv(this.bin, task, mode), {
      cwd: task.cwd,
      env: sessionEnv(task, this.env),
      size,
    });
    if (spawned.isErr()) return err(spawned.error);
    return ok({ sessionId, pty: spawned.value });
  }
}

/** The Claude Code command line of a session: the mode (start or resume) first, then the run's context. */
export function claudeArgv(bin: string, task: AgentTask, mode: readonly string[]): string[] {
  const agentFile = join(task.projectRoot, ".claude", "agents", `${task.agent}.md`);
  return [
    bin,
    ...mode,
    ...(existsSync(agentFile) ? ["--agent", task.agent] : []),
    ...[task.runDir, ...(task.dirs ?? [])].flatMap((d) => ["--add-dir", d]),
    "--permission-mode",
    "default",
  ];
}
