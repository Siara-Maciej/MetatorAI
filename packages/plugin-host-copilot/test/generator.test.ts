import { describe, expect, test } from "bun:test";
import { AgentDocument } from "@metator/core";
import { CopilotGenerator } from "../src/copilot-generator.ts";

const agent = (extra: Record<string, unknown>) =>
  AgentDocument.parse(
    {
      kind: "Agent",
      schemaVersion: 1,
      id: "mt-x",
      role: "worker",
      description: "Does one job, used by the coordinator only.",
      tier: "reasoning",
      capabilities: ["read", "search", "metator:graph"],
      ...extra,
    },
    "mt-x.md",
  )._unsafeUnwrap();

const BODY = "\n# Input\nRun `metator graph deps a.ts`.\n";

describe("CopilotGenerator", () => {
  test("snapshot of the generated worker (tool table, model, marker)", () => {
    const file = new CopilotGenerator().agent(agent({}), BODY, {
      source: "metator/agents/mt-x.md",
      metatorCommand: "bun run metator",
    });
    expect(file).toMatchSnapshot();
  });

  test("snapshot of a coordinator with every capability and a configured model", () => {
    const coordinator = agent({
      role: "coordinator",
      capabilities: ["read", "search", "edit", "execute", "agent", "todo", "web", "metator:run"],
      delegates: ["mt-a", "mt-b"],
    });
    const file = new CopilotGenerator().agent(coordinator, BODY, {
      source: "metator/agents/mt-x.md",
      metatorCommand: "metator",
      model: "model-x",
    });
    expect(file).toMatchSnapshot();
  });
});
