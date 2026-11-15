import type { HostDescriptor } from "@metator/core";
import { ClaudeAgentHost } from "./claude-agent-host.ts";
import { ClaudeGenerator, claudeAgentFile } from "./claude-generator.ts";
import { ClaudeInteractiveHost } from "./claude-interactive-host.ts";
import { ClaudeSkillGenerator } from "./skill-generator.ts";

/**
 * Claude Code as the composition root sees it. Agents run through the Agent SDK, so driving them
 * needs no `claude` program; the interactive session does.
 */
export const claudeHost: HostDescriptor = {
  id: "claude",
  program: { env: "METATOR_CLAUDE_BIN", default: "claude" },
  agent: { runsProgram: false, host: () => new ClaudeAgentHost() },
  interactive: (terminal, bin) => new ClaudeInteractiveHost(terminal, bin),
  files: {
    generator: () => new ClaudeGenerator(),
    skills: () => new ClaudeSkillGenerator(),
    agentFile: claudeAgentFile,
  },
};
