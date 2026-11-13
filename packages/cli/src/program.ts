import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MetatorError, parseYamlDocument, REPO_SET_FILE, RepoSetDocument, reposOf } from "@metator/core";
import {
  bootstrap,
  findChildRepos,
  findFolderRoot,
  findRepoRoot,
  loadConfig,
  machineStateDir,
  runsRootOf,
} from "@metator/runtime";
import { Command, type CommanderError } from "commander";
import { commandWords, metaOf } from "./command-meta.ts";
import { registerAdrCommands } from "./commands/adr.ts";
import { registerAgentCommands } from "./commands/agents.ts";
import { registerApiCommands } from "./commands/api.ts";
import { registerArchCommands } from "./commands/arch.ts";
import { registerAskCommands } from "./commands/ask.ts";
import { registerAttachCommand } from "./commands/attach.ts";
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
import { registerIntakeCommands } from "./commands/intake.ts";
import { registerIssueCommands } from "./commands/issue.ts";
import { registerLessonsCommands } from "./commands/lessons.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { registerMemoryCommands } from "./commands/memory.ts";
import { describeCommands, registerMetaCommands } from "./commands/meta.ts";
import { registerMrsCommands } from "./commands/mrs.ts";
import { registerOpenCommands } from "./commands/open.ts";
import { registerOwnersCommand } from "./commands/owners.ts";
import { registerPaneCommands } from "./commands/pane.ts";
import { registerPatternsCommands } from "./commands/patterns.ts";
import { registerPlanCommands } from "./commands/plan.ts";
import { registerReposCommands } from "./commands/repos.ts";
import { registerRulesCommands } from "./commands/rules.ts";
import { registerRunCommands } from "./commands/run.ts";
import { registerServeCommand } from "./commands/serve.ts";
import { registerSetupCommands } from "./commands/setup.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerSuperviseCommand } from "./commands/supervise.ts";
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
export function buildProgram(
  onOutcome: (outcome: Outcome, command?: Command) => void,
  options: ProgramOptions = {},
): Command {
  const program = new Command("metator")
    .description("MetatorAI: survey first, prove everything.")
    .option("-C, --root <dir>", "repository root (default: nearest ancestor with .git)")
    .option("--json", "at a terminal: only the JSON line, without the text a person reads", false)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .helpCommand(false);

  const env = options.env ?? process.env;
  const containerAt = (root: string, extra: { readonly run?: string } = {}) => {
    // An invalid config stops every command with its exact field (thrown at the composition root).
    // A run's worktree without a config of its own (one not committed yet) takes the checkout's.
    const own = loadConfig(root);
    const main = runsRootOf(root);
    const config = own.isOk() && own.value.source === undefined && main !== root ? loadConfig(main) : own;
    if (config.isErr()) throw config.error;
    return bootstrap({
      root,
      ...extra,
      config: config.value,
      ...(env.METATOR_NOW ? { now: env.METATOR_NOW } : {}),
      ...(env.METATOR_ROLE ? { role: env.METATOR_ROLE } : {}),
      ...(env.METATOR_CANON ? { canon: env.METATOR_CANON } : {}),
      ...(env.METATOR_AGENT_SCENARIO ? { agentScenario: env.METATOR_AGENT_SCENARIO } : {}),
      ...(env.METATOR_COPILOT_BIN ? { copilotBin: env.METATOR_COPILOT_BIN } : {}),
      ...(env.METATOR_CLAUDE_BIN ? { claudeBin: env.METATOR_CLAUDE_BIN } : {}),
      ...(env.METATOR_OPENCODE_BIN ? { opencodeBin: env.METATOR_OPENCODE_BIN } : {}),
      ...(env.METATOR_DOCKER_BIN ? { dockerBin: env.METATOR_DOCKER_BIN } : {}),
      stateDir: machineStateDir(env),
    });
  };
  const root = () => (program.opts() as { root?: string }).root;
  const start = () => root() ?? options.cwd ?? process.cwd();
  let folder: Folder | null | undefined;
  const folderOf = (): Folder | null => {
    folder ??= readFolder(start());
    return folder;
  };

  const ctx: CommandContext = {
    container: () => containerAt(findRepoRoot(start())),
    // In a run's worktree (`.metator/wt/<run id>`), runs live in the checkout and the run is its own.
    runs: () => {
      const root = findRepoRoot(start());
      const main = runsRootOf(root);
      return main === root ? containerAt(root) : containerAt(main, { run: basename(root) });
    },
    containerAt,
    root,
    start,
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
        // commander hands the command itself to an action as its last argument.
        const last = args.at(-1);
        onOutcome(await handler(...args), last instanceof Command ? last : undefined);
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
  registerServeCommand(program, ctx);
  registerPaneCommands(program, ctx);
  registerIssueCommands(program, ctx);
  registerIntakeCommands(program, ctx);
  registerMrsCommands(program, ctx);
  registerOpenCommands(program, ctx);
  registerAttachCommand(program, ctx);
  registerMcpCommand(program, ctx);
  registerSuperviseCommand(program, ctx);

  // In a folder of repositories only the commands that span repositories run (G2, ADR-0057).
  program.hook("preAction", (_root, action) => {
    const f = folderOf();
    if (!f || metaOf(action).folder) return;
    const name = commandWords(action);
    throw MetatorError.usage(
      `\`metator ${name}\` works on one repository, and ${f.root} is a folder of ${f.repos.length}`,
      `Run it inside a repository (${f.repos.map((r) => r.name).join(", ")}) or pass \`-C <repository>\`; here, \`metator ui\`, \`repos\`, \`ask\` and \`status\` cover them all.`,
    );
  });
  return program;
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
