import { ok } from "@metator/core";
import type { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import type { CommandContext } from "../context.ts";

export interface CommandInfo {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
}

/** Machine-readable help built from commander's own command tree (single source of truth). */
export function describeCommands(program: Command): { commands: CommandInfo[] } {
  const commands: CommandInfo[] = [];
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      const name = `${prefix}${sub.name()}`;
      // A group is listed itself only when it also runs on its own (`metator run`, `metator ask`).
      const runsItself = (sub as unknown as { _actionHandler?: unknown })._actionHandler != null;
      if (sub.commands.length === 0 || runsItself)
        commands.push({ name, summary: sub.description(), usage: `metator ${name} ${sub.usage()}`.trim() });
      if (sub.commands.length > 0) walk(sub, `${name} `);
    }
  };
  walk(program, "");
  return { commands };
}

export interface CommandHelp extends CommandInfo {
  readonly options: { readonly flags: string; readonly description: string; readonly default?: unknown }[];
  readonly commands?: CommandInfo[];
}

/**
 * `metator <command> --help`: the command the words before the flag name, with its options (and
 * the commands of a group). `--help` with no command, or after `--`, is the whole list.
 */
export function describeCommandFor(program: Command, argv: readonly string[]): CommandHelp | undefined {
  const end = argv.indexOf("--");
  const words = end === -1 ? argv : argv.slice(0, end);
  if (!words.some((a) => a === "--help" || a === "-h")) return undefined;
  let cmd = program;
  const path: string[] = [];
  for (const word of words) {
    const sub = cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (!sub) break;
    cmd = sub;
    path.push(sub.name());
  }
  if (path.length === 0) return undefined;
  const name = path.join(" ");
  const commands = cmd.commands.length > 0 ? describeCommands(cmd).commands : undefined;
  return {
    name,
    summary: cmd.description(),
    usage: `metator ${name} ${cmd.usage()}`.trim(),
    options: cmd.options.map((o) => ({
      flags: o.flags,
      description: o.description,
      ...(o.defaultValue !== undefined ? { default: o.defaultValue } : {}),
    })),
    ...(commands ? { commands: commands.map((c) => ({ ...c, name: `${name} ${c.name}` })) } : {}),
  };
}

export function registerMetaCommands(program: Command, { action }: CommandContext): void {
  program
    .command("version")
    .description("Print the MetatorAI version")
    .action(action(() => ({ result: ok({ name: "metator-ai", version: pkg.version }) })));

  program
    .command("help")
    .description("List available commands")
    .action(action(() => ({ result: ok(describeCommands(program)) })));
}
