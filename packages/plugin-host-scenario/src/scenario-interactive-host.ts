import {
  type AgentScenario,
  type AgentTask,
  err,
  fillScenario,
  MetatorError,
  ok,
  PtyInteractiveHost,
  type PtyLaunch,
  type Result,
  type Terminal,
} from "@metator/core";
import { ScenarioPlayer } from "./scenario-player.ts";

/** The scenario entry an interactive session plays: the agents map's `session` key. */
export const SESSION_AGENT = "session";

/**
 * InteractiveHost that plays a scenario in a real PTY (D3, ADR-0077): a shell script says each
 * `say` line, asks each `ask` by reading a line from the terminal, and exits 0 (or 1 on `fail`).
 * A resumed session plays the agent's next entry, like the scenario AgentHost.
 */
export class ScenarioInteractiveHost extends PtyInteractiveHost {
  constructor(terminal: Terminal, source: AgentScenario | string) {
    const player = new ScenarioPlayer(source);
    // No environment of its own: the script runs with the terminal's.
    super(terminal, { id: "scenario", launch: (task, resume) => launch(player, task, resume) });
  }
}

/** The script of the agent's next entry (a resumed session: the entry after the one it names). */
async function launch(
  player: ScenarioPlayer,
  task: AgentTask,
  resume: string | undefined,
): Promise<Result<PtyLaunch, MetatorError>> {
  const atLeast = resume === undefined ? 0 : Number(/-(\d+)$/.exec(resume)?.[1] ?? 0);
  // The agent's own entry plays when the scenario has one (a conductor or a worker pane); the
  // `session` entry stands in for any interactive session otherwise.
  const turn = await player.next(task.agent, atLeast, SESSION_AGENT);
  if (turn.isErr()) return err(turn.error);
  if (!turn.value)
    return err(
      MetatorError.usage(
        `the scenario has no \`${task.agent}\` or \`${SESSION_AGENT}\` entry for interactive sessions`,
      ),
    );
  const { steps, sessionId } = turn.value;
  const vars = { runDir: task.runDir, cwd: task.cwd };
  const lines: string[] = [];
  for (const step of steps) {
    if ("say" in step) lines.push(`printf '%s\\n' ${quote(fillScenario(step.say, vars))}`);
    else if ("ask" in step) {
      lines.push(`printf '%s\\n' ${quote(`${step.ask.question} [${step.ask.options.join(" / ")}]`)}`);
      lines.push(`read -r answer; printf 'answer: %s\\n' "$answer"`);
    } else if ("write" in step) {
      lines.push(`mkdir -p "$(dirname ${quote(fillScenario(step.write.path, vars))})"`);
      lines.push(
        `printf '%s' ${quote(fillScenario(step.write.text, vars))} > ${quote(fillScenario(step.write.path, vars))}`,
      );
    } else if ("tool" in step)
      lines.push(`printf '%s\\n' ${quote(`[tool] ${step.tool.name} ${step.tool.summary}`)}`);
    else lines.push(`printf '%s\\n' ${quote(step.fail)}; exit 1`);
  }
  return ok({ argv: ["sh", "-c", lines.join("\n")], sessionId });
}

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
