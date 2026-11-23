import { err, MetatorError, ok, type Result } from "@metator/core";
import type { Command } from "commander";
import { everyCommand, metaOf, reads } from "./command-meta.ts";
import { describeCommands } from "./commands/meta.ts";

/**
 * The MCP server's tools (P8, ADR-0081): MetatorAI's reading commands, one tool each, so an
 * agent in any MCP host (an IDE, a chat, another agent) asks the repository the same questions
 * `metator` answers in a terminal. Nothing that writes, runs the project's scripts, drives a run
 * or talks to an AI host is a tool: those stay with the person and the run's own hooks.
 *
 * Which commands read is what each says of itself where it is registered (`meta(cmd, { reads })`,
 * a group for all of its commands); nothing is a tool unless it says so.
 * This is not core's `METATOR_QUERIES` (what an agent's shell may run without asking): that list
 * answers another question and is kept apart on purpose; `test/command-meta.test.ts` pins where
 * the two differ.
 */
const tagged = (program: Command, key: "writesWith" | "readsWith"): Record<string, readonly string[]> =>
  Object.fromEntries(
    everyCommand(program)
      .filter((c) => !c.meta.renamedFrom)
      .flatMap((c) => (c.meta[key] ? [[c.name, c.meta[key]] as const] : [])),
  );

/**
 * The options of a reading command that write a file, change files, clone a repository, send a
 * message or run the project's scripts (`writesWith`): a tool call that carries one is refused,
 * so a tool marked read-only stays read-only.
 */
export const refusedOptions = (program: Command) => tagged(program, "writesWith");

/**
 * Options a tool always passes (`readsWith`), so the command leaves no trace (`run brief` marks
 * the run as read, `plan scope` writes plan-scope.json).
 */
export const alwaysOptions = (program: Command) => tagged(program, "readsWith");

/** How a tool's typed fields become a command line: positionals in order, then flags. */
export interface ToolShape {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, "string" | "boolean" | "number" | "list">>;
}

/**
 * The typed fields of a tool, from the command itself: its required arguments in order, and its
 * options (a flag is a boolean, `<values...>` a list, one with a parser a number unless it is one
 * of a few words, any other a string). An option the tool refuses (`writesWith`) or always passes (`readsWith`) is no field.
 */
export function toolShape(cmd: Command): ToolShape {
  const { writesWith = [], readsWith = [] } = metaOf(cmd);
  const flags: Record<string, "string" | "boolean" | "number" | "list"> = {};
  for (const o of cmd.options) {
    if (o.hidden || !o.long || writesWith.includes(o.long) || readsWith.includes(o.long)) continue;
    flags[o.attributeName()] = o.isBoolean()
      ? "boolean"
      : o.variadic
        ? "list"
        : // One of a few words (`.choices()`) has a parser too, but it is a string.
          (o.parseArg && !o.argChoices) || typeof o.defaultValue === "number"
          ? "number"
          : "string";
  }
  return {
    positionals: cmd.registeredArguments.filter((a) => a.required).map((a) => a.name()),
    flags,
  };
}

/**
 * The tools an agent reaches for most (`typed` where they are registered), with typed fields
 * besides the raw `args`, so a host shows a form instead of a command line. Every other tool
 * takes `args` alone.
 */
export const typedShapes = (program: Command): Record<string, ToolShape> =>
  Object.fromEntries(
    everyCommand(program)
      .filter((c) => c.meta.typed && !c.meta.renamedFrom)
      .map((c) => [c.name, toolShape(c.cmd)]),
  );

export interface McpTool {
  /** `metator_graph_affected`: the command's words joined, as MCP names tools. */
  readonly name: string;
  /** The command's words (`graph affected`). */
  readonly command: string;
  readonly description: string;
  /** Typed fields, for the tools that have them. */
  readonly shape?: ToolShape;
  /** Options a call may not carry: they write. */
  readonly refused?: readonly string[];
  /** Options every call carries, so the command leaves no trace. */
  readonly always?: readonly string[];
}

/** A tool call's fields: typed ones per its shape, and `args` as on the command line. */
export type ToolInput = Readonly<Record<string, unknown>> & { readonly args?: readonly string[] };

/**
 * The reading commands of the tree as tools, in the tree's order. A tool keeps the name it has:
 * a renamed command is a tool under its old words, never twice.
 */
export function mcpTools(program: Command): McpTool[] {
  const said = new Map(everyCommand(program).map((c) => [c.name, c]));
  return describeCommands(program, { renamed: true })
    .commands.filter((c) => {
      const cmd = said.get(c.name);
      return cmd !== undefined && reads(cmd.cmd) && !cmd.meta.renamedFrom;
    })
    .map((c) => {
      const shape = said.get(c.name)?.meta.typed ? toolShape(said.get(c.name)?.cmd as Command) : undefined;
      const { writesWith: refused, readsWith: always } = said.get(c.name)?.meta ?? {};
      return {
        name: `metator_${c.name.replaceAll(" ", "_").replaceAll("-", "_")}`,
        command: c.name,
        description: `${c.summary}. Usage: ${c.usage}; ${shape ? "the typed fields are the command's own arguments and options; anything else goes" : "pass the command's own options and arguments"} in \`args\` (\`metator ${c.name} --help\` lists them). The result is MetatorAI's JSON envelope.${refused ? ` The tool only reads: ${refused.join(", ")} is refused.` : ""}`,
        ...(shape ? { shape } : {}),
        ...(refused ? { refused } : {}),
        ...(always ? { always } : {}),
      };
    });
}

/** Typed fields under the name they had before a flag was renamed: a caller that still sends one is heard. */
export const RENAMED_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "rules pack": { files: "paths" },
};

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
    const old = RENAMED_FIELDS[tool.command]?.[flag];
    const v = input[flag] ?? (old ? input[old] : undefined);
    if (v === undefined || v === null) continue;
    if (kind === "boolean") {
      if (v === true) argv.push(`--${flag}`);
    } else if (kind === "list") argv.push(`--${flag}`, ...(Array.isArray(v) ? v.map(String) : [String(v)]));
    else argv.push(`--${flag}`, String(v));
  }
  const always = (tool.always ?? []).filter((f) => !(input.args ?? []).includes(f));
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
  const refused = (tool.refused ?? []).find((f) => options.includes(f));
  if (refused)
    return err(
      MetatorError.usage(
        `the tool ${tool.name} only reads: ${refused} is refused`,
        `Run \`metator ${tool.command} ${refused}\` in a terminal instead.`,
      ),
    );
  return ok(argv);
}
