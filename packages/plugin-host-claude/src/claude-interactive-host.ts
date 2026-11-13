import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AgentTask, ok, PtyInteractiveHost, sessionEnv, type Terminal } from "@metator/core";

/**
 * InteractiveHost on Claude Code (D6, ADR-0077): `claude <task> --session-id <uuid>` in a PTY in
 * the run's worktree, with the run directory added and the run's agent when the repository has
 * it; `claude --resume <uuid>` continues. The project's hooks (`.claude/settings.json`) write
 * the run's activity; the end of the session is the process exit.
 */
export class ClaudeInteractiveHost extends PtyInteractiveHost {
  constructor(
    terminal: Terminal,
    bin = "claude",
    env: Readonly<Record<string, string | undefined>> = process.env,
    newId: () => string = () => crypto.randomUUID(),
  ) {
    super(terminal, {
      id: "claude",
      env: (task) => sessionEnv(task, env),
      launch: async (task, resume) => {
        const sessionId = resume ?? newId();
        const mode = resume === undefined ? [task.prompt, "--session-id", sessionId] : ["--resume", resume];
        return ok({ argv: claudeArgv(bin, task, mode), sessionId });
      },
    });
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
