import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTask,
  CONTINUE_SESSION,
  ok,
  PtyInteractiveHost,
  sessionEnv,
  type Terminal,
} from "@metator/core";

/** OpenCode names its sessions itself (`ses_…`): a started session is resumed as the directory's latest. */
export const CONTINUE = CONTINUE_SESSION;

/**
 * InteractiveHost on OpenCode (D6, ADR-0077): `opencode <worktree> --prompt <task>` in a PTY,
 * with the run's agent when the repository defines it (`.opencode/agent/<id>.md`);
 * `opencode --session <id>` or `--continue` resumes. An OpenCode plugin writes the run's
 * activity from its hooks; the end of the session is the process exit.
 */
export class OpencodeInteractiveHost extends PtyInteractiveHost {
  constructor(
    terminal: Terminal,
    bin = "opencode",
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    super(terminal, {
      id: "opencode",
      env: (task) => sessionEnv(task, env),
      launch: async (task, resume) => {
        const mode =
          resume === undefined
            ? ["--prompt", task.prompt]
            : resume.startsWith("ses_")
              ? ["--session", resume]
              : ["--continue"];
        return ok({ argv: opencodeArgv(bin, task, mode), sessionId: resume ?? CONTINUE });
      },
    });
  }
}

/** The OpenCode command line of a session: the project directory, the mode, the run's agent. */
export function opencodeArgv(bin: string, task: AgentTask, mode: readonly string[]): string[] {
  const agentFile = join(task.projectRoot, ".opencode", "agent", `${task.agent}.md`);
  return [bin, task.cwd, ...mode, ...(existsSync(agentFile) ? ["--agent", task.agent] : [])];
}
