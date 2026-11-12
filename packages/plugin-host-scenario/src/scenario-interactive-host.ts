import {
  type AgentScenario,
  type AgentTask,
  err,
  fillScenario,
  type InteractiveHost,
  type InteractiveSession,
  MetatorError,
  ok,
  type PtySize,
  type Result,
  type Terminal,
} from "@metator/core";
import { ScenarioAgentHost } from "./scenario-agent-host.ts";

/** The scenario entry an interactive session plays: the agents map's `session` key. */
export const SESSION_AGENT = "session";

/**
 * InteractiveHost that plays a scenario in a real PTY (D3, ADR-0077): a shell script says each
 * `say` line, asks each `ask` by reading a line from the terminal, and exits 0 (or 1 on `fail`).
 * A resumed session plays the agent's next entry, like the scenario AgentHost.
 */
export class ScenarioInteractiveHost implements InteractiveHost {
  readonly id = "scenario";
  private readonly starts = new Map<string, number>();
  private loaded: Promise<Result<AgentScenario, MetatorError>> | undefined;

  constructor(
    private readonly terminal: Terminal,
    private readonly source: AgentScenario | string,
  ) {}

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

  /** The script of the agent's next entry (a resumed session: the entry after the one it names). */
  private async launch(
    task: AgentTask,
    resume?: string,
  ): Promise<Result<{ argv: string[]; sessionId: string }, MetatorError>> {
    const atLeast = resume === undefined ? 0 : Number(/-(\d+)$/.exec(resume)?.[1] ?? 0);
    if (typeof this.source === "string") this.loaded ??= ScenarioAgentHost.load(this.source);
    const scenario = typeof this.source === "string" ? await this.loaded : ok(this.source);
    if (!scenario || scenario.isErr()) return err(scenario?.error ?? MetatorError.notFound("scenario"));
    // The agent's own entry plays when the scenario has one (a conductor or a worker pane); the
    // `session` entry stands in for any interactive session otherwise.
    const entries = scenario.value.agents[task.agent] ?? scenario.value.agents[SESSION_AGENT];
    if (!entries)
      return err(
        MetatorError.usage(
          `the scenario has no \`${task.agent}\` or \`${SESSION_AGENT}\` entry for interactive sessions`,
        ),
      );
    const n = Math.max(this.starts.get(task.agent) ?? 0, atLeast);
    this.starts.set(task.agent, n + 1);
    const steps = entries[Math.min(n, entries.length - 1)] ?? [];
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
    return ok({ argv: ["sh", "-c", lines.join("\n")], sessionId: `scenario-${task.agent}-${n + 1}` });
  }

  private async spawn(
    task: AgentTask,
    size: PtySize,
    resume?: string,
  ): Promise<Result<InteractiveSession, MetatorError>> {
    const launch = await this.launch(task, resume);
    if (launch.isErr()) return err(launch.error);
    const spawned = this.terminal.spawn(launch.value.argv, { cwd: task.cwd, size });
    if (spawned.isErr()) return err(spawned.error);
    return ok({ sessionId: launch.value.sessionId, pty: spawned.value });
  }
}

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
