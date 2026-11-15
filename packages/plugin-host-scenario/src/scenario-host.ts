import type { AgentScenario, HostDescriptor } from "@metator/core";
import { ScenarioAgentHost } from "./scenario-agent-host.ts";
import { ScenarioInteractiveHost } from "./scenario-interactive-host.ts";

/**
 * The scenario host of a test: it plays `source` (a scenario or the path of its file) and runs no
 * program of its own, so it is always there.
 */
export function scenarioHost(source: AgentScenario | string): HostDescriptor {
  return {
    id: "scenario",
    agent: { runsProgram: false, host: () => new ScenarioAgentHost(source) },
    interactive: (terminal) => new ScenarioInteractiveHost(terminal, source),
  };
}
