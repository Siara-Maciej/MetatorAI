import { MetatorError } from "@metator/core";
import { bootstrap, findRepoRoot } from "@metator/runtime";
import { Command, type CommanderError } from "commander";
import { registerChangedCommand } from "./commands/changed.ts";
import { describeCommands, registerMetaCommands } from "./commands/meta.ts";
import { registerRunCommands } from "./commands/run.ts";
import { registerWorkflowCommands } from "./commands/workflow.ts";
import type { CommandContext, Outcome } from "./context.ts";

export interface ProgramOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The commander program. Output is JSON-only: commander's own printing is disabled
 * (configureOutput) and its errors are thrown (exitOverride) and mapped to USAGE envelopes.
 * Settings are applied before subcommands are created, so every subcommand inherits them.
 */
export function buildProgram(onOutcome: (outcome: Outcome) => void, options: ProgramOptions = {}): Command {
  const program = new Command("metator")
    .description("MetatorAI: survey first, prove everything.")
    .option("-C, --root <dir>", "repository root (default: nearest ancestor with .git)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .helpCommand(false);

  const ctx: CommandContext = {
    container: () => {
      const root = (program.opts() as { root?: string }).root ?? findRepoRoot(options.cwd ?? process.cwd());
      const now = (options.env ?? process.env).METATOR_NOW;
      return bootstrap(now ? { root, now } : { root });
    },
    action:
      (handler) =>
      async (...args) => {
        onOutcome(await handler(...args));
      },
  };

  registerMetaCommands(program, ctx);
  registerChangedCommand(program, ctx);
  registerWorkflowCommands(program, ctx);
  registerRunCommands(program, ctx);
  return program;
}

export function fromCommander(e: CommanderError, program: Command): MetatorError {
  if (e.code === "commander.helpDisplayed" || e.code === "commander.help") {
    return new MetatorError("USAGE", "Use `metator help` for machine-readable help", {
      details: describeCommands(program),
    });
  }
  return MetatorError.usage(
    e.message.replace(/^error:\s*/, ""),
    "Run `metator help` to list commands and options.",
  );
}
