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

  /** The session's command line and id; with `resume`, the one that continues that session. */
  private async launch(
    task: AgentTask,
    resume?: string,
  ): Promise<Result<{ argv: string[]; sessionId: string }, MetatorError>> {
    const sessionId = resume ?? this.newId();
    const mode = resume === undefined ? [task.prompt, "--session-id", sessionId] : ["--resume", resume];
    return ok({ argv: claudeArgv(this.bin, task, mode), sessionId });
  }

  async start(task: AgentTask, size: PtySize): Promise<Result<InteractiveSession, MetatorError>> {
    return this.spawn(task, size);
  }

  async resume(
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
    const launch = await this.launch(task, resume);
    if (launch.isErr()) return err(launch.error);
    const spawned = this.terminal.spawn(launch.value.argv, {
      cwd: task.cwd,
      env: sessionEnv(task, this.env),
      size,
    });
    if (spawned.isErr()) return err(spawned.error);
    return ok({ sessionId: launch.value.sessionId, pty: spawned.value });
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
