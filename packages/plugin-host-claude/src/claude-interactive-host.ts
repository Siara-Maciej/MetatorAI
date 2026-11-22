import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTask,
  claudeDenyRules,
  DEFAULT_GUARD_COMMANDS,
  type GuardCommands,
  ok,
  PtyInteractiveHost,
  sessionEnv,
  type Terminal,
} from "@metator/core";
import { claudeAgentFile } from "./claude-generator.ts";

/**
 * InteractiveHost on Claude Code (D6, ADR-0077): `claude <task> --session-id <uuid>` in a PTY in
 * the run's worktree, with the run directory added and the run's agent when the repository has
 * it, and the config's never-commands denied at the process level; `claude --resume <uuid>` continues. The project's hooks (`.claude/settings.json`) write
 * the run's activity; the end of the session is the process exit.
 */
export class ClaudeInteractiveHost extends PtyInteractiveHost {
  constructor(
    terminal: Terminal,
    bin = "claude",
    env: Readonly<Record<string, string | undefined>> = process.env,
    newId: () => string = () => crypto.randomUUID(),
    guard: GuardCommands = DEFAULT_GUARD_COMMANDS,
  ) {
    super(terminal, {
      id: "claude",
      env: (task) => sessionEnv(task, env),
      launch: async (task, resume) => {
        const sessionId = resume ?? newId();
        const mode = resume === undefined ? [task.prompt, "--session-id", sessionId] : ["--resume", resume];
        return ok({ argv: claudeArgv(bin, task, mode, guard), sessionId });
      },
    });
  }
}

/** The Claude Code command line of a session: the mode (start or resume) first, then the run's context. */
export function claudeArgv(
  bin: string,
  task: AgentTask,
  mode: readonly string[],
  guard: GuardCommands = DEFAULT_GUARD_COMMANDS,
): string[] {
  const agentFile = join(task.projectRoot, claudeAgentFile(task.agent));
  return [
    bin,
    ...mode,
    ...(existsSync(agentFile) ? ["--agent", task.agent] : []),
    ...[task.runDir, ...(task.dirs ?? [])].flatMap((d) => ["--add-dir", d]),
    "--permission-mode",
    "default",
    // What never runs (guard.commands.never) is denied by the process too, the same list Copilot
    // CLI gets as --deny-tool (ADR-0100); the generated settings say it for a session started by hand.
    ...claudeDenyRules(guard, { headless: false }).flatMap((r) => ["--disallowedTools", r]),
  ];
}
