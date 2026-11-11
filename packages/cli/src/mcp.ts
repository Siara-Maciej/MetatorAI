import { err, MetatorError, ok, type Result } from "@metator/core";
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
  "issue list",
  "issue show",
  "docs drift",
  "similar",
  "adr lint",
  "config show",
  "findings check-quote",
  "review metadata",
  "review diff",
  "review plan",
  "plan lint",
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

/**
 * The options of a reading command that write a file, change files, clone a repository or send a
 * message: a tool call that carries one is refused, so a tool marked read-only stays read-only.
 */
export const REFUSED: Readonly<Record<string, readonly string[]>> = {
  "system lint": ["--fetch"],
  "system sources": ["--fetch"],
  "arch check": ["--sarif"],
  "memory validate": ["--fix"],
  "docs drift": ["--fix"],
  "review metadata": ["--out"],
  "review diff": ["--out"],
  "review plan": ["--out"],
  "worktree conflicts": ["--notify"],
  report: ["--html"],
};

/** Options a tool always passes, so the command leaves no trace (`run brief` marks the run as read). */
export const ALWAYS: Readonly<Record<string, readonly string[]>> = {
  "run brief": ["--peek"],
};

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
      const refused = REFUSED[c.name];
      return {
        name: `metator_${c.name.replaceAll(" ", "_").replaceAll("-", "_")}`,
        command: c.name,
        description: `${c.summary}. Usage: ${c.usage}; ${shape ? "the typed fields are the command's own arguments and options; anything else goes" : "pass the command's own options and arguments"} in \`args\` (\`metator ${c.name} --help\` lists them). The result is MetatorAI's JSON envelope.${refused ? ` The tool only reads: ${refused.join(", ")} is refused.` : ""}`,
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
  const always = (ALWAYS[tool.command] ?? []).filter((f) => !(input.args ?? []).includes(f));
  return [...argv, ...always, ...(input.args ?? [])];
}

/**
 * The command line of a tool call, or USAGE naming the option when the call carries one that
 * writes (`--out f`, `--out=f`). Words after `--` are arguments, not options.
 */
export function toolCall(tool: McpTool, input: ToolInput): Result<string[], MetatorError> {
  const argv = toolArgv(tool, input);
  const end = argv.indexOf("--");
  const options = (end === -1 ? argv : argv.slice(0, end)).map((a) => a.split("=")[0] as string);
  const refused = (REFUSED[tool.command] ?? []).find((f) => options.includes(f));
  if (refused)
    return err(
      MetatorError.usage(
        `the tool ${tool.name} only reads: ${refused} is refused`,
        `Run \`metator ${tool.command} ${refused}\` in a terminal instead.`,
      ),
    );
  return ok(argv);
}
