import { describe, expect, test } from "bun:test";
import type { AgentAnswer, AgentEvent, AgentHost, AgentQuestion, AgentTask } from "@metator/core";

export interface AgentHostWorld {
  readonly host: AgentHost;
  /** A task the host completes successfully (its agent says something). */
  readonly task: AgentTask;
}

export async function collect(
  host: AgentHost,
  task: AgentTask,
  ask: (q: AgentQuestion) => Promise<AgentAnswer> = async () => ({ choices: [] }),
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of host.run(task, ask)) out.push(e);
  return out;
}

/** Every AgentHost adapter must pass this suite: the drive relies on the order of events. */
export function agentHostContract(name: string, make: () => Promise<AgentHostWorld>): void {
  describe(`AgentHost contract: ${name}`, () => {
    test("the session comes first and exactly one result comes last", async () => {
      const { host, task } = await make();
      const events = await collect(host, task);
      expect(events[0]?.type).toBe("session");
      expect(events.filter((e) => e.type === "result").length).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "result", ok: true });
    });

    test("the agent's words arrive as text events", async () => {
      const { host, task } = await make();
      const events = await collect(host, task);
      expect(events.some((e) => e.type === "text" && e.text.length > 0)).toBe(true);
    });
  });
}
