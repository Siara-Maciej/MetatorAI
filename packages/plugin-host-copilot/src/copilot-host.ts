import type { HostDescriptor } from "@metator/core";
import { CopilotAgentHost } from "./copilot-agent-host.ts";
import { CopilotGenerator, copilotAgentFile } from "./copilot-generator.ts";
import { CopilotInteractiveHost } from "./copilot-interactive-host.ts";
import { CopilotSkillGenerator } from "./skill-generator.ts";

/** GitHub Copilot CLI as the composition root sees it: agents and sessions both run the `copilot` program. */
export const copilotHost: HostDescriptor = {
  id: "copilot",
  program: { env: "METATOR_COPILOT_BIN", default: "copilot" },
  agent: { runsProgram: true, host: (bin, guard) => new CopilotAgentHost(bin, guard) },
  interactive: (terminal, bin, guard) => new CopilotInteractiveHost(terminal, bin, process.env, guard),
  files: {
    generator: () => new CopilotGenerator(),
    skills: () => new CopilotSkillGenerator(),
    agentFile: copilotAgentFile,
  },
};
