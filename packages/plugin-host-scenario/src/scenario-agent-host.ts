import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
  AgentAnswer,
  AgentEvent,
  AgentHost,
  AgentQuestion,
  AgentScenario,
  AgentTask,
} from "@metator/core";
import { fillScenario } from "@metator/core";
import { ScenarioPlayer } from "./scenario-player.ts";

/**
 * AgentHost that plays a scenario (ADR-0051): no model, the same events a real host emits.
 * Each start of an agent takes the agent's next entry; the last entry repeats.
 */
export class ScenarioAgentHost implements AgentHost {
  readonly id = "scenario";
  private readonly player: ScenarioPlayer;

  /** A scenario, or the path of an AgentScenario file read at the first start. */
  constructor(source: AgentScenario | string) {
    this.player = new ScenarioPlayer(source);
  }

  async *run(task: AgentTask, ask: (q: AgentQuestion) => Promise<AgentAnswer>): AsyncIterable<AgentEvent> {
    // Continuing a session of this agent (a new process, e.g. `ask --continue`) plays the entry after it.
    const resumed = task.resume?.match(new RegExp(`^scenario-${task.agent}-(\\d+)$`))?.[1];
    const turn = await this.player.next(task.agent, resumed ? Number(resumed) : 0);
    if (turn.isErr()) {
      yield { type: "result", ok: false, text: turn.error.message };
      return;
    }
    if (!turn.value) {
      yield { type: "result", ok: false, text: `the scenario has no entry for ${task.agent}` };
      return;
    }
    const { steps, sessionId } = turn.value;
    yield { type: "session", id: sessionId };
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
