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

/** How a tool's typed fields become a command line: positionals in order, then flags. */
export interface ToolShape {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, "string" | "boolean" | "number" | "list">>;
}

/**
 * The tools an agent reaches for most, with typed fields besides the raw `args`, so a host shows
 * a form instead of a command line. Every other tool takes `args` alone.
 */
export const TYPED: Readonly<Record<string, ToolShape>> = {
  "graph affected": { positionals: [], flags: { base: "string", files: "list" } },
  "graph dependents": { positionals: ["file"], flags: { transitive: "boolean" } },
  "graph deps": { positionals: ["file"], flags: { transitive: "boolean" } },
  "graph path": { positionals: ["from", "to"], flags: {} },
  "graph callers": { positionals: ["symbol"], flags: { file: "string" } },
  "symbols find": { positionals: ["name"], flags: {} },
  "rules show": { positionals: ["id"], flags: {} },
  "rules pack": { positionals: [], flags: { paths: "list", base: "string", budget: "number" } },
  "run status": { positionals: [], flags: { run: "string" } },
  "pane read": { positionals: ["pane"], flags: { lines: "number" } },
};

export interface McpTool {
  /** `metator_graph_affected`: the command's words joined, as MCP names tools. */
  readonly name: string;
  /** The command's words (`graph affected`). */
  readonly command: string;
  readonly description: string;
  /** Typed fields, for the tools that have them. */
  readonly shape?: ToolShape;
}

/** A tool call's fields: typed ones per its shape, and `args` as on the command line. */
export type ToolInput = Readonly<Record<string, unknown>> & { readonly args?: readonly string[] };

/** The reading commands of the tree as tools, in the tree's order; a prefix in the list takes its whole group. */
export function mcpTools(program: Command): McpTool[] {
  return describeCommands(program)
    .commands.filter((c) => READING.some((r) => c.name === r || c.name.startsWith(`${r} `)))
    .map((c) => {
      const shape = TYPED[c.name];
      return {
        name: `metator_${c.name.replaceAll(" ", "_").replaceAll("-", "_")}`,
        command: c.name,
        description: `${c.summary}. Usage: ${c.usage}; ${shape ? "the typed fields are the command's own arguments and options; anything else goes" : "pass the command's own options and arguments"} in \`args\` (\`metator ${c.name} --help\` lists them). The result is MetatorAI's JSON envelope.`,
        ...(shape ? { shape } : {}),
      };
    });
}

/**
 * The command line a tool call amounts to: the tool's words, its typed positionals in order, its
 * typed flags (`--name value`, a bare `--name` for true, `--name a b` for a list), then `args`.
 */
export function toolArgv(tool: McpTool, input: ToolInput): string[] {
  const argv = tool.command.split(" ");
  for (const p of tool.shape?.positionals ?? []) {
    const v = input[p];
    if (v !== undefined && v !== null) argv.push(String(v));
  }
  for (const [flag, kind] of Object.entries(tool.shape?.flags ?? {})) {
    const v = input[flag];
    if (v === undefined || v === null) continue;
    if (kind === "boolean") {
      if (v === true) argv.push(`--${flag}`);
    } else if (kind === "list") argv.push(`--${flag}`, ...(Array.isArray(v) ? v.map(String) : [String(v)]));
    else argv.push(`--${flag}`, String(v));
  }
  return [...argv, ...(input.args ?? [])];
}
