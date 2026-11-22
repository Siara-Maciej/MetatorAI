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
  agent: { runsProgram: false, host: (_bin, _guard, launch) => new ClaudeAgentHost(undefined, launch) },
  interactive: (terminal, bin, guard) =>
    new ClaudeInteractiveHost(terminal, bin, process.env, undefined, guard),
  // In the sandbox (ADR-0104): the API, sign-in and token refresh, claude.ai's connectors
  // (code.claude.com/docs/en/network-config), and the files Claude Code keeps its state in.
  sandbox: {
    domains: ["api.anthropic.com", "claude.ai", "platform.claude.com", "mcp-proxy.anthropic.com"],
    writable: ["~/.claude", "~/.claude.json", "~/.config/claude", "~/.cache/claude", "~/.local/state/claude"],
  },
  files: {
    generator: () => new ClaudeGenerator(),
    skills: () => new ClaudeSkillGenerator(),
    agentFile: claudeAgentFile,
  },
};
