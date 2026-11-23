import type { HostDescriptor } from "@metator/core";
import { ClaudeAgentHost } from "./claude-agent-host.ts";
import { ClaudeGenerator, claudeAgentFile } from "./claude-generator.ts";
import { ClaudeInteractiveHost } from "./claude-interactive-host.ts";
import { ClaudeSkillGenerator } from "./skill-generator.ts";

/**
 * The Claude Code program the Agent SDK runs instead of the one its platform package carries: a
 * compiled `metator` (the desktop app's, ADR-0105) ships no such package and names the person's
 * `claude` here.
 */
export const CLAUDE_EXECUTABLE_ENV = "METATOR_CLAUDE_EXECUTABLE";

/**
 * Claude Code as the composition root sees it. Agents run through the Agent SDK, so driving them
 * needs no `claude` program (from the desktop app they use the person's); the interactive session does.
 */
export const claudeHost: HostDescriptor = {
  id: "claude",
  program: { env: "METATOR_CLAUDE_BIN", default: "claude" },
  agent: {
    runsProgram: false,
    host: (_bin, _guard, launch) =>
      new ClaudeAgentHost(undefined, launch, process.env[CLAUDE_EXECUTABLE_ENV] || undefined),
  },
  interactive: (terminal, bin, guard) =>
    new ClaudeInteractiveHost(terminal, bin, process.env, undefined, guard),
  // In the sandbox (ADR-0104): the API, sign-in and token refresh, claude.ai's connectors
  // (code.claude.com/docs/en/network-config), and the files Claude Code keeps its state in.
  sandbox: {
    domains: ["api.anthropic.com", "claude.ai", "platform.claude.com", "mcp-proxy.anthropic.com"],
    writable: ["~/.claude", "~/.claude.json", "~/.config/claude", "~/.cache/claude", "~/.local/state/claude"],
  },
  // The desktop app cannot install Claude Code: it shows these (ADR-0105). A login is an API key or
  // token in the environment, the credentials file (Linux, Windows), or the account Claude Code
  // records in ~/.claude.json (also on macOS, where the token itself is in the keychain).
  setup: {
    install: {
      url: "https://code.claude.com/docs/en/setup",
      command: "npm install -g @anthropic-ai/claude-code",
    },
    login: "run claude in a terminal, then type /login",
    credentials: {
      env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      files: [{ path: ".claude/.credentials.json" }, { path: ".claude.json", key: "oauthAccount" }],
    },
  },
  files: {
    generator: () => new ClaudeGenerator(),
    skills: () => new ClaudeSkillGenerator(),
    agentFile: claudeAgentFile,
  },
};
