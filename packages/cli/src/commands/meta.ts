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
      if (sub.commands.length > 0) walk(sub, `${name} `);
      else
        commands.push({ name, summary: sub.description(), usage: `metator ${name} ${sub.usage()}`.trim() });
    }
  };
  walk(program, "");
  return { commands };
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
