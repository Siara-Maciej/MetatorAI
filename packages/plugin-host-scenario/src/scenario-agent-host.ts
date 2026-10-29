import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  type AgentAnswer,
  type AgentEvent,
  type AgentHost,
  type AgentQuestion,
  type AgentScenario,
  AgentScenarioDocument,
  type AgentTask,
  err,
  fillScenario,
  MetatorError,
  ok,
  type Result,
} from "@metator/core";
import { parse } from "yaml";

/**
 * AgentHost that plays a scenario (ADR-0051): no model, the same events a real host emits.
 * Each start of an agent takes the agent's next entry; the last entry repeats.
 */
export class ScenarioAgentHost implements AgentHost {
  readonly id = "scenario";
  private readonly starts = new Map<string, number>();
  private loaded: Promise<Result<AgentScenario, MetatorError>> | undefined;

  /** A scenario, or the path of an AgentScenario file read at the first start. */
  constructor(private readonly source: AgentScenario | string) {}

  /** Reads the scenario file; a missing or invalid one is an error value with the reason. */
  static async load(file: string): Promise<Result<AgentScenario, MetatorError>> {
    const handle = Bun.file(file);
    if (!(await handle.exists())) return err(MetatorError.notFound(`scenario ${file}`));
    let raw: unknown;
    try {
      raw = parse(await handle.text());
    } catch (e) {
      return err(new MetatorError("PARSE_FAILED", `${file}: ${(e as Error).message}`));
    }
    return AgentScenarioDocument.parse(raw, file);
  }

  async *run(task: AgentTask, ask: (q: AgentQuestion) => Promise<AgentAnswer>): AsyncIterable<AgentEvent> {
    if (typeof this.source === "string") this.loaded ??= ScenarioAgentHost.load(this.source);
    const scenario = typeof this.source === "string" ? await this.loaded : ok(this.source);
    if (!scenario || scenario.isErr()) {
      yield { type: "result", ok: false, text: scenario?.error.message ?? "no scenario" };
      return;
    }
    const entries = scenario.value.agents[task.agent];
    if (!entries) {
      yield { type: "result", ok: false, text: `the scenario has no entry for ${task.agent}` };
      return;
    }
    // Continuing a session of this agent (a new process, e.g. `ask --continue`) plays the entry after it.
    const resumed = task.resume?.match(new RegExp(`^scenario-${task.agent}-(\\d+)$`))?.[1];
    const n = Math.max(this.starts.get(task.agent) ?? 0, resumed ? Number(resumed) : 0);
    this.starts.set(task.agent, n + 1);
    const steps = entries[Math.min(n, entries.length - 1)] ?? [];
    yield { type: "session", id: `scenario-${task.agent}-${n + 1}` };
    const said: string[] = [];
    const vars = { runDir: task.runDir, cwd: task.cwd };
    for (const step of steps) {
      if ("say" in step) {
        const text = fillScenario(step.say, vars);
        said.push(text);
        yield { type: "text", text };
      } else if ("write" in step) {
        const target = fillScenario(step.write.path, vars);
        const path = isAbsolute(target) ? target : join(task.cwd, target);
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, fillScenario(step.write.text, vars));
        yield { type: "tool", name: "Write", summary: target };
      } else if ("tool" in step) {
        yield { type: "tool", name: step.tool.name, summary: step.tool.summary };
      } else if ("ask" in step) {
        const answer = await ask({
          source: "agent",
          prompt: step.ask.question,
          options: step.ask.options.map((label) => ({ label })),
          multiSelect: step.ask.multiSelect,
        });
        const text = `answer: ${[...answer.choices, ...(answer.text ? [answer.text] : [])].join(", ")}`;
        said.push(text);
        yield { type: "text", text };
      } else {
        yield { type: "result", ok: false, text: step.fail };
        return;
      }
    }
    yield { type: "result", ok: true, text: said.join("\n") };
  }
}
