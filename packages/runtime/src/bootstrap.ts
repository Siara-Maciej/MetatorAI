import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AddLesson,
  AdvanceRun,
  AgentCatalog,
  type AgentHost,
  AnalyzeArchitecture,
  AnalyzeEnvironment,
  AnalyzeSystem,
  AnswerPolicyStore,
  ApiSnapshots,
  ApproveRefactorPlan,
  ApproveRun,
  ApproveSystemPlan,
  ArchitectureBaselineStore,
  ArchitectureFacts,
  ArchitecturePolicyCatalog,
  AskQuestion,
  AuditAgents,
  BaseArchitectureFacts,
  BuildImportGraph,
  BuildModuleCards,
  BuildReport,
  CalibrateFinding,
  CheckArchitecture,
  CheckDebugTags,
  CheckFlaky,
  CheckMemory,
  CheckPublished,
  CheckpointRun,
  CheckQuote,
  CheckReadiness,
  CheckRules,
  type Clock,
  CloneCache,
  CloseRun,
  CompareEvals,
  ComputeAffected,
  Conductor,
  ConversationRepository,
  CreateRefactorPlan,
  CreateSystemPlan,
  CreateWorktree,
  DEFAULT_CONFIG,
  DEFAULT_SOURCE_IGNORES,
  DEFAULT_TEST_GLOBS,
  DescribeReviewedChange,
  DiffContracts,
  DiffCoverage,
  DiffImportGraph,
  Discover,
  DiscoverEnvironment,
  DiscoverSystem,
  DocsDrift,
  DocsInventory,
  DocsLinks,
  DriveRun,
  DriverLock,
  declaresDependencies,
  EnvironmentCatalog,
  EnvironmentServices,
  EvalCatalog,
  err,
  type FileSystem,
  FindMemoryDupes,
  FindOwners,
  FindSimilar,
  FormatReviewComments,
  GateChecks,
  GenerateHosts,
  GenerateRuleAdapters,
  GenerateSkills,
  GetRunStatus,
  GraphQueries,
  GuardPostEdit,
  GuardPreTool,
  GuardSessionStart,
  GuardStop,
  GuardSubagentOutput,
  HandoffRun,
  HostManifestCatalog,
  HostPrompts,
  IndexedImportGraphReader,
  InitArchitecturePolicy,
  InitEnvironment,
  InitProject,
  InitRun,
  InstallCanon,
  type InteractiveHost,
  InventoryMemory,
  Issues,
  JudgeFindings,
  KnowledgeFiles,
  LayoutStore,
  LintAdrs,
  LintAgents,
  LintPlan,
  LintRefactorPlan,
  LintRules,
  LintSkills,
  LintSystem,
  LintSystemPlan,
  LintWorkflows,
  ListRuns,
  ListWorktrees,
  LocalSystemLocation,
  MachineLeases,
  MeasureRuleCoverage,
  MemoryBudget,
  MemoryMapReader,
  MergeFindingSets,
  MetatorError,
  type MetatorPaths,
  MyReviews,
  Notifier,
  OpenEditor,
  OptionStore,
  ok,
  PackRules,
  PaneSensor,
  Panes,
  PatternCatalog,
  PinnedSystemLocation,
  PlanBoard,
  PlannedBreakingChanges,
  PlanReview,
  type ProcessRunner,
  ProposeRefactorPlan,
  ProposeSystemPlan,
  ProvideWorktree,
  PruneWorktrees,
  PtyBroker,
  RecordArchitectureBaseline,
  RefactorPlanStore,
  RemoveWorktree,
  RenderReport,
  RepositoryDiscoverySource,
  type RepositoryRuns,
  type Result,
  ResumeRun,
  ReviewFeedback,
  ReviewNotes,
  RuleCatalog,
  RunAffectedTests,
  RunArchEvals,
  RunChanges,
  RunDrivers,
  RunEvals,
  RunGate,
  RunJournal,
  RunMessages,
  RunQuarterlyReview,
  RunRefactorPlan,
  RunRepository,
  RunSystemEvals,
  RunSystemPlan,
  ScaffoldRule,
  ScanIntake,
  ScanPatterns,
  ScopePlan,
  ScoreEvals,
  SeedGoldenSet,
  SetupWorktree,
  ShowChangeDiff,
  ShowSystem,
  SimulateArchitecture,
  SimulateRefactorPlan,
  SkillCatalog,
  SourceFiles,
  StyleImports,
  Supervisor,
  type SupervisorDependencies,
  SymbolQueries,
  SyncRefactorPlan,
  SystemCatalog,
  SystemImpactQuery,
  SystemPlanStatus,
  SystemPlanStore,
  SystemSources,
  UpdateConfig,
  ValidateCitations,
  ValidateFindings,
  WarmPool,
  WorkflowCatalog,
  WorkOverview,
  type WorkspacePackage,
  WorktreeConflicts,
  WorktreeRegistry,
  WriteRunArtifact,
} from "@metator/core";
import {
  BunBackgroundProcess,
  BunCheckoutReader,
  BunFileLock,
  BunFileSystem,
  BunLauncher,
  BunMachineState,
  BunProcessRunner,
  BunSqlDataIsolator,
  BunTestEngine,
  BunTimer,
  NodeBinResolver,
  NodeTreeCopier,
  TempGitSandbox,
} from "@metator/plugin-bun";

export { findChildRepos, findFolderRoot, findRepoRoot, runsRootOf } from "@metator/plugin-bun";

import { AstGrepEngine, AstGrepScaffolder } from "@metator/plugin-astgrep";
import { BiomeEngine } from "@metator/plugin-biome";
import { McpCodeHost, McpReviewHost, SdkToolCaller } from "@metator/plugin-codehost-mcp";
import { DockerComposeRuntime } from "@metator/plugin-docker";
import { excludeLocally, GitRepositoryCloner, GitVcs, GitWorktreeManager } from "@metator/plugin-git";
import {
  ClaudeAgentHost,
  ClaudeGenerator,
  ClaudeInteractiveHost,
  ClaudeSkillGenerator,
} from "@metator/plugin-host-claude";
import {
  CopilotAgentHost,
  CopilotGenerator,
  CopilotInteractiveHost,
  CopilotSkillGenerator,
} from "@metator/plugin-host-copilot";
import { OpencodeInteractiveHost } from "@metator/plugin-host-opencode";
import { ScenarioAgentHost, ScenarioInteractiveHost } from "@metator/plugin-host-scenario";
import {
  GetPortProbe,
  JsonToolBoundariesReader,
  LcovCoverageReader,
  ManypkgManifestReader,
  ManypkgWorkspaceReader,
  NodePackageManager,
  NodePtyTerminal,
  WaitOnHealthProbe,
} from "@metator/plugin-node";
import { OpenApiContractDetector, OpenApiContractDiffer } from "@metator/plugin-openapi";
import { OxcImportAnalyzer, TscDeclarationEmitter, TscEngine } from "@metator/plugin-typescript";
import { asFunction, asValue } from "awilix";
import { resolveCanon } from "./canon.ts";
import { type LoadedConfig, loadConfig, resolvePaths } from "./config.ts";
import { createMetatorContainer, type MetatorContainer } from "./container.ts";

/** Where a repository's local state lives (the defaults of `paths` are all under it). */
const LOCAL_STATE_DIR = ".metator";

export interface BootstrapOptions {
  readonly root: string;
  /** The repository's config (`loadConfig`); defaults when omitted. */
  readonly config?: LoadedConfig;
  readonly paths?: MetatorPaths;
  /** ISO timestamp pinning the clock (METATOR_NOW): reproducible run ids and logs. */
  readonly now?: string;
  /** The run this process works for (in a run's worktree): the default of every `run` command. */
  readonly run?: string;
  /** The calling agent's role (METATOR_ROLE), for hooks that cannot tell from the payload. */
  readonly role?: string;
  /** Where the shipped agent canon is read from (METATOR_CANON); default: this installation. */
  readonly canon?: string;
  /** The AgentScenario file the scenario host plays (METATOR_AGENT_SCENARIO). */
  readonly agentScenario?: string;
  /** The Copilot CLI binary (METATOR_COPILOT_BIN); default `copilot` on PATH. */
  readonly copilotBin?: string;
  /** The Claude Code binary (METATOR_CLAUDE_BIN); default `claude` on PATH. */
  readonly claudeBin?: string;
  /** The OpenCode binary (METATOR_OPENCODE_BIN); default `opencode` on PATH. */
  readonly opencodeBin?: string;
  /** The Docker CLI (METATOR_DOCKER_BIN); default `docker` on PATH. */
  readonly dockerBin?: string;
  /** Machine-wide state shared by every repository (`machineStateDir`); default from the process env. */
  readonly stateDir?: string;
  /** The person's own MetatorAI files (`userConfigDir`); default from the process env. */
  readonly userConfigDir?: string;
}

/**
 * Where state shared by every repository on this machine lives (G1): `$METATOR_STATE_DIR`, else
 * `$XDG_STATE_HOME/metator`, else `~/.local/state/metator`.
 */
export function machineStateDir(env: Readonly<Record<string, string | undefined>>): string {
  if (env.METATOR_STATE_DIR) return env.METATOR_STATE_DIR;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, "metator");
  return join(env.HOME ?? homedir(), ".local", "state", "metator");
}

/**
 * Where a person's own MetatorAI files live (S1): `$METATOR_CONFIG_DIR`, else
 * `$XDG_CONFIG_HOME/metator`, else `~/.config/metator`.
 */
export function userConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  if (env.METATOR_CONFIG_DIR) return env.METATOR_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "metator");
  return join(env.HOME ?? homedir(), ".config", "metator");
}

/** The interactive hosts in the configured order (`supervisor.hostOrder`); the ones it does not name last. */
export function orderedHosts<H extends { readonly id: string }>(
  order: readonly string[],
  hosts: readonly H[],
): H[] {
  const rank = (h: H) => {
    const i = order.indexOf(h.id);
    return i < 0 ? order.length : i;
  };
  return [...hosts].sort((a, b) => rank(a) - rank(b));
}

const systemClock: Clock = { now: () => new Date() };
/** `.metator/` is MetatorAI's own state: never a change, even before setup gitignores it. */
const OWN_STATE: readonly string[] = [".metator/"];

/** The host files of shipped agents in this repository (as `agents install` writes them), for sandboxes. */
async function agentDefinitionFiles(fs: FileSystem, ids: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids)
    for (const file of [`.claude/agents/${id}.md`, `.github/agents/${id}.agent.md`]) {
      const text = await fs.read(file);
      if (text.isOk()) out[file] = text.value;
    }
  return out;
}

/**
 * Composition root: the only place that knows concrete adapters. Use cases keep plain
 * constructors (framework-agnostic); awilix wires them through factories.
 */
export function bootstrap(options: BootstrapOptions): MetatorContainer {
  const c = createMetatorContainer();
  /** The container of another repository root, with that repository's own config. */
  const elsewhere = (root: string): MetatorContainer => {
    const config = loadConfig(root);
    if (config.isErr()) throw config.error;
    const { paths: _here, ...shared } = options;
    return bootstrap({ ...shared, root, config: config.value });
  };
  const pinned = options.now ? new Date(options.now) : undefined;
  const config = options.config ?? { config: DEFAULT_CONFIG, source: undefined };
  c.register({
    root: asValue(options.root),
    role: asValue(options.role),
    config: asValue(config),
    paths: asValue(options.paths ?? resolvePaths(config.config)),
    sourceIgnores: asValue(config.config.project.sourceIgnores ?? DEFAULT_SOURCE_IGNORES),
    testGlobs: asValue(config.config.project.testGlobs ?? DEFAULT_TEST_GLOBS),
    clock: asValue(pinned && !Number.isNaN(pinned.getTime()) ? { now: () => new Date(pinned) } : systemClock),
    // Local state appears with the first command that writes it (an index, a report), setup or
    // not: it stays out of `git status` from that moment.
    fileSystem: asFunction(
      ({ root }: { root: string }) =>
        new BunFileSystem(root, {
          dir: LOCAL_STATE_DIR,
          created: () => excludeLocally(root, LOCAL_STATE_DIR),
        }),
    ).singleton(),
    fileLock: asFunction(({ root }: { root: string }) => new BunFileLock(root)).singleton(),
    processRunner: asFunction(() => new BunProcessRunner()).singleton(),
    timer: asFunction(() => new BunTimer()).singleton(),
    launcher: asFunction(() => new BunLauncher()).singleton(),
    updateConfig: asFunction(({ fileSystem }) => new UpdateConfig(fileSystem)),
    userConfig: asFunction(
      () => new BunMachineState(options.userConfigDir ?? userConfigDir(process.env)),
    ).singleton(),
    optionStore: asFunction(
      ({ fileSystem, userConfig, config: loaded, runRepository }) =>
        new OptionStore({
          fs: fileSystem,
          user: userConfig,
          config: loaded.config,
          configFile: loaded.source,
          runs: runRepository,
        }),
    ),
    containerRuntime: asFunction(() => new DockerComposeRuntime(options.dockerBin)).singleton(),
    healthProbe: asFunction(() => new WaitOnHealthProbe()).singleton(),
    environmentCatalog: asFunction(({ fileSystem, paths }) => new EnvironmentCatalog(fileSystem, paths)),
    discoverEnvironment: asFunction(
      ({ fileSystem, packageManagerDetector, workspaceReader }) =>
        new DiscoverEnvironment(fileSystem, packageManagerDetector, workspaceReader),
    ),
    initEnvironment: asFunction(
      ({ discoverEnvironment, fileSystem, paths }) =>
        new InitEnvironment(discoverEnvironment, fileSystem, paths),
    ),
    environmentServices: asFunction(
      ({
        environmentCatalog,
        worktreeRegistry,
        backgroundProcess,
        containerRuntime,
        healthProbe,
        processRunner,
        dataIsolator,
        treeCopier,
        fileSystem,
        clock,
        paths,
        root,
      }) =>
        new EnvironmentServices(
          environmentCatalog,
          worktreeRegistry,
          {
            processes: backgroundProcess,
            containers: containerRuntime,
            health: healthProbe,
            steps: processRunner,
            isolator: dataIsolator,
            copier: treeCopier,
          },
          fileSystem,
          clock,
          paths,
          // Logs live outside the repository, one directory per repository.
          { root, logDir: join(tmpdir(), `metator-${Bun.hash(root).toString(36)}`) },
        ),
    ),
    dataIsolator: asFunction(() => new BunSqlDataIsolator()).singleton(),
    treeCopier: asFunction(() => new NodeTreeCopier()).singleton(),
    backgroundProcess: asFunction(() => new BunBackgroundProcess()).singleton(),
    answerPolicyStore: asFunction(({ fileSystem }) => new AnswerPolicyStore(fileSystem)),
    driverLock: asFunction(
      ({ runRepository, runJournal, clock }) => new DriverLock(runRepository, runJournal, clock),
    ),
    runMessages: asFunction(
      ({ fileSystem, runRepository, runJournal, clock }) =>
        new RunMessages(fileSystem, runRepository, runJournal, clock),
    ),
    buildReport: asFunction(
      ({ runRepository, runJournal, clock }) => new BuildReport(runRepository, runJournal, clock),
    ),
    reviewFeedback: asFunction(
      ({ fileSystem, paths, clock }) => new ReviewFeedback(fileSystem, paths, clock),
    ),
    renderReport: asFunction(
      ({ buildReport, reviewFeedback, fileSystem, clock }) =>
        new RenderReport(buildReport, reviewFeedback, fileSystem, clock),
    ),
    worktreeConflicts: asFunction(
      ({ runRepository, worktreeRegistry, processRunner, runMessages, root }) =>
        new WorktreeConflicts(
          runRepository,
          worktreeRegistry,
          (entry) => worktreeChanges(processRunner, root, entry.path),
          runMessages,
        ),
    ),
    checkReadiness: asFunction(
      ({
        fileSystem,
        paths,
        config,
        workflowCatalog,
        vcs,
        root,
        worktreeRegistry,
        environmentServices,
        optionStore,
        runRepository,
        processRunner,
        driveHostProblem,
        runGate,
      }) =>
        new CheckReadiness(
          fileSystem,
          paths,
          config,
          workflowCatalog,
          vcs,
          async (p) => isDirectory(join(root, p)),
          worktreeRegistry,
          environmentServices,
          { servers: () => optionStore.mcp(), hasCommand: async (bin) => Bun.which(bin) !== null },
          runRepository,
          {
            hosts: () =>
              config.config.hosts.targets.map((id: string) => ({ id, problem: driveHostProblem(id) })),
            modified: () => modifiedTracked(processRunner, root),
            detached: () => detachedHead(processRunner, root),
            quickGate: () => runGate.execute({ gate: "quick" }),
          },
        ),
    ),
    setupWorktree: asFunction(
      ({
        fileSystem,
        worktreeRegistry,
        runRepository,
        packageManager,
        processRunner,
        treeCopier,
        environmentServices,
        workspaceReader,
        root,
      }) =>
        new SetupWorktree(
          fileSystem,
          worktreeRegistry,
          runRepository,
          packageManager,
          processRunner,
          treeCopier,
          environmentServices,
          {
            root,
            isDirectory: async (p) => isDirectory(join(root, p)),
            workspaces: async () => {
              const packages = await workspaceReader.packages();
              return packages.isOk()
                ? packages.value.map((w: WorkspacePackage) => w.dir).filter((d: string) => d !== ".")
                : [];
            },
            now: () => Date.now(),
          },
        ),
    ),
    workOverview: asFunction(
      ({
        runRepository,
        workflowCatalog,
        runJournal,
        runDrivers,
        worktreeRegistry,
        environmentServices,
        conversationRepository,
        clock,
      }) =>
        new WorkOverview(
          runRepository,
          workflowCatalog,
          runJournal,
          runDrivers,
          worktreeRegistry,
          environmentServices,
          conversationRepository,
          clock,
        ),
    ),
    conversationRepository: asFunction(
      ({ fileSystem, paths }) => new ConversationRepository(fileSystem, paths),
    ).singleton(),
    askQuestion: asFunction(
      ({ agentHosts, conversationRepository, clock }) =>
        new AskQuestion(agentHosts, conversationRepository, clock, async (cwd: string, path: string) =>
          existsSync(join(cwd, path)),
        ),
    ),
    agentHosts: asFunction(() => {
      const hosts = new Map<string, AgentHost>([
        ["claude", new ClaudeAgentHost()],
        ["copilot", new CopilotAgentHost(options.copilotBin)],
      ]);
      if (options.agentScenario) hosts.set("scenario", new ScenarioAgentHost(options.agentScenario));
      return hosts;
    }).singleton(),
    terminal: asFunction(() => new NodePtyTerminal()).singleton(),
    interactiveHosts: asFunction(({ terminal, config }) => {
      const hosts = new Map<string, InteractiveHost>();
      // The first host is the default of a new session: the scenario when a test plays one, else
      // the first of `supervisor.hostOrder`.
      if (options.agentScenario)
        hosts.set("scenario", new ScenarioInteractiveHost(terminal, options.agentScenario));
      for (const host of orderedHosts(config.config.supervisor.hostOrder, [
        new CopilotInteractiveHost(terminal, options.copilotBin),
        new ClaudeInteractiveHost(terminal, options.claudeBin),
        new OpencodeInteractiveHost(terminal, options.opencodeBin),
      ]))
        hosts.set(host.id, host);
      return hosts;
    }).singleton(),
    // Which interactive hosts can start here: the program each one runs, looked up when asked
    // (a host installed while the daemon runs is found without a restart).
    // Why a host that drives agents cannot start here. Claude runs through its SDK and the scenario
    // host is played by a test: only Copilot needs its program on the PATH.
    driveHostProblem: asFunction(() => (host: string): string | undefined => {
      if (host !== "copilot") return undefined;
      const command = options.copilotBin ?? "copilot";
      return commandExists(command) ? undefined : `\`${command}\` is not installed`;
    }).singleton(),
    hostStatus: asFunction(({ interactiveHosts }) => () => {
      const commands: Readonly<Record<string, string>> = {
        copilot: options.copilotBin ?? "copilot",
        claude: options.claudeBin ?? "claude",
        opencode: options.opencodeBin ?? "opencode",
      };
      return [...interactiveHosts.keys()].map((id) => {
        const command = commands[id];
        // A host with no program of its own (the scenario a test plays) is always there.
        return command === undefined
          ? { id, installed: true }
          : { id, command, installed: commandExists(command) };
      });
    }).singleton(),
    ptyBroker: asFunction(
      ({ runRepository, runJournal, config, clock }) =>
        new PtyBroker({
          repo: runRepository,
          journal: runJournal,
          idleMs: config.config.supervisor.idleThresholdMs,
          clock,
        }),
    ).singleton(),
    hostManifests: asFunction(({ fileSystem }) => new HostManifestCatalog(fileSystem)).singleton(),
    paneSensor: asFunction(
      ({ ptyBroker, hostManifests, runJournal, clock }) =>
        new PaneSensor({ broker: ptyBroker, manifests: hostManifests, journal: runJournal, clock }),
    ).singleton(),
    notifier: asFunction(
      ({ runJournal, processRunner, root, config }) =>
        new Notifier({
          journal: runJournal,
          process: processRunner,
          root,
          ...(config.config.notify ? { command: config.config.notify.command } : {}),
        }),
    ).singleton(),
    hostPrompts: asFunction(
      ({ paneSensor, runJournal, driverLock, notifier }) =>
        new HostPrompts({ sensor: paneSensor, journal: runJournal, lock: driverLock, notify: notifier }),
    ),
    layoutStore: asFunction(({ fileSystem }) => new LayoutStore(fileSystem)).singleton(),
    issues: asFunction(
      ({ fileSystem, paths, clock, runJournal, runRepository, initRun, optionStore, fileLock }) =>
        new Issues({
          lock: fileLock,
          fs: fileSystem,
          paths,
          clock,
          journal: runJournal,
          repo: runRepository,
          initRun,
          proposalsAllowed: async () => {
            const o = await optionStore.get("issues.proposeFromAgents");
            return o.isOk() ? o.value.value !== false : true;
          },
        }),
    ),
    codeHost: asFunction(
      ({ optionStore, root }) => new McpCodeHost(() => optionStore.mcp(), new SdkToolCaller(root)),
    ),
    reviewHost: asFunction(
      ({ optionStore, root }) => new McpReviewHost(() => optionStore.mcp(), new SdkToolCaller(root)),
    ),
    myReviews: asFunction(
      ({ config, fileSystem, paths, clock, reviewHost, initRun, runRepository, notifier }) =>
        new MyReviews({
          notifier,
          config: config.config.reviews,
          fs: fileSystem,
          paths,
          clock,
          host: reviewHost,
          initRun,
          runActive: async (runId) => {
            const record = await runRepository.load(runId);
            return record.isOk() && record.value.state.status === "active";
          },
          runDone: async (runId) => {
            const record = await runRepository.load(runId);
            return record.isOk() && record.value.state.status === "done";
          },
        }),
    ),
    scanIntake: asFunction(
      ({ config, issues, codeHost, runRepository, fileLock, paths }) =>
        new ScanIntake({
          exclusive: (work) => fileLock.hold(`${paths.issues}/intake`, work),
          config: config.config.intake,
          issues,
          codeHost,
          // Runs intake started that are still active: its issues in progress whose run goes on.
          activeRuns: async () => {
            const backlog = await issues.list({ status: "in-progress" });
            if (backlog.isErr()) return err(backlog.error);
            let active = 0;
            for (const i of backlog.value) {
              if (!i.source || !i.runId) continue;
              const record = await runRepository.load(i.runId);
              if (record.isOk() && record.value.state.status === "active") active++;
            }
            return ok(active);
          },
        }),
    ),
    planBoard: asFunction(
      ({ fileSystem, runRepository, runJournal, workflowCatalog, conductor, paths }) =>
        new PlanBoard({
          fs: fileSystem,
          repo: runRepository,
          journal: runJournal,
          catalog: workflowCatalog,
          conductor,
          paths,
        }),
    ),
    openEditor: asFunction(
      ({ root, runRepository, panes, optionStore, launcher, runJournal }) =>
        new OpenEditor({
          root,
          repo: runRepository,
          panes,
          options: optionStore,
          launcher,
          journal: runJournal,
        }),
    ),
    reviewNotes: asFunction(
      ({ fileSystem, runRepository, runMessages, clock }) =>
        new ReviewNotes({ fs: fileSystem, repo: runRepository, messages: runMessages, clock }),
    ),
    runChanges: asFunction(
      ({ root, runRepository, processRunner, vcsAt }) =>
        new RunChanges({
          root,
          repo: runRepository,
          changesAt: vcsAt,
          runner: processRunner,
        }),
    ),
    conductor: asFunction(
      ({ panes, runRepository, runJournal, workflowCatalog, fileSystem, clock, timer, root }) =>
        new Conductor({
          panes,
          repo: runRepository,
          journal: runJournal,
          catalog: workflowCatalog,
          fs: fileSystem,
          clock,
          timer,
          root,
        }),
    ),
    panes: asFunction(
      ({
        layoutStore,
        ptyBroker,
        interactiveHosts,
        terminal,
        runRepository,
        runJournal,
        clock,
        timer,
        root,
        paneSensor,
      }) =>
        new Panes({
          layout: layoutStore,
          broker: ptyBroker,
          hosts: interactiveHosts,
          terminal,
          repo: runRepository,
          journal: runJournal,
          clock,
          timer,
          root,
          sensor: paneSensor,
        }),
    ).singleton(),
    // The supervisor needs a way to start a drive again, which only the CLI process knows (its own
    // argv). Not a singleton (its drivers are not): the caller keeps the one instance it ticks.
    supervisor: asFunction(
      ({ config, runRepository, runDrivers, runJournal, ptyBroker, workOverview, hostPrompts, panes }) =>
        (restart: SupervisorDependencies["restart"]) =>
          new Supervisor({
            policy: config.config.supervisor,
            repo: runRepository,
            drivers: runDrivers,
            journal: runJournal,
            broker: ptyBroker,
            overview: workOverview,
            restart,
            prompts: hostPrompts,
            panes,
          }),
    ),
    runDrivers: asFunction(
      ({ fileSystem, runRepository, backgroundProcess, runJournal, clock }) =>
        new RunDrivers(fileSystem, runRepository, backgroundProcess, runJournal, clock),
    ),
    runJournal: asFunction(
      ({ fileSystem, runRepository, clock }) => new RunJournal(fileSystem, runRepository, clock),
    ).singleton(),
    driveRun: asFunction(
      ({
        workflowCatalog,
        runRepository,
        runJournal,
        advanceRun,
        approveRun,
        closeRun,
        agentHosts,
        processRunner,
        notifier,
        fileSystem,
        timer,
        root,
        config,
        answerPolicyStore,
        runMessages,
        paths,
        worktreeRegistry,
        driveHostProblem,
      }) =>
        new DriveRun({
          catalog: workflowCatalog,
          repo: runRepository,
          journal: runJournal,
          advance: advanceRun,
          approve: approveRun,
          close: closeRun,
          hosts: agentHosts,
          process: processRunner,
          fs: fileSystem,
          timer,
          root,
          metatorCommand: config.config.hosts.metatorCommand,
          notes: async (cwd) => workNotes(cwd),
          policies: () => answerPolicyStore.list(),
          messages: (runId) => runMessages.list(runId),
          gatesDir: paths.gates,
          worktrees: worktreeRegistry,
          notifier,
          hostProblem: driveHostProblem,
        }),
    ),
    // One GitVcs behind every git port, so they all agree on what a change is.
    git: asFunction(({ root }) => new GitVcs(root, OWN_STATE)).singleton(),
    vcs: asFunction(({ git }) => git).singleton(),
    // The same reading of a change in another checkout (a worktree).
    vcsAt: asFunction(() => (dir: string) => new GitVcs(dir, OWN_STATE)).singleton(),
    revisionReader: asFunction(({ git }) => git).singleton(),
    changeHistory: asFunction(({ git }) => git).singleton(),
    branchHistory: asFunction(({ git }) => git).singleton(),
    changePatch: asFunction(({ git }) => git).singleton(),
    sandbox: asFunction(() => new TempGitSandbox()).singleton(),
    nodePackageManager: asFunction(({ root }) => new NodePackageManager(root)).singleton(),
    packageManagerDetector: asFunction(({ nodePackageManager }) => nodePackageManager).singleton(),
    packageManager: asFunction(({ nodePackageManager }) => nodePackageManager).singleton(),
    binResolver: asFunction(({ root }) => new NodeBinResolver(root)).singleton(),
    workspaceReader: asFunction(({ root }) => new ManypkgWorkspaceReader(root)).singleton(),
    toolBoundariesReader: asFunction(({ root }) => new JsonToolBoundariesReader(root)).singleton(),
    manifestReader: asFunction(
      ({ root, workspaceReader }) => new ManypkgManifestReader(root, workspaceReader),
    ).singleton(),
    importAnalyzer: asFunction(({ root }) => new OxcImportAnalyzer(root)).singleton(),
    symbolAnalyzer: asFunction(({ root }) => new OxcImportAnalyzer(root)).singleton(),
    sourceFiles: asFunction(
      ({ vcs, fileSystem, sourceIgnores }) => new SourceFiles(vcs, fileSystem, sourceIgnores),
    ).singleton(),
    buildImportGraph: asFunction(
      ({ sourceFiles, fileSystem, importAnalyzer, workspaceReader, paths }) =>
        new BuildImportGraph(
          sourceFiles,
          fileSystem,
          importAnalyzer,
          workspaceReader,
          paths,
          OxcImportAnalyzer.id,
        ),
    ).singleton(),
    importGraphReader: asFunction(({ buildImportGraph }) => new IndexedImportGraphReader(buildImportGraph)),
    graphQueries: asFunction(({ buildImportGraph }) => new GraphQueries(buildImportGraph)),
    ruleEngines: asFunction(({ processRunner, root }) => [
      new AstGrepEngine(processRunner, root),
      new BiomeEngine(processRunner, root),
      new TscEngine(processRunner, root),
      new BunTestEngine(processRunner, root),
    ]).singleton(),
    ruleScaffolders: asFunction(({ root }) => [new AstGrepScaffolder(root)]).singleton(),
    ruleCatalog: asFunction(({ fileSystem, paths }) => new RuleCatalog(fileSystem, paths)).singleton(),
    lintRules: asFunction(
      ({ ruleCatalog, fileSystem, sourceFiles, ruleEngines }) =>
        new LintRules(ruleCatalog, fileSystem, sourceFiles, ruleEngines),
    ),
    packRules: asFunction(({ ruleCatalog }) => new PackRules(ruleCatalog)),
    generateRuleAdapters: asFunction(
      ({ ruleCatalog, fileSystem, paths }) => new GenerateRuleAdapters(ruleCatalog, fileSystem, paths),
    ),
    checkRules: asFunction(
      ({ ruleCatalog, ruleEngines, vcs }) => new CheckRules(ruleCatalog, ruleEngines, vcs),
    ),
    memoryMapReader: asFunction(
      ({ fileSystem, paths }) => new MemoryMapReader(fileSystem, paths),
    ).singleton(),
    knowledgeFiles: asFunction(({ sourceFiles }) => new KnowledgeFiles(sourceFiles)).singleton(),
    inventoryMemory: asFunction(
      ({ memoryMapReader, knowledgeFiles, fileSystem }) =>
        new InventoryMemory(memoryMapReader, knowledgeFiles, fileSystem),
    ),
    memoryBudget: asFunction(
      ({ memoryMapReader, fileSystem }) => new MemoryBudget(memoryMapReader, fileSystem),
    ),
    validateCitations: asFunction(
      ({ memoryMapReader, fileSystem }) => new ValidateCitations(memoryMapReader, fileSystem),
    ),
    checkMemory: asFunction(
      ({ memoryMapReader, knowledgeFiles, fileSystem, memoryBudget, validateCitations }) =>
        new CheckMemory(memoryMapReader, knowledgeFiles, fileSystem, memoryBudget, validateCitations),
    ),
    buildModuleCards: asFunction(
      ({
        buildImportGraph,
        fileSystem,
        paths,
        testGlobs,
        findOwners,
        patternCatalog,
        systemCatalog,
        architecturePolicyCatalog,
      }) =>
        new BuildModuleCards(
          buildImportGraph,
          fileSystem,
          paths,
          testGlobs,
          findOwners,
          patternCatalog,
          systemCatalog,
          architecturePolicyCatalog,
        ),
    ),
    patternCatalog: asFunction(({ fileSystem, paths }) => new PatternCatalog(fileSystem, paths)).singleton(),
    scanPatterns: asFunction(
      ({ patternCatalog, ruleCatalog, ruleEngines, workspaceReader, fileSystem, paths }) =>
        new ScanPatterns(patternCatalog, ruleCatalog, ruleEngines, workspaceReader, fileSystem, paths),
    ),
    findSimilar: asFunction(({ scanPatterns }) => new FindSimilar(scanPatterns)),
    apiSnapshots: asFunction(
      ({ processRunner, root, workspaceReader, fileSystem, paths }) =>
        new ApiSnapshots(new TscDeclarationEmitter(processRunner, root), workspaceReader, fileSystem, paths),
    ),
    diffCoverage: asFunction(
      ({ revisionReader, root, testGlobs }) =>
        new DiffCoverage(revisionReader, new LcovCoverageReader(root), testGlobs),
    ),
    checkFlaky: asFunction(
      ({ packageManager, processRunner }) => new CheckFlaky(packageManager, processRunner),
    ),
    checkDebugTags: asFunction(
      ({ vcs, fileSystem, sourceIgnores }) => new CheckDebugTags(vcs, fileSystem, sourceIgnores),
    ),
    checkQuote: asFunction(({ fileSystem }) => new CheckQuote(fileSystem)),
    findOwners: asFunction(({ fileSystem }) => new FindOwners(fileSystem)),
    // Contract kinds the installed plugins provide (ADR-0047). MVP: OpenAPI only.
    contractKinds: asValue(["openapi"]),
    systemCatalog: asFunction(({ fileSystem, paths, config }) => {
      const map = config.config.system?.map;
      return new SystemCatalog(
        fileSystem,
        map && "path" in map && !("repo" in map) ? map.path : paths.system,
      );
    }),
    repositoryCloner: asFunction(() => new GitRepositoryCloner()).singleton(),
    checkoutReader: asFunction(() => new BunCheckoutReader()).singleton(),
    // One clone cache per process: a pinned ref resolves to one commit for the whole command.
    cloneCache: asFunction(
      ({ repositoryCloner, root, paths }) => new CloneCache(repositoryCloner, join(root, paths.systemCache)),
    ).singleton(),
    systemLocation: asFunction(({ systemCatalog, config, root, cloneCache, checkoutReader }) => {
      const map = config.config.system?.map;
      return map && "repo" in map
        ? new PinnedSystemLocation(map, root, cloneCache, checkoutReader)
        : new LocalSystemLocation(systemCatalog, root);
    }),
    systemSources: asFunction(
      ({ config, root, systemLocation, cloneCache, checkoutReader, vcs }) =>
        new SystemSources(config.config.system, root, systemLocation, cloneCache, checkoutReader, vcs),
    ),
    systemImpactQuery: asFunction(
      ({ systemSources, vcs, importGraphReader }) =>
        new SystemImpactQuery(systemSources, vcs, importGraphReader),
    ),
    lintSystem: asFunction(
      ({ systemSources, fileSystem, contractKinds, checkoutReader }) =>
        new LintSystem(systemSources, fileSystem, contractKinds, checkoutReader),
    ),
    showSystem: asFunction(({ systemLocation }) => new ShowSystem(systemLocation)),
    contractDetectors: asFunction(() => [new OpenApiContractDetector()]).singleton(),
    contractDiffers: asFunction(() => [new OpenApiContractDiffer()]).singleton(),
    diffContracts: asFunction(
      ({ systemSources, revisionReader, fileSystem, contractDiffers, systemPlanStore }) =>
        new DiffContracts(
          systemSources,
          revisionReader,
          fileSystem,
          contractDiffers,
          new PlannedBreakingChanges(systemPlanStore),
        ),
    ),
    systemPlanStore: asFunction(
      ({ fileSystem, paths }) => new SystemPlanStore(fileSystem, paths.systemPlans),
    ),
    analyzeSystem: asFunction(
      ({ systemImpactQuery, diffContracts, systemPlanStore }) =>
        new AnalyzeSystem(systemImpactQuery, diffContracts, systemPlanStore),
    ),
    createSystemPlan: asFunction(
      ({ analyzeSystem, systemLocation, systemPlanStore }) =>
        new CreateSystemPlan(analyzeSystem, systemLocation, systemPlanStore),
    ),
    lintSystemPlan: asFunction(
      ({ systemLocation, systemPlanStore }) => new LintSystemPlan(systemLocation, systemPlanStore),
    ),
    approveSystemPlan: asFunction(
      ({ lintSystemPlan, systemPlanStore, clock }) =>
        new ApproveSystemPlan(lintSystemPlan, systemPlanStore, clock),
    ),
    proposeSystemPlan: asFunction(
      ({ agentHosts, analyzeSystem, createSystemPlan, lintSystemPlan, systemPlanStore, systemSources }) =>
        new ProposeSystemPlan(
          agentHosts,
          analyzeSystem,
          createSystemPlan,
          lintSystemPlan,
          systemPlanStore,
          () => checkoutRoots(systemSources),
        ),
    ),
    // Run tools of another repository on this machine: its own container, with its own config.
    repositoryRuns: asValue((root: string): RepositoryRuns => {
      const there = root === options.root ? c : elsewhere(root);
      return { init: there.resolve("initRun"), runs: there.resolve("runRepository") };
    }),
    runSystemPlan: asFunction(
      ({ systemPlanStore, systemSources, repositoryRuns, clock, runRepository }) =>
        new RunSystemPlan(systemPlanStore, systemSources, repositoryRuns, clock, runRepository),
    ),
    systemPlanStatus: asFunction(
      ({ systemPlanStore, systemSources, repositoryRuns }) =>
        new SystemPlanStatus(systemPlanStore, systemSources, repositoryRuns),
    ),
    runSystemEvals: asFunction(
      ({ fileSystem, paths, sandbox }) =>
        new RunSystemEvals(
          fileSystem,
          paths.systemEvals,
          sandbox,
          (root) => {
            const there = elsewhere(root);
            return {
              create: there.resolve("createSystemPlan"),
              propose: there.resolve("proposeSystemPlan"),
              lint: there.resolve("lintSystemPlan"),
              store: there.resolve("systemPlanStore"),
            };
          },
          () => agentDefinitionFiles(fileSystem, ["mt-system-scout", "mt-system-planner"]),
        ),
    ),
    discoverySource: asFunction(
      ({ root, vcs, fileSystem, manifestReader, architectureFacts, findOwners }) =>
        new RepositoryDiscoverySource(
          basename(root),
          vcs,
          fileSystem,
          manifestReader,
          architectureFacts,
          findOwners,
        ),
    ),
    discoverSystem: asFunction(({ contractDetectors }) => new DiscoverSystem(contractDetectors)),
    architecturePolicyCatalog: asFunction(
      ({ fileSystem, paths }) => new ArchitecturePolicyCatalog(fileSystem, paths.architecture),
    ),
    architectureFacts: asFunction(
      ({
        buildImportGraph,
        manifestReader,
        architecturePolicyCatalog,
        clock,
        symbolQueries,
        changeHistory,
        findOwners,
        sourceFiles,
        fileSystem,
      }) =>
        new ArchitectureFacts(buildImportGraph, manifestReader, architecturePolicyCatalog, clock, {
          symbols: symbolQueries,
          history: changeHistory,
          owners: findOwners,
          styles: new StyleImports(sourceFiles, fileSystem),
        }),
    ),
    architectureBaselineStore: asFunction(
      ({ fileSystem, paths }) => new ArchitectureBaselineStore(fileSystem, paths.archBaseline),
    ),
    baseArchitectureFacts: asFunction(
      ({ vcs, revisionReader, importAnalyzer }) =>
        new BaseArchitectureFacts(vcs, revisionReader, importAnalyzer),
    ),
    checkArchitecture: asFunction(
      ({ architectureFacts, baseArchitectureFacts, architectureBaselineStore, fileSystem }) =>
        new CheckArchitecture(
          architectureFacts,
          baseArchitectureFacts,
          architectureBaselineStore,
          fileSystem,
        ),
    ),
    recordArchitectureBaseline: asFunction(
      ({ architectureFacts, architectureBaselineStore }) =>
        new RecordArchitectureBaseline(architectureFacts, architectureBaselineStore),
    ),
    initArchitecturePolicy: asFunction(
      ({ architectureFacts, toolBoundariesReader, fileSystem, paths }) =>
        new InitArchitecturePolicy(architectureFacts, toolBoundariesReader, fileSystem, paths.architecture),
    ),
    simulateArchitecture: asFunction(({ architectureFacts }) => new SimulateArchitecture(architectureFacts)),
    refactorPlanStore: asFunction(
      ({ fileSystem, paths }) => new RefactorPlanStore(fileSystem, paths.archPlans),
    ),
    createRefactorPlan: asFunction(({ refactorPlanStore }) => new CreateRefactorPlan(refactorPlanStore)),
    simulateRefactorPlan: asFunction(
      ({ architectureFacts, refactorPlanStore }) =>
        new SimulateRefactorPlan(architectureFacts, refactorPlanStore),
    ),
    lintRefactorPlan: asFunction(
      ({ architectureFacts, refactorPlanStore, fileSystem }) =>
        new LintRefactorPlan(architectureFacts, refactorPlanStore, fileSystem),
    ),
    approveRefactorPlan: asFunction(
      ({ lintRefactorPlan, refactorPlanStore, clock }) =>
        new ApproveRefactorPlan(lintRefactorPlan, refactorPlanStore, clock),
    ),
    proposeRefactorPlan: asFunction(
      ({
        agentHosts,
        analyzeArchitecture,
        refactorPlanStore,
        createRefactorPlan,
        simulateRefactorPlan,
        lintRefactorPlan,
      }) =>
        new ProposeRefactorPlan(
          agentHosts,
          analyzeArchitecture,
          refactorPlanStore,
          createRefactorPlan,
          simulateRefactorPlan,
          lintRefactorPlan,
        ),
    ),
    runRefactorPlan: asFunction(
      ({ refactorPlanStore, initRun }) => new RunRefactorPlan(refactorPlanStore, initRun),
    ),
    runArchEvals: asFunction(
      ({ fileSystem, paths, sandbox }) =>
        new RunArchEvals(
          fileSystem,
          paths.archEvals,
          sandbox,
          (root) => {
            const there = elsewhere(root);
            return {
              propose: there.resolve("proposeRefactorPlan"),
              facts: there.resolve("architectureFacts"),
            };
          },
          () => agentDefinitionFiles(fileSystem, ["mt-arch-planner"]),
        ),
    ),
    syncRefactorPlan: asFunction(
      ({ refactorPlanStore, runRepository }) => new SyncRefactorPlan(refactorPlanStore, runRepository),
    ),
    analyzeArchitecture: asFunction(
      ({ architectureFacts, fileSystem, paths }) =>
        new AnalyzeArchitecture(architectureFacts, fileSystem, paths),
    ),
    docsLinks: asFunction(({ sourceFiles, fileSystem }) => new DocsLinks(sourceFiles, fileSystem)),
    docsInventory: asFunction(
      ({ sourceFiles, fileSystem, revisionReader, findOwners, docsLinks, clock }) =>
        new DocsInventory(sourceFiles, fileSystem, revisionReader, findOwners, docsLinks, clock),
    ),
    docsDrift: asFunction(({ fileSystem, paths }) => new DocsDrift(fileSystem, paths.claims)),
    addLesson: asFunction(({ fileSystem, clock, paths }) => new AddLesson(fileSystem, clock, paths.lessons)),
    symbolQueries: asFunction(
      ({ sourceFiles, fileSystem, importAnalyzer, symbolAnalyzer, workspaceReader }) =>
        new SymbolQueries(sourceFiles, fileSystem, importAnalyzer, symbolAnalyzer, workspaceReader),
    ),
    diffImportGraph: asFunction(
      ({ vcs, revisionReader, buildImportGraph, importAnalyzer }) =>
        new DiffImportGraph(vcs, revisionReader, buildImportGraph, importAnalyzer),
    ),
    lintPlan: asFunction(
      ({ fileSystem, scanPatterns, ruleCatalog, buildImportGraph, testGlobs }) =>
        new LintPlan(fileSystem, scanPatterns, ruleCatalog, buildImportGraph, testGlobs),
    ),
    scopePlan: asFunction(({ fileSystem, buildImportGraph }) => new ScopePlan(fileSystem, buildImportGraph)),
    lintAdrs: asFunction(
      ({ fileSystem, paths, ruleCatalog }) => new LintAdrs(fileSystem, paths, ruleCatalog),
    ),
    measureRuleCoverage: asFunction(
      ({ ruleCatalog, sourceFiles, ruleEngines }) =>
        new MeasureRuleCoverage(ruleCatalog, sourceFiles, ruleEngines),
    ),
    scaffoldRule: asFunction(
      ({ ruleCatalog, ruleScaffolders }) => new ScaffoldRule(ruleCatalog, ruleScaffolders),
    ),
    findMemoryDupes: asFunction(
      ({ memoryMapReader, knowledgeFiles, fileSystem }) =>
        new FindMemoryDupes(memoryMapReader, knowledgeFiles, fileSystem),
    ),
    discover: asFunction(
      ({ fileSystem, sourceFiles, vcs, workspaceReader, packageManagerDetector, paths }) =>
        new Discover(fileSystem, sourceFiles, vcs, workspaceReader, packageManagerDetector, paths),
    ),
    gateChecks: asFunction(
      ({
        checkRules,
        runAffectedTests,
        diffImportGraph,
        apiSnapshots,
        diffCoverage,
        checkArchitecture,
        diffContracts,
      }) =>
        new GateChecks(
          checkRules,
          runAffectedTests,
          diffImportGraph,
          apiSnapshots,
          diffCoverage,
          checkArchitecture,
          diffContracts,
        ),
    ),
    runGate: asFunction(
      ({ config, packageManager, binResolver, processRunner, gateChecks, vcs, fileSystem, paths, clock }) =>
        new RunGate(
          config.config,
          packageManager,
          binResolver,
          processRunner,
          gateChecks,
          vcs,
          fileSystem,
          paths,
          clock,
        ),
    ),
    installCanon: asFunction(
      ({ fileSystem, paths }) => new InstallCanon(resolveCanon(options.canon), fileSystem, paths),
    ),
    initProject: asFunction(
      ({ discover, fileSystem, paths }) => new InitProject(discover, fileSystem, paths),
    ),
    hostGenerators: asValue([new CopilotGenerator(), new ClaudeGenerator()]),
    skillGenerators: asValue([new CopilotSkillGenerator(), new ClaudeSkillGenerator()]),
    auditAgents: asFunction(
      ({ agentCatalog, skillCatalog, fileSystem }) => new AuditAgents(agentCatalog, skillCatalog, fileSystem),
    ),
    skillCatalog: asFunction(({ fileSystem, paths }) => new SkillCatalog(fileSystem, paths)).singleton(),
    lintSkills: asFunction(({ skillCatalog, fileSystem }) => new LintSkills(skillCatalog, fileSystem, "mt-")),
    generateSkills: asFunction(
      ({ skillCatalog, skillGenerators, fileSystem, config }) =>
        new GenerateSkills(skillCatalog, skillGenerators, fileSystem, config.config),
    ),
    agentCatalog: asFunction(({ fileSystem, paths }) => new AgentCatalog(fileSystem, paths)).singleton(),
    lintAgents: asFunction(({ agentCatalog }) => new LintAgents(agentCatalog, "mt-")),
    generateHosts: asFunction(
      ({ agentCatalog, hostGenerators, fileSystem, config, optionStore }) =>
        new GenerateHosts(agentCatalog, hostGenerators, fileSystem, config.config, () =>
          // The repository's servers only: `.mcp.json` is committed, a person's servers are not the team's.
          optionStore.repoMcp(),
        ),
    ),
    validateFindings: asFunction(({ fileSystem }) => new ValidateFindings(fileSystem)),
    mergeFindings: asFunction(
      ({ fileSystem, validateFindings }) => new MergeFindingSets(fileSystem, validateFindings),
    ),
    calibrateFinding: asFunction(({ fileSystem }) => new CalibrateFinding(fileSystem)),
    planReview: asFunction(
      ({ vcs, workspaceReader, ruleCatalog, fileSystem, paths, sourceIgnores }) =>
        new PlanReview(vcs, workspaceReader, ruleCatalog, fileSystem, paths, sourceIgnores),
    ),
    showChangeDiff: asFunction(({ changePatch, fileSystem }) => new ShowChangeDiff(changePatch, fileSystem)),
    checkPublished: asFunction(({ changePatch }) => new CheckPublished(changePatch)),
    describeReviewedChange: asFunction(
      ({ vcs, branchHistory, fileSystem }) => new DescribeReviewedChange(vcs, branchHistory, fileSystem),
    ),
    judgeFindings: asFunction(({ fileSystem }) => new JudgeFindings(fileSystem)),
    formatReviewComments: asFunction(({ fileSystem }) => new FormatReviewComments(fileSystem)),
    evalCatalog: asFunction(({ fileSystem, paths }) => new EvalCatalog(fileSystem, paths)).singleton(),
    scoreEvals: asFunction(({ evalCatalog, fileSystem }) => new ScoreEvals(evalCatalog, fileSystem)),
    compareEvals: asFunction(({ fileSystem }) => new CompareEvals(fileSystem)),
    seedGoldenSet: asFunction(
      ({ fileSystem, paths, processRunner, root }) =>
        new SeedGoldenSet({ fs: fileSystem, paths, runner: processRunner, root }),
    ),
    quarterlyReview: asFunction(
      ({ measureRuleCoverage, memoryBudget, docsInventory, compareEvals, fileSystem, paths, clock }) =>
        new RunQuarterlyReview({
          coverage: measureRuleCoverage,
          budget: memoryBudget,
          inventory: docsInventory,
          compare: compareEvals,
          fs: fileSystem,
          paths,
          clock,
        }),
    ),
    runEvals: asFunction(
      ({ evalCatalog, binResolver, processRunner, root }) =>
        new RunEvals(evalCatalog, binResolver, processRunner, root),
    ),
    runAffectedTests: asFunction(
      ({ computeAffected, packageManager, processRunner }) =>
        new RunAffectedTests(computeAffected, packageManager, processRunner),
    ),
    computeAffected: asFunction(
      ({ vcs, importGraphReader, testGlobs, importAnalyzer }) =>
        new ComputeAffected(vcs, importGraphReader, testGlobs, importAnalyzer.extensions),
    ),
    lintWorkflows: asFunction(
      ({ workflowCatalog, agentCatalog, skillCatalog }) =>
        new LintWorkflows(workflowCatalog, agentCatalog, skillCatalog),
    ),
    workflowCatalog: asFunction(
      ({ fileSystem, paths }) => new WorkflowCatalog(fileSystem, paths),
    ).singleton(),
    runRepository: asFunction(
      ({ fileSystem, paths, fileLock }) => new RunRepository(fileSystem, paths, options.run, fileLock),
    ).singleton(),
    initRun: asFunction(
      ({ workflowCatalog, runRepository, clock, provideWorktree, checkReadiness }) =>
        new InitRun(workflowCatalog, runRepository, clock, provideWorktree, checkReadiness),
    ),
    worktreeManager: asFunction(({ root }) => new GitWorktreeManager(root)).singleton(),
    portProbe: asFunction(() => new GetPortProbe()).singleton(),
    worktreeRegistry: asFunction(
      ({ fileSystem, paths, fileLock }) => new WorktreeRegistry(fileSystem, paths, fileLock),
    ).singleton(),
    machineState: asFunction(
      () => new BunMachineState(options.stateDir ?? machineStateDir(process.env)),
    ).singleton(),
    machineLeases: asFunction(({ machineState, root }) => new MachineLeases(machineState, root)),
    createWorktree: asFunction(
      ({ worktreeRegistry, worktreeManager, portProbe, clock, paths, machineLeases, root }) =>
        new CreateWorktree(worktreeRegistry, worktreeManager, portProbe, clock, paths, {
          leases: machineLeases,
          root,
        }),
    ),
    provideWorktree: asFunction(
      ({ worktreeRegistry, worktreeManager, createWorktree }) =>
        new ProvideWorktree(worktreeRegistry, worktreeManager, createWorktree),
    ),
    warmPool: asFunction(
      ({ worktreeRegistry, createWorktree, removeWorktree, environmentServices }) =>
        new WarmPool(worktreeRegistry, createWorktree, removeWorktree, environmentServices),
    ),
    analyzeEnvironment: asFunction(
      ({
        environmentCatalog,
        worktreeRegistry,
        createWorktree,
        removeWorktree,
        environmentServices,
        fileSystem,
        clock,
        paths,
      }) =>
        new AnalyzeEnvironment(
          environmentCatalog,
          worktreeRegistry,
          createWorktree,
          removeWorktree,
          environmentServices,
          fileSystem,
          clock,
          paths,
        ),
    ),
    listWorktrees: asFunction(
      ({ worktreeRegistry, worktreeManager, runRepository }) =>
        new ListWorktrees(worktreeRegistry, worktreeManager, runRepository),
    ),
    removeWorktree: asFunction(
      ({ worktreeRegistry, worktreeManager, machineLeases }) =>
        new RemoveWorktree(worktreeRegistry, worktreeManager, machineLeases),
    ),
    pruneWorktrees: asFunction(
      ({ worktreeRegistry, removeWorktree, worktreeManager, runRepository, clock }) =>
        new PruneWorktrees(worktreeRegistry, removeWorktree, worktreeManager, runRepository, clock),
    ),
    advanceRun: asFunction(
      ({ workflowCatalog, runRepository, clock, runJournal }) =>
        new AdvanceRun(workflowCatalog, runRepository, clock, runJournal),
    ),
    approveRun: asFunction(
      ({ advanceRun, runRepository, clock, workflowCatalog }) =>
        new ApproveRun(advanceRun, runRepository, clock, workflowCatalog),
    ),
    guardPreTool: asFunction(
      ({ getRunStatus, runRepository, agentCatalog, fileSystem, root, role }) =>
        new GuardPreTool(getRunStatus, runRepository, agentCatalog, fileSystem, root, role),
    ),
    guardPostEdit: asFunction(
      ({ checkRules, fileSystem, root }) => new GuardPostEdit(checkRules, fileSystem, root),
    ),
    guardStop: asFunction(({ getRunStatus }) => new GuardStop(getRunStatus)),
    guardSubagentOutput: asFunction(
      ({ getRunStatus, runRepository, fileSystem }) =>
        new GuardSubagentOutput(getRunStatus, runRepository, fileSystem),
    ),
    guardSessionStart: asFunction(
      ({ getRunStatus, fileSystem, paths }) => new GuardSessionStart(getRunStatus, fileSystem, paths),
    ),
    resumeRun: asFunction(
      ({ workflowCatalog, runRepository, clock }) => new ResumeRun(workflowCatalog, runRepository, clock),
    ),
    writeRunArtifact: asFunction(
      ({ workflowCatalog, runRepository, fileSystem }) =>
        new WriteRunArtifact(workflowCatalog, runRepository, fileSystem),
    ),
    checkpointRun: asFunction(
      ({ getRunStatus, runRepository, clock }) =>
        new CheckpointRun(getRunStatus, runRepository, () => clock.now().toISOString()),
    ),
    handoffRun: asFunction(
      ({ getRunStatus, runRepository, fileSystem, clock }) =>
        new HandoffRun(getRunStatus, runRepository, fileSystem, clock),
    ),
    closeRun: asFunction(
      ({ advanceRun, runRepository, fileSystem, clock, runDrivers, workflowCatalog }) =>
        new CloseRun(advanceRun, runRepository, fileSystem, clock, runDrivers, workflowCatalog),
    ),
    getRunStatus: asFunction(
      ({ workflowCatalog, runRepository }) => new GetRunStatus(workflowCatalog, runRepository),
    ),
    listRuns: asFunction(({ runRepository }) => new ListRuns(runRepository)),
  });
  return c;
}

/** Where the map's applications' code already is on this machine (never a clone fetched for this). */
export async function checkoutRoots(
  sources: Pick<SystemSources, "locate" | "location">,
): Promise<readonly string[]> {
  const map = await sources.location.require();
  if (map.isErr()) return [];
  const roots: string[] = [];
  for (const app of map.value.applications) {
    const located = await sources.locate(app);
    if (located.isOk() && located.value) roots.push(located.value.root);
  }
  return roots;
}

/**
 * Files a worktree changed since it branched off the main checkout's HEAD: committed on its
 * branch, in its working tree, or new and not ignored; repo-relative.
 */
async function worktreeChanges(
  runner: ProcessRunner,
  root: string,
  path: string,
): Promise<Result<readonly string[], MetatorError>> {
  const dir = join(root, path);
  const git = (argv: string[], cwd: string) => runner.run({ argv: ["git", ...argv], cwd });
  const head = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
  const fork = await git(["merge-base", "HEAD", head], dir);
  if (fork.exitCode !== 0)
    return err(new MetatorError("COMMAND_FAILED", `git merge-base in ${dir}: ${fork.stderr.trim()}`));
  const committed = await git(["diff", "--name-only", fork.stdout.trim()], dir);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], dir);
  const files = `${committed.stdout}\n${untracked.stdout}`
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  return ok([...new Set(files)].sort());
}

/** Tracked files with uncommitted changes, MetatorAI's own state aside; undefined when git cannot say. */
async function modifiedTracked(runner: ProcessRunner, root: string): Promise<readonly string[] | undefined> {
  const status = await runner.run({
    argv: ["git", "-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=no"],
    cwd: root,
  });
  if (status.exitCode !== 0) return undefined;
  return status.stdout
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3))
    .filter((f) => !f.startsWith(".metator/"));
}

/** Whether HEAD is on no branch; undefined when git cannot say (not a repository). */
async function detachedHead(runner: ProcessRunner, root: string): Promise<boolean | undefined> {
  const head = await runner.run({ argv: ["git", "symbolic-ref", "-q", "HEAD"], cwd: root });
  if (head.exitCode === 0) return false;
  return head.exitCode === 1 ? true : undefined;
}

/** Whether a program can be started: a path that exists, or a name found on PATH. */
const commandExists = (command: string): boolean =>
  command.includes("/") ? existsSync(command) : Bun.which(command) !== null;

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * What an agent must know about the directory it works in. A Node project without node_modules
 * cannot run its tests, type checker or linters there, and installing is not the agent's call.
 */
export function workNotes(cwd: string): string[] {
  const manifest = join(cwd, "package.json");
  // A package.json that lists nothing to install has no node_modules and misses nothing (F5).
  if (
    existsSync(manifest) &&
    !existsSync(join(cwd, "node_modules")) &&
    declaresDependencies(readFileSync(manifest, "utf8"))
  )
    return [
      "The project's dependencies are not installed here (no node_modules): its tests, type checker and linters cannot run. Do not install anything or try to run them; write the code and tests, and say plainly that they were not run.",
    ];
  return [];
}
