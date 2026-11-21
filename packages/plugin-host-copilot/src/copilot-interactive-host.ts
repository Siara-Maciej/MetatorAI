import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTask,
  CONTINUE_SESSION,
  DEFAULT_GUARD_COMMANDS,
  denyToolsOf,
  type HostGuard,
  isUuid,
  ok,
  PtyInteractiveHost,
  sessionEnv,
  type Terminal,
} from "@metator/core";
import { copilotAgentFile } from "./copilot-generator.ts";

/** Copilot names its sessions itself: a started session is resumed as the directory's latest. */
export const CONTINUE = CONTINUE_SESSION;

/**
 * InteractiveHost on GitHub Copilot CLI (D6, ADR-0077): `copilot -i <task>` in a PTY in the
 * run's worktree, with the run directory added, the run's agent when the repository has it,
 * and the config's never-commands denied at the process level. The hooks (`.github/hooks/metator.json`) write the
 * run's activity; the end of the session is the process exit.
 */
export class CopilotInteractiveHost extends PtyInteractiveHost {
  constructor(
    terminal: Terminal,
    bin = "copilot",
    env: Readonly<Record<string, string | undefined>> = process.env,
    guard: HostGuard = DEFAULT_GUARD_COMMANDS,
  ) {
    super(terminal, {
      id: "copilot",
      env: (task) => sessionEnv(task, env),
      launch: async (task, resume) => {
        const mode =
          resume === undefined ? ["-i", task.prompt] : isUuid(resume) ? ["--resume", resume] : ["--continue"];
        return ok({ argv: copilotArgv(bin, task, mode, guard), sessionId: resume ?? CONTINUE });
      },
    });
  }
}

/** The Copilot CLI command line of a session: the mode (start or resume) first, then the run's context. */
export function copilotArgv(
  bin: string,
  task: AgentTask,
  mode: readonly string[],
  guard: HostGuard = DEFAULT_GUARD_COMMANDS,
): string[] {
  const agentFile = join(task.projectRoot, copilotAgentFile(task.agent));
  return [
    bin,
    ...mode,
    ...(existsSync(agentFile) ? ["--agent", task.agent] : []),
    ...[task.runDir, ...(task.dirs ?? [])].flatMap((d) => ["--add-dir", d]),
    // What never runs (guard.commands.never) is denied by the process too; what asks is the
    // hook's and Copilot's own approval prompt (ADR-0094).
    ...denyToolsOf(guard, { headless: false }).flatMap((t) => ["--deny-tool", t]),
    // What needs no approval (`guard.prompts: metator`): Copilot takes its allow list up front,
    // by command prefix; a denial above still wins.
    ...(guard.unprompted ?? []).flatMap((t) => ["--allow-tool", t]),
  ];
}
