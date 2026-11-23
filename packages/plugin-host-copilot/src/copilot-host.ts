import type { HostDescriptor } from "@metator/core";
import { CopilotAgentHost } from "./copilot-agent-host.ts";
import { CopilotGenerator, copilotAgentFile } from "./copilot-generator.ts";
import { CopilotInteractiveHost } from "./copilot-interactive-host.ts";
import { CopilotSkillGenerator } from "./skill-generator.ts";

/** GitHub Copilot CLI as the composition root sees it: agents and sessions both run the `copilot` program. */
export const copilotHost: HostDescriptor = {
  id: "copilot",
  program: { env: "METATOR_COPILOT_BIN", default: "copilot" },
  agent: { runsProgram: true, host: (bin, guard, launch) => new CopilotAgentHost(bin, guard, launch) },
  interactive: (terminal, bin, guard) => new CopilotInteractiveHost(terminal, bin, process.env, guard),
  // In the sandbox (ADR-0104): Copilot's API (the plan's own host is under githubcopilot.com),
  // GitHub for sign-in and the account, and the folder Copilot CLI keeps its state in.
  sandbox: {
    domains: ["api.githubcopilot.com", "*.githubcopilot.com", "github.com", "api.github.com"],
    writable: ["~/.copilot"],
  },
  // The desktop app cannot install Copilot CLI: it shows these (ADR-0105). A login is a token in the
  // environment, or the users Copilot CLI records in ~/.copilot/config.json.
  setup: {
    install: {
      url: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
      command: "npm install -g @github/copilot",
    },
    login: "run copilot in a terminal, then type /login",
    credentials: {
      env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
      files: [{ path: ".copilot/config.json", key: "logged_in_users" }],
    },
  },
  files: {
    generator: () => new CopilotGenerator(),
    skills: () => new CopilotSkillGenerator(),
    agentFile: copilotAgentFile,
  },
};
