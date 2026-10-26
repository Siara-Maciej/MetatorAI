import { MetatorError } from "@metator/core";
import { bootstrap, findRepoRoot, loadConfig } from "@metator/runtime";
import { Command, type CommanderError } from "commander";
import { registerAdrCommands } from "./commands/adr.ts";
import { registerAgentCommands } from "./commands/agents.ts";
import { registerCardsCommands } from "./commands/cards.ts";
import { registerChangedCommand } from "./commands/changed.ts";
import { registerConfigCommands } from "./commands/config.ts";
import { registerDiscoverCommands } from "./commands/discover.ts";
import { registerFindingsCommands, registerReviewCommands } from "./commands/findings.ts";
import { registerGateCommands } from "./commands/gate.ts";
import { registerGraphCommands } from "./commands/graph.ts";
import { registerMemoryCommands } from "./commands/memory.ts";
import { describeCommands, registerMetaCommands } from "./commands/meta.ts";
import { registerPatternsCommands } from "./commands/patterns.ts";
import { registerRulesCommands } from "./commands/rules.ts";
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
      // An invalid config stops every command with its exact field (thrown at the composition root).
      const config = loadConfig(root);
      if (config.isErr()) throw config.error;
      return bootstrap(now ? { root, now, config: config.value } : { root, config: config.value });
    },
    action:
      (handler) =>
      async (...args) => {
        onOutcome(await handler(...args));
      },
  };

  registerMetaCommands(program, ctx);
  registerChangedCommand(program, ctx);
  registerGraphCommands(program, ctx);
  registerRulesCommands(program, ctx);
  registerMemoryCommands(program, ctx);
  registerCardsCommands(program, ctx);
  registerPatternsCommands(program, ctx);
  registerAdrCommands(program, ctx);
  registerDiscoverCommands(program, ctx);
  registerConfigCommands(program, ctx);
  registerGateCommands(program, ctx);
  registerAgentCommands(program, ctx);
  registerFindingsCommands(program, ctx);
  registerReviewCommands(program, ctx);
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
