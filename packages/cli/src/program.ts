import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MetatorError, parseYamlDocument, REPO_SET_FILE, RepoSetDocument, reposOf } from "@metator/core";
import {
  bootstrap,
  findChildRepos,
  findFolderRoot,
  findRepoRoot,
  loadConfig,
  machineStateDir,
} from "@metator/runtime";
import { Command, type CommanderError } from "commander";
import { registerAdrCommands } from "./commands/adr.ts";
import { registerAgentCommands } from "./commands/agents.ts";
import { registerApiCommands } from "./commands/api.ts";
import { registerArchCommands } from "./commands/arch.ts";
import { registerAskCommands } from "./commands/ask.ts";
import { registerCardsCommands } from "./commands/cards.ts";
import { registerChangedCommand } from "./commands/changed.ts";
import { registerConfigCommands } from "./commands/config.ts";
import { registerContractCommands } from "./commands/contract.ts";
import { registerCoverageCommands } from "./commands/coverage.ts";
import { registerDebugTagsCommands } from "./commands/debug-tags.ts";
import { registerDiscoverCommands } from "./commands/discover.ts";
import { registerDocsCommands } from "./commands/docs.ts";
import { registerEnvCommands } from "./commands/env.ts";
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
import { registerReposCommands } from "./commands/repos.ts";
import { registerRulesCommands } from "./commands/rules.ts";
import { registerRunCommands } from "./commands/run.ts";
import { registerSetupCommands } from "./commands/setup.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerSystemCommands } from "./commands/system.ts";
import { registerTestCommands } from "./commands/test.ts";
import { registerUiCommands } from "./commands/ui.ts";
import { registerWorkflowCommands } from "./commands/workflow.ts";
import { registerWorktreeCommands } from "./commands/worktree.ts";
import type { CommandContext, Folder, Outcome } from "./context.ts";

export interface ProgramOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: () => Promise<string>;
  /** How commands run other commands (set by run.ts, so the program does not import it). */
  readonly invoke?: CommandContext["invoke"];
  /** The person at a terminal (main.ts sets it when stdin and stderr are TTYs). */
  readonly terminal?: CommandContext["terminal"];
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

  const env = options.env ?? process.env;
  const containerAt = (root: string) => {
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
      ...(env.METATOR_DOCKER_BIN ? { dockerBin: env.METATOR_DOCKER_BIN } : {}),
      stateDir: machineStateDir(env),
    });
  };
  const start = () => (program.opts() as { root?: string }).root ?? options.cwd ?? process.cwd();
  let folder: Folder | null | undefined;
  const folderOf = (): Folder | null => {
    folder ??= readFolder(start());
    return folder;
  };

  const ctx: CommandContext = {
    container: () => containerAt(findRepoRoot(start())),
    containerAt,
    folder: folderOf,
    stdin: options.stdin ?? (async () => ""),
    terminal: options.terminal ?? null,
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
  registerContractCommands(program, ctx);
  registerArchCommands(program, ctx);
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
  registerEnvCommands(program, ctx);
  registerUiCommands(program, ctx);
  registerReposCommands(program, ctx);
  registerAskCommands(program, ctx);
  registerStatusCommand(program, ctx);

  // In a folder of repositories only the commands that span repositories run (G2, ADR-0057).
  program.hook("preAction", (_root, action) => {
    const f = folderOf();
    const name = commandName(action);
    if (!f || FOLDER_COMMANDS.has(name)) return;
    throw MetatorError.usage(
      `\`metator ${name}\` works on one repository, and ${f.root} is a folder of ${f.repos.length}`,
      `Run it inside a repository (${f.repos.map((r) => r.name).join(", ")}) or pass \`-C <repository>\`; here, \`metator ui\`, \`repos\`, \`ask\` and \`status\` cover them all.`,
    );
  });
  return program;
}

/** Commands that run in a folder of repositories and cover all of them. */
export const FOLDER_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "version",
  "repos init",
  "repos list",
  "repos status",
  "system discover",
  "ui",
  "ask",
  "ask list",
  "status",
]);

function commandName(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(" ");
}

/** The folder `start` is in, with its repositories from `metator.repos.yml` or found below it. */
function readFolder(start: string): Folder | null {
  const root = findFolderRoot(start);
  if (!root) return null;
  const file = join(root, REPO_SET_FILE);
  if (!existsSync(file)) {
    const repos = findChildRepos(root).map((path) => ({
      name: path.split("/").pop() ?? path,
      path,
      root: join(root, path),
    }));
    return { root, repos, file: null };
  }
  const set = parseYamlDocument(readFileSync(file, "utf8"), REPO_SET_FILE).andThen((raw) =>
    RepoSetDocument.parse(raw, REPO_SET_FILE),
  );
  if (set.isErr()) throw set.error;
  const { repos, problems } = reposOf(set.value);
  if (problems.length > 0)
    throw new MetatorError("INVALID_CONFIG", `${REPO_SET_FILE}: ${problems.join("; ")}`);
  return { root, repos: repos.map((r) => ({ ...r, root: join(root, r.path) })), file };
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
