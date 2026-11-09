import type { Command } from "commander";
import { describeCommands } from "./commands/meta.ts";

/**
 * The MCP server's tools (P8, ADR-0081): MetatorAI's reading commands, one tool each, so an
 * agent in any MCP host (an IDE, a chat, another agent) asks the repository the same questions
 * `metator` answers in a terminal. Nothing that writes, runs the project's scripts, drives a run
 * or talks to an AI host is a tool: those stay with the person and the run's own hooks.
 */
const READING: readonly string[] = [
  "version",
  "help",
  "changed",
  "graph",
  "workspace list",
  "symbols find",
  "api diff",
  "owners",
  "system show",
  "system lint",
  "system impact",
  "system sources",
  "system status",
  "system plan list",
  "system plan show",
  "system plan lint",
  "arch analyze",
  "arch check",
  "arch cycles",
  "arch declared",
  "arch plan list",
  "arch plan show",
  "arch plan lint",
  "arch plan status",
  "rules lint",
  "rules pack",
  "rules show",
  "rules check",
  "rules coverage",
  "memory inventory",
  "memory budget",
  "memory validate",
  "memory check",
  "memory dupes",
  "memory matrix",
  "docs inventory",
  "docs links",
  "docs drift",
  "similar",
  "adr lint",
  "config show",
  "findings check-quote",
  "review metadata",
  "review diff",
  "review plan",
  "plan lint",
  "plan scope",
  "debug-tags check",
  "workflow list",
  "workflow lint",
  "workflow validate",
  "run status",
  "run list",
  "run questions",
  "run activity",
  "run brief",
  "run published",
  "run messages",
  "run workers",
  "policy list",
  "worktree list",
  "worktree conflicts",
  "env status",
  "repos list",
  "repos status",
  "ask list",
  "status",
  "doctor",
  "inbox",
  "report",
  "pane list",
  "pane read",
];

export interface McpTool {
  /** `metator_graph_affected`: the command's words joined, as MCP names tools. */
  readonly name: string;
  /** The command's words (`graph affected`). */
  readonly command: string;
  readonly description: string;
}

/** The reading commands of the tree as tools, in the tree's order; a prefix in the list takes its whole group. */
export function mcpTools(program: Command): McpTool[] {
  return describeCommands(program)
    .commands.filter((c) => READING.some((r) => c.name === r || c.name.startsWith(`${r} `)))
    .map((c) => ({
      name: `metator_${c.name.replaceAll(" ", "_").replaceAll("-", "_")}`,
      command: c.name,
      description: `${c.summary}. Usage: ${c.usage}; pass the command's own options and arguments in \`args\` (\`metator ${c.name} --help\` lists them). The result is MetatorAI's JSON envelope.`,
    }));
}

/** The command line a tool call amounts to: the tool's words, then the caller's arguments. */
export function toolArgv(tool: McpTool, args: readonly string[]): string[] {
  return [...tool.command.split(" "), ...args];
}
