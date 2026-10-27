import { MetatorError } from "@metator/core";
import { bootstrap, findRepoRoot, loadConfig } from "@metator/runtime";
import { Command, type CommanderError } from "commander";
import { registerAdrCommands } from "./commands/adr.ts";
import { registerAgentCommands } from "./commands/agents.ts";
import { registerApiCommands } from "./commands/api.ts";
import { registerCardsCommands } from "./commands/cards.ts";
import { registerChangedCommand } from "./commands/changed.ts";
import { registerConfigCommands } from "./commands/config.ts";
import { registerCoverageCommands } from "./commands/coverage.ts";
import { registerDebugTagsCommands } from "./commands/debug-tags.ts";
import { registerDiscoverCommands } from "./commands/discover.ts";
import { registerDocsCommands } from "./commands/docs.ts";
import { registerEvalCommands } from "./commands/eval.ts";
import { registerFindingsCommands, registerReviewCommands } from "./commands/findings.ts";
import { registerFlakyCommands } from "./commands/flaky.ts";
import { registerGateCommands } from "./commands/gate.ts";
import { registerGraphCommands } from "./commands/graph.ts";
import { registerGuardCommands } from "./commands/guard.ts";
import { registerLessonsCommands } from "./commands/lessons.ts";
import { registerMemoryCommands } from "./commands/memory.ts";
import { describeCommands, registerMetaCommands } from "./commands/meta.ts";
import { registerOwnersCommand } from "./commands/owners.ts";
import { registerPatternsCommands } from "./commands/patterns.ts";
import { registerPlanCommands } from "./commands/plan.ts";
import { registerRulesCommands } from "./commands/rules.ts";
import { registerRunCommands } from "./commands/run.ts";
import { registerSetupCommands } from "./commands/setup.ts";
import { registerSystemCommands } from "./commands/system.ts";
import { registerTestCommands } from "./commands/test.ts";
import { registerWorkflowCommands } from "./commands/workflow.ts";
import { registerWorktreeCommands } from "./commands/worktree.ts";
import type { CommandContext, Outcome } from "./context.ts";

export interface ProgramOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: () => Promise<string>;
  /** How commands run other commands (set by run.ts, so the program does not import it). */
  readonly invoke?: CommandContext["invoke"];
  /** Asks a person in a terminal (main.ts sets it when stdin and stderr are TTYs). */
  readonly prompter?: CommandContext["prompter"];
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
      const env = options.env ?? process.env;
      // An invalid config stops every command with its exact field (thrown at the composition root).
      const config = loadConfig(root);
      if (config.isErr()) throw config.error;
      return bootstrap({
        root,
        config: config.value,
        ...(env.METATOR_NOW ? { now: env.METATOR_NOW } : {}),
        ...(env.METATOR_ROLE ? { role: env.METATOR_ROLE } : {}),
        ...(env.METATOR_CANON ? { canon: env.METATOR_CANON } : {}),
        ...(env.METATOR_AGENT_SCENARIO ? { agentScenario: env.METATOR_AGENT_SCENARIO } : {}),
        ...(env.METATOR_COPILOT_BIN ? { copilotBin: env.METATOR_COPILOT_BIN } : {}),
      });
    },
    stdin: options.stdin ?? (async () => ""),
    prompter: options.prompter ?? null,
    invoke:
      options.invoke ??
      (async () => {
        throw new Error("invoke is not available outside run()");
      }),
    action:
      (handler) =>
      async (...args) => {
        onOutcome(await handler(...args));
      },
  };

  registerMetaCommands(program, ctx);
  registerChangedCommand(program, ctx);
  registerGraphCommands(program, ctx);
  registerApiCommands(program, ctx);
  registerOwnersCommand(program, ctx);
  registerSystemCommands(program, ctx);
  registerRulesCommands(program, ctx);
  registerMemoryCommands(program, ctx);
  registerLessonsCommands(program, ctx);
  registerDocsCommands(program, ctx);
  registerCardsCommands(program, ctx);
  registerPatternsCommands(program, ctx);
  registerAdrCommands(program, ctx);
  registerDiscoverCommands(program, ctx);
  registerConfigCommands(program, ctx);
  registerSetupCommands(program, ctx);
  registerGateCommands(program, ctx);
  registerAgentCommands(program, ctx);
  registerFindingsCommands(program, ctx);
  registerReviewCommands(program, ctx);
  registerEvalCommands(program, ctx);
  registerPlanCommands(program, ctx);
  registerTestCommands(program, ctx);
  registerCoverageCommands(program, ctx);
  registerFlakyCommands(program, ctx);
  registerDebugTagsCommands(program, ctx);
  registerGuardCommands(program, ctx);
  registerWorkflowCommands(program, ctx);
  registerRunCommands(program, ctx);
  registerWorktreeCommands(program, ctx);
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
