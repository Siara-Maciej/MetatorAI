import { randomInt } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import {
  AddLesson,
  AdvanceRun,
  AgentCatalog,
  type AgentHost,
  AllGateApprovals,
  AnalyzeArchitecture,
  AnalyzeEnvironment,
  AnalyzerByExtension,
  AnalyzeSystem,
  AnswerPolicyStore,
  AnswerQuestion,
  ApiSnapshots,
  ApproveRefactorPlan,
  ApproveRun,
  ApproveSystemPlan,
  ArchitectureBaselineStore,
  ArchitectureFacts,
  ArchitecturePolicyCatalog,
  AskInRun,
  AskQuestion,
  AuditAgents,
  agentDefinitionFiles,
  allowToolsOf,
  analyzersId,
  BacklogWork,
  BaseArchitectureFacts,
  BriefRun,
  BuildImportGraph,
  BuildModuleCards,
  BuildReport,
  CalibrateFinding,
  ChatNotices,
  CheckArchitecture,
  CheckDebugTags,
  CheckFlaky,
  CheckMemory,
  CheckPlanStep,
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
  type ConductorSessions,
  ConformanceHistory,
  type ConformanceLab,
  ContinueTask,
  type ContractDiffer,
  ConversationRepository,
  CreateRefactorPlan,
  CreateSystemPlan,
  CreateWorktree,
  chatAgentIn,
  checkoutRoots,
  cliVersionOf,
  DAEMON_FILE,
  DaemonInfoDocument,
  DEFAULT_CONFIG,
  DEFAULT_SOURCE_IGNORES,
  DEFAULT_TEST_GLOBS,
  DescribeReviewedChange,
  type DetachedDrive,
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
  daemonAddress,
  driveHostOf,
  driveHostProblem,
  EndRun,
  EnsureDriven,
  EnvironmentCatalog,
  EnvironmentServices,
  EvalCatalog,
  err,
  FindMemoryDupes,
  FindOwners,
  FindSimilar,
  FormatReviewComments,
  GateChecks,
  GateQuestions,
  GenerateHosts,
  GenerateRuleAdapters,
  GenerateSkills,
  GetRunStatus,
  GraphQueries,
  GuardAsked,
  GuardConsents,
  GuardPostEdit,
  GuardPreTool,
  GuardSessionStart,
  GuardStop,
  GuardSubagentOutput,
  GuardUserPrompt,
  HandoffRun,
  HOST_TARGETS,
  type HostBins,
  type HostDescriptor,
  type HostGuard,
  HostManifestCatalog,
  HostPrompts,
  type HostSandbox,
  hostBins,
  hostCommand,
  hostStatus,
  IndexedImportGraphReader,
  InitArchitecturePolicy,
  InitEnvironment,
  InitProject,
  InitRun,
  InstallCanon,
  type InteractiveHost,
  InventoryMemory,
  IssueSnapshots,
  Issues,
  JudgeFindings,
  jvmBuildsOf,
  KnowledgeFiles,
  LayoutPaneIdentity,
  LayoutStore,
  LINUX_SANDBOX_PROGRAMS,
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
  MergedWorkspace,
  MergeFindingSets,
  type MetatorConfig,
  MetatorError,
  type MetatorPaths,
  MyReviews,
  Notifier,
  OpenEditor,
  OptionStore,
  ok,
  PackRules,
  PaneMail,
  PaneQuestions,
  PaneSensor,
  Panes,
  PaneTyped,
  PatternCatalog,
  PinnedSystemLocation,
  PlanBoard,
  PlannedBreakingChanges,
  PlanProgress,
  PlanReview,
  PlanRevisions,
  ProposeRefactorPlan,
  ProposeSystemPlan,
  ProvideWorktree,
  PruneWorktrees,
  PtyBroker,
  parseJsonDocument,
  QuickCheck,
  QuickFit,
  QuickOverrides,
  QuickReady,
  QuickReviewed,
  QuickStart,
  ReadJava,
  ReadRunArtifact,
  RecordArchitectureBaseline,
  RefactorPlanStore,
  RemoveWorktree,
  RenderReport,
  RepositoryDiscoverySource,
  type RepositoryRuns,
  ResumeNotices,
  ResumeRun,
  RetrySystemStep,
  ReviewFeedback,
  ReviewNotes,
  ReviveRuns,
  RoutedReviewHost,
  RuleCatalog,
  RunAffectedTests,
  RunArchEvals,
  RunArtifacts,
  RunChanges,
  RunDrivers,
  RunEvals,
  RunGate,
  RunHostConformance,
  RunJournal,
  RunMessages,
  type RunPanes,
  RunPlanApprovals,
  RunPlans,
  RunQuarterlyReview,
  RunRefactorPlan,
  RunRepository,
  RunSystemEvals,
  RunSystemPlan,
  realHostRefusal,
  resolveIntake,
  reviewSourcesOf,
  type SandboxLaunch,
  ScaffoldRule,
  ScanIntake,
  ScanPatterns,
  ScopePlan,
  ScoreEvals,
  Scratch,
  SeedGoldenSet,
  SessionSteering,
  SetupRepository,
  SetupWorktree,
  ShowChangeDiff,
  ShowSystem,
  SimulateArchitecture,
  SimulateRefactorPlan,
  SkillCatalog,
  SourceFiles,
  StartDrive,
  StartRun,
  StartSystemStep,
  StyleImports,
  Supervisor,
  type SupervisorDependencies,
  SymbolQueries,
  SyncRefactorPlan,
  SystemCatalog,
  SystemImpactQuery,
  SystemMaps,
  SystemPlanApprovals,
  SystemPlanStatus,
  SystemPlanStore,
  SystemPlans,
  SystemRunGate,
  SystemSources,
  sandboxLaunch,
  sandboxPolicy,
  sandboxUnavailable,
  type TaskRepository,
  ThreadStore,
  Threads,
  UpdateConfig,
  ValidateCitations,
  ValidateFindings,
  WarmPool,
  WatchedReviews,
  WorkflowCatalog,
  WorkOverview,
  type WorkspacePackage,
  WorktreeConflicts,
  type WorktreeEntry,
  WorktreeRegistry,
  WriteRunArtifact,
  withoutRealHosts,
  workNotes,
} from "@metator/core";
import {
  BunBackgroundProcess,
  BunCheckoutReader,
  BunFileLock,
  BunFileStats,
  BunFileSystem,
  BunLauncher,
  BunMachineState,
  BunProcessRunner,
  BunSqlDataIsolator,
  BunTestEngine,
  BunTimer,
  commandExists,
  NodeBinResolver,
  NodeTreeCopier,
  onPath,
  pathExists,
  TempGitSandbox,
} from "@metator/plugin-bun";

export {
  findChildRepos,
  findFolderRepos,
  findFolderRoot,
  findRepoRoot,
  readCheckout,
  runsRootOf,
} from "@metator/plugin-bun";

import { AstGrepEngine, AstGrepScaffolder } from "@metator/plugin-astgrep";
import { BiomeEngine } from "@metator/plugin-biome";
import { GhReviewHost } from "@metator/plugin-codehost-gh";
import { McpCodeHost, McpReviewHost, SdkToolCaller } from "@metator/plugin-codehost-mcp";
import { DockerComposeRuntime } from "@metator/plugin-docker";
import {
  excludeLocally,
  GitRepositoryCloner,
  GitVcs,
  GitWorkingPatches,
  GitWorkingTree,
  GitWorktreeManager,
} from "@metator/plugin-git";
import { claudeHost } from "@metator/plugin-host-claude";
import { copilotHost } from "@metator/plugin-host-copilot";
import { opencodeHost } from "@metator/plugin-host-opencode";
import { scenarioHost } from "@metator/plugin-host-scenario";
import {
  JavaBuildFiles,
  JavaDescriptors,
  type JavaGrammarFiles,
  JavaImportAnalyzer,
  JavaWorkspace,
  TreeSitterJavaParser,
} from "@metator/plugin-java";
import {
  GetPortProbe,
  JsonToolBoundariesReader,
  LcovCoverageReader,
  ManypkgManifestReader,
  ManypkgWorkspaceReader,
  NodeContentHasher,
  NodePackageManager,
  NodePtyTerminal,
  SandboxedTerminal,
  SrtSandbox,
  WaitOnHealthProbe,
  XtermScreenRenderer,
} from "@metator/plugin-node";
import { OpenApiContractDetector, OpenApiContractDiffer } from "@metator/plugin-openapi";
import { OxcImportAnalyzer, TscDeclarationEmitter, TscEngine } from "@metator/plugin-typescript";
import { asFunction, asValue } from "awilix";
import { METATOR_VERSION, resolveCanon } from "./canon.ts";
import { type LoadedConfig, loadConfig, resolvePaths } from "./config.ts";
import { createMetatorContainer, type MetatorContainer } from "./container.ts";
import { buildCacheHere, javaVersionOutput } from "./java-here.ts";

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
  /** The program of a host, by host id, where its default name on PATH is not the one (`hostBinsOf`). */
  readonly bins?: HostBins;
  /** No real AI host may start (`METATOR_NO_REAL_HOSTS`, which the test suites set): they say why instead. */
  readonly noRealHosts?: boolean;
  /** GitHub's CLI (METATOR_GH_BIN); default `gh` on PATH. Under `noRealHosts` only a stand-in that says so in its version is used. */
  readonly ghBin?: string;
  /** The Docker CLI (METATOR_DOCKER_BIN); default `docker` on PATH. */
  readonly dockerBin?: string;
  /** Machine-wide state shared by every repository (`machineStateDir`, which the driving adapter asks with its environment); under the home directory when omitted. */
  readonly stateDir?: string;
  /** The person's own MetatorAI files (`userConfigDir`, likewise); under the home directory when omitted. */
  readonly userConfigDir?: string;
  /**
   * How this program starts a run's drive as a background process (its own command line): given
   * by the driving adapter. Without it nothing here can start a drive.
   */
  readonly detachedDrive?: (deps: {
    readonly runDrivers: RunDrivers;
    readonly root: string;
  }) => DetachedDrive;
  /** The panes of a run as this process reaches them (a command: through the daemon); default: this process's own. */
  readonly runPanes?: (deps: { readonly panes: RunPanes; readonly root: string }) => RunPanes;
  /**
   * Where a new run's conductor session opens so a person sees it (ADR-0090): the daemon that
   * serves the repository, which only the driving adapter reaches. Without it, a run asked to be
   * seen (a system plan's child) is driven in the background.
   */
  readonly conductorSessions?: (deps: { readonly root: string }) => ConductorSessions;
  /**
   * The throwaway repository the host conformance suite drives a real host in (ADR-0098): its
   * daemon is started and reached the way only the driving adapter knows. Without it the suite
   * cannot run here.
   */
  readonly conformanceLab?: (deps: { readonly root: string }) => ConformanceLab;
  /** The host a new drive uses when nothing names one (METATOR_HOST), when the runtime holds it. */
  readonly defaultHost?: string;
  /**
   * What a compiled `metator` (the desktop app's, ADR-0105) takes from its installation instead of
   * node_modules: node-pty's package folder, the sandbox runtime's command line and how to run it,
   * and on Windows how node-pty's helper runs (`beBun`). Omitted: node_modules has them.
   */
  readonly installation?: {
    readonly nodePty?: string;
    /** The Java grammar's WebAssembly files (ADR-0107). */
    readonly javaGrammar?: { readonly runtime: string; readonly language: string };
    readonly sandboxRuntime?: { readonly runtime: readonly string[]; readonly cli: string };
    readonly beBun?: <T>(f: () => T) => T;
  };
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

/** A lowercase word of random syllables: what a conformance check gives a session and expects back in uppercase. */
function conformanceWord(): string {
  const [c, v] = ["bdfgklmnprstvz", "aeiou"];
  let word = "";
  for (let i = 0; i < 4; i++) word += `${c[randomInt(c.length)]}${v[randomInt(v.length)]}`;
  return word;
}

/** Where no driving adapter gives a lab, the suite cannot run: each call says so. */
const NO_LAB: ConformanceLab = (() => {
  const no = async () =>
    err(
      MetatorError.usage(
        "the conformance suite runs from the metator command line only",
        "Run `metator host conformance`.",
      ),
    );
  return { open: no, act: no, look: no, save: no, kept: async () => undefined, close: async () => ok({}) };
})();
/** `.metator/` is MetatorAI's own state: never a change, even before setup gitignores it. */
const OWN_STATE: readonly string[] = [".metator/"];

/**
 * The AI hosts this installation knows, in the order a session takes them when the repository
 * names none (`supervisor.hostOrder`) and in which their files are generated. Everything about
 * hosts below is built from this list; a new host is one entry here.
 */
export const HOSTS: readonly HostDescriptor[] = [copilotHost, claudeHost, opencodeHost];

/** Which host drives agents when none is asked for: the first of these that can start. */
const DRIVE_ORDER: readonly string[] = [claudeHost.id, copilotHost.id];

/** The programs the environment names for the hosts (`METATOR_<HOST>_BIN`), for `BootstrapOptions.bins`. */
export const hostBinsOf = (env: Readonly<Record<string, string | undefined>>): HostBins =>
  hostBins(HOSTS, env);

/**
 * Composition root: the only place that knows concrete adapters. Use cases keep plain
 * constructors (framework-agnostic); awilix wires them through factories.
 */
/** The guard as a host adapter takes it: the command lists, and the allow list where MetatorAI answers for what is safe. */
function hostGuard(config: MetatorConfig): HostGuard {
  return {
    ...config.guard.commands,
    ...(config.guard.prompts === "metator"
      ? {
          unprompted: allowToolsOf({
            metatorCommand: config.hosts.metatorCommand,
            gates: [...config.gates.quick, ...config.gates.full].map((s) => s.run),
          }),
        }
      : {}),
  };
}

/**
 * The repository's config as it is now (a session reads its sandbox when it starts): the file,
 * or the config the container was given when there is none (a test's).
 */
function currentConfig(root: string, given: LoadedConfig): LoadedConfig {
  const now = loadConfig(root);
  return now.isOk() && now.value.source !== undefined ? now.value : given;
}

/** The address of the daemon `.metator/daemon.json` names, as the sandbox allows it (`host:port`). */
function daemonAddressAt(root: string): string | undefined {
  try {
    const raw = parseJsonDocument(readFileSync(join(root, DAEMON_FILE), "utf8"), DAEMON_FILE);
    const info = raw.andThen((r) => DaemonInfoDocument.parse(r, DAEMON_FILE));
    return info.isOk() ? daemonAddress(info.value.url) : undefined;
  } catch {
    return undefined;
  }
}

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
    userConfig: asFunction(() => new BunMachineState(options.userConfigDir ?? userConfigDir({}))).singleton(),
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
    containerRuntime: asFunction(
      ({ processRunner }) => new DockerComposeRuntime(processRunner, options.dockerBin),
    ).singleton(),
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
      ({ runRepository, worktreeRegistry, workingTree, runMessages }) =>
        new WorktreeConflicts(
          runRepository,
          worktreeRegistry,
          (entry) => workingTree.worktreeChanges(entry.path),
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
        driveHostProblem,
        runGate,
        checkoutReader,
        workingTree,
        conformanceHistory,
        hostSandbox,
        javaBuild,
        processRunner,
      }) =>
        new CheckReadiness(
          fileSystem,
          paths,
          config,
          workflowCatalog,
          vcs,
          (p) => checkoutReader.isDirectory(join(root, p)),
          worktreeRegistry,
          environmentServices,
          { servers: () => optionStore.mcp(), hasCommand: async (bin) => onPath(bin) },
          runRepository,
          {
            hosts: () =>
              config.config.hosts.targets.map((id: string) => ({ id, problem: driveHostProblem(id) })),
            modified: () => workingTree.modifiedTracked(),
            detached: () => workingTree.detachedHead(),
            platform: () => process.platform,
            quickGate: () => runGate.execute({ gate: "quick" }),
            conformance: () => conformanceHistory.seen(),
            sandboxRuntime: () => hostSandbox.missing?.(),
            builds: async () => {
              const read = await javaBuild.read();
              return read.isOk() ? jvmBuildsOf(read.value) : [];
            },
            java: () => javaVersionOutput(processRunner, root),
            buildCache: async (tool) => buildCacheHere(tool),
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
        checkoutReader,
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
            isDirectory: (p) => checkoutReader.isDirectory(join(root, p)),
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
        ptyBroker,
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
          ptyBroker,
        ),
    ),
    conversationRepository: asFunction(
      ({ fileSystem, paths }) => new ConversationRepository(fileSystem, paths),
    ).singleton(),
    askQuestion: asFunction(
      ({ agentHosts, conversationRepository, clock }) =>
        new AskQuestion(agentHosts, conversationRepository, clock, async (cwd: string, path: string) =>
          pathExists(join(cwd, path)),
        ),
    ),
    // The scenario a test plays is a host only while one is given.
    played: asValue(options.agentScenario ? [scenarioHost(options.agentScenario)] : []),
    hostBins: asValue(options.bins ?? {}),
    // The hosts this process may use: every one, or with the real AI hosts refused (the suites' guard).
    knownHosts: asValue(options.noRealHosts ? withoutRealHosts(HOSTS, options.bins ?? {}) : HOSTS),
    // Every host session this repository starts goes through its host's launch: in the
    // operating system's sandbox while `sandbox.enabled` is on (ADR-0104), read at each start.
    hostSandbox: asFunction(() => {
      const srt = options.installation?.sandboxRuntime;
      return srt ? new SrtSandbox(undefined, srt.runtime, () => srt.cli) : new SrtSandbox();
    }).singleton(),
    sandboxLaunches: asFunction(({ hostSandbox, root }: { hostSandbox: HostSandbox; root: string }) => {
      const launches = new Map<string, SandboxLaunch>();
      const policy = () => sandboxPolicy(currentConfig(root, config).config);
      return (h: HostDescriptor): SandboxLaunch => {
        const known = launches.get(h.id);
        if (known) return known;
        const made = sandboxLaunch({
          policy,
          // MetatorAI's own commands inside the session keep the machine's state where they always do.
          needs: {
            domains: h.sandbox?.domains ?? [],
            writable: [...(h.sandbox?.writable ?? []), machineStateDir(process.env)],
          },
          root,
          temp: tmpdir(),
          daemon: () => daemonAddressAt(root),
          sandbox: hostSandbox,
        });
        launches.set(h.id, made);
        return made;
      };
    }).singleton(),
    agentHosts: asFunction(({ played, hostBins: bins, knownHosts, sandboxLaunches }) => {
      const hosts = new Map<string, AgentHost>();
      for (const h of [...orderedHosts(DRIVE_ORDER, knownHosts), ...played])
        if (h.agent) hosts.set(h.id, h.agent.host(bins[h.id], hostGuard(config.config), sandboxLaunches(h)));
      return hosts;
    }).singleton(),
    terminal: asFunction(
      () => new NodePtyTerminal(options.installation?.nodePty, options.installation?.beBun),
    ).singleton(),
    // A pane's screen as a person sees it (@xterm/headless, ADR-0091): prompts are read from it.
    screenRenderer: asFunction(() => new XtermScreenRenderer()).singleton(),
    // The first host is the default of a new session: the scenario when a test plays one, else
    // the first of `supervisor.hostOrder`.
    sessionHosts: asFunction(({ played, config, knownHosts }) => [
      ...played,
      ...orderedHosts(config.config.supervisor.hostOrder, knownHosts),
    ]).singleton(),
    interactiveHosts: asFunction(({ terminal, sessionHosts, hostBins: bins, sandboxLaunches }) => {
      const hosts = new Map<string, InteractiveHost>();
      for (const h of sessionHosts)
        if (h.interactive)
          hosts.set(
            h.id,
            h.interactive(
              new SandboxedTerminal(terminal, sandboxLaunches(h)),
              bins[h.id],
              hostGuard(config.config),
            ),
          );
      return hosts;
    }).singleton(),
    // Why a host that drives agents cannot start here (its program is not installed).
    driveHostProblem: asFunction(({ played, hostBins: bins, knownHosts }) =>
      driveHostProblem([...knownHosts, ...played], bins, commandExists),
    ).singleton(),
    // Which interactive hosts can start here: the program each one runs, looked up when asked
    // (a host installed while the daemon runs is found without a restart).
    hostStatus: asFunction(
      ({ sessionHosts, hostBins: bins }) =>
        () =>
          hostStatus(
            sessionHosts.filter((h: HostDescriptor) => h.interactive),
            bins,
            commandExists,
          ),
    ).singleton(),
    // The agent a new chat opens with: the conversation agent where the repository has it (ADR-0093).
    chatAgent: asFunction(
      ({ fileSystem }) =>
        () =>
          chatAgentIn(fileSystem, HOSTS),
    ).singleton(),
    // What the daemon types into panes, kept for the hosts' user-prompt hooks (ADR-0093, ADR-0094).
    paneTyped: asFunction(({ fileSystem, clock }) => new PaneTyped(fileSystem, clock)).singleton(),
    // What a host's CLI says its version is (`claude --version`): never a real host's where none may start.
    hostVersion: asFunction(({ processRunner, hostBins: bins, root }) => async (host: string) => {
      const descriptor = HOSTS.find((h) => h.id === host);
      if (!descriptor?.program) return undefined;
      if (options.noRealHosts && realHostRefusal(descriptor, bins, "interactive")) return undefined;
      const command = hostCommand(descriptor, bins);
      if (command === undefined || !commandExists(command)) return undefined;
      const ran = await processRunner.run({ argv: [command, "--version"], cwd: root }, { timeoutMs: 15_000 });
      return ran.exitCode === 0 ? cliVersionOf(`${ran.stdout}\n${ran.stderr}`) : undefined;
    }).singleton(),
    // The host conformance suite (ADR-0098): its kept runs for `doctor`, and a run of it.
    conformanceHistory: asFunction(
      ({ fileSystem, hostVersion }) => new ConformanceHistory(fileSystem, hostVersion),
    ).singleton(),
    runHostConformance: asFunction(
      ({ clock, timer, sessionHosts, hostBins: bins, hostVersion, root }) =>
        new RunHostConformance({
          lab: options.conformanceLab?.({ root }) ?? NO_LAB,
          clock,
          timer,
          nonce: conformanceWord,
          metatorVersion: METATOR_VERSION,
          hosts: sessionHosts.filter((h: HostDescriptor) => h.interactive).map((h: HostDescriptor) => h.id),
          refusal: (host) => {
            const descriptor = HOSTS.find((h) => h.id === host);
            return options.noRealHosts && descriptor
              ? realHostRefusal(descriptor, bins, "interactive")
              : undefined;
          },
          version: hostVersion,
          // The same answer `metator doctor` gives (isolation): what this machine lacks for a sandbox.
          sandboxUnavailable: async () =>
            sandboxUnavailable(
              process.platform,
              LINUX_SANDBOX_PROGRAMS.filter((program) => !onPath(program)),
            ),
          // The last report of the same host and version, which a run with --only keeps whole.
          kept: async (out, name) => {
            try {
              return readFileSync(join(isAbsolute(out) ? out : join(root, out), name), "utf8");
            } catch {
              return undefined;
            }
          },
        }),
    ),
    // Why the guard asked about a pane's command: the hook writes it, the daemon's cards read it.
    guardAsked: asFunction(({ fileSystem, clock }) => new GuardAsked(fileSystem, clock)).singleton(),
    ptyBroker: asFunction(
      ({ runRepository, runJournal, config, clock, screenRenderer, paneTyped }) =>
        new PtyBroker({
          typed: (paneId, text, by) => paneTyped.record(paneId, text, by),
          repo: runRepository,
          journal: runJournal,
          idleMs: config.config.supervisor.idleThresholdMs,
          clock,
          screens: screenRenderer,
        }),
    ).singleton(),
    hostManifests: asFunction(({ fileSystem }) => new HostManifestCatalog(fileSystem)).singleton(),
    // Who each pane is in its run: a worker's question is the worker's, never the conductor's.
    paneIdentity: asFunction(
      ({ layoutStore, runRepository }) => new LayoutPaneIdentity(layoutStore, runRepository),
    ).singleton(),
    paneSensor: asFunction(
      ({ ptyBroker, hostManifests, runJournal, clock, paneIdentity }) =>
        new PaneSensor({
          broker: ptyBroker,
          manifests: hostManifests,
          journal: runJournal,
          clock,
          identity: paneIdentity,
        }),
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
    // One per daemon: the panes' open prompts are the same for its check and for an answer.
    openPrompts: asFunction(() => new Map()).singleton(),
    // The questions of panes without a run (the intake chat), while the daemon runs (ADR-0091).
    paneQuestions: asFunction(({ clock }) => new PaneQuestions(clock)).singleton(),
    hostPrompts: asFunction(
      ({
        paneSensor,
        runJournal,
        driverLock,
        notifier,
        paneIdentity,
        ptyBroker,
        runRepository,
        openPrompts,
        paneQuestions,
        guardAsked,
      }) =>
        new HostPrompts({
          panes: paneQuestions,
          guardReason: async (paneId, command) => (await guardAsked.reasonFor(paneId, command))?.reason,
          rendered: (paneId) => ptyBroker.screen(paneId),
          sensor: paneSensor,
          journal: runJournal,
          lock: driverLock,
          notify: notifier,
          identity: paneIdentity,
          open: openPrompts,
          // A person's answer to an agent's terminal question, typed for them (never over a person).
          // As the person who holds the run's keyboard when it is theirs (their own keystrokes).
          type: async (paneId, text, by) => {
            // Typed by the daemon for the person: their words for the session (a consent when
            // they say so), and not them talking to the session directly.
            if (by) await ptyBroker.typedFor(paneId, text);
            return by
              ? ptyBroker.write({ paneId, data: `${text}\r`, by })
              : (await ptyBroker.nudge(paneId, text, "answer")).map(() => undefined);
          },
          screen: (paneId) => ptyBroker.backlog(paneId),
          holder: async (runId) => {
            const record = await runRepository.load(runId);
            return record.isOk() && record.value.driver?.by === "human"
              ? record.value.driver.attachedBy
              : undefined;
          },
        }),
    ),
    layoutStore: asFunction(({ fileSystem }) => new LayoutStore(fileSystem)).singleton(),
    issues: asFunction(
      ({ fileSystem, paths, clock, runJournal, runRepository, initRun, startRun, optionStore, fileLock }) =>
        new Issues({
          lock: fileLock,
          fs: fileSystem,
          paths,
          clock,
          journal: runJournal,
          repo: runRepository,
          initRun,
          startRun,
          proposalsAllowed: async () => {
            const o = await optionStore.get("issues.proposeFromAgents");
            return o.isOk() ? o.value.value !== false : true;
          },
        }),
    ),
    // Analysis and plan in the Backlog (ADR-0096): snapshots judged from file hashes and the commit.
    contentHasher: asFunction(() => new NodeContentHasher()).singleton(),
    issueSnapshots: asFunction(
      ({ fileSystem, contentHasher, git, workspaceReader, clock, optionStore }) =>
        new IssueSnapshots({
          fs: fileSystem,
          hasher: contentHasher,
          vcs: git,
          head: async () =>
            (await git.branch("HEAD")).map((b: { readonly head: string | null }) => b.head ?? undefined),
          workspace: workspaceReader,
          clock,
          staleDays: async () => {
            const o = await optionStore.get("backlog.staleDays");
            return o.isOk() && typeof o.value.value === "number" ? o.value.value : 14;
          },
        }),
    ),
    backlogWork: asFunction(
      ({
        issues,
        issueSnapshots,
        fileSystem,
        paths,
        runRepository,
        systemPlanStore,
        startSystemStep,
        threads,
        graphQueries,
        findSimilar,
        panes,
        clock,
      }) =>
        new BacklogWork({
          issues,
          snapshots: issueSnapshots,
          fs: fileSystem,
          dir: paths.issues,
          runs: runRepository,
          systemPlans: systemPlanStore,
          steps: startSystemStep,
          threads,
          facts: {
            dependents: (file) => graphQueries.dependents(file, true),
            similar: (file) => findSimilar.execute({ target: file, top: 1 }),
          },
          panes,
          clock,
        }),
    ),
    mcpToolCaller: asFunction(({ root }) => new SdkToolCaller(root)),
    codeHost: asFunction(
      ({ optionStore, mcpToolCaller }) => new McpCodeHost(() => optionStore.mcp(), mcpToolCaller),
    ),
    mcpReviewHost: asFunction(
      ({ optionStore, mcpToolCaller }) => new McpReviewHost(() => optionStore.mcp(), mcpToolCaller),
    ),
    // GitHub through `gh` and its own login (ADR-0097); never a real one while real hosts are refused.
    ghReviewHost: asFunction(
      ({ processRunner, root }) =>
        new GhReviewHost(processRunner, { command: options.ghBin ?? "gh", cwd: root }),
    ).singleton(),
    ghReady: asFunction(
      ({ ghReviewHost }) =>
        async () =>
          (await ghReviewHost.status({ standIn: options.noRealHosts === true })).ready,
    ),
    reviewHost: asFunction(
      ({ config, mcpReviewHost, ghReviewHost }) =>
        new RoutedReviewHost(config.config.codehost.sources, { mcp: mcpReviewHost, gh: ghReviewHost }),
    ),
    watchedReviews: asFunction(
      ({
        config,
        fileSystem,
        paths,
        clock,
        mcpReviewHost,
        ghReviewHost,
        optionStore,
        ghReady,
        git,
        startRun,
        runRepository,
        threads,
        fileLock,
      }) =>
        new WatchedReviews({
          // The CLI and the daemon both write a review's file: one writer at a time, across processes.
          lock: fileLock,
          fs: fileSystem,
          dir: paths.reviews,
          clock,
          codehost: config.config.codehost,
          hosts: { mcp: mcpReviewHost, gh: ghReviewHost },
          servers: async () => {
            const servers = await optionStore.mcp();
            return servers.isOk() ? Object.keys(servers.value) : [];
          },
          ghReady,
          remote: async () => {
            const url = await git.remoteUrl();
            return url.isOk() ? url.value : undefined;
          },
          fetchRef: (ref, branch) => git.fetchRef(ref, branch),
          start: startRun,
          runs: runRepository,
          threads,
        }),
    ),
    myReviews: asFunction(
      ({ config, fileSystem, paths, clock, reviewHost, initRun, runRepository, notifier, panes, threads }) =>
        new MyReviews({
          notifier,
          config: { ...config.config.reviews, sources: reviewSourcesOf(config.config.codehost) },
          analyse: config.config.codehost.mine.analyse,
          panes,
          threads,
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
          config: resolveIntake(config.config.intake, config.config.codehost.sources),
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
      ({ fileSystem, runRepository, runJournal, workflowCatalog, conductor, paths, systemPlans }) =>
        new PlanBoard({
          fs: fileSystem,
          repo: runRepository,
          journal: runJournal,
          catalog: workflowCatalog,
          conductor,
          paths,
          systemPlans,
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
    // This repository as "Continue" of a task reaches it (ADR-0092): the daemon puts every served
    // repository's together and continues the task across them.
    taskRepository: asFunction(
      ({ panes, runRepository, runDrivers, ensureDriven, conductor, runJournal }): TaskRepository => ({
        runs: runRepository,
        panes,
        drivers: runDrivers,
        ensureDriven,
        conductor,
        journal: runJournal,
      }),
    ),
    // The chat a task was given in learns when it is done, stops, or waits for an approval (ADR-0092).
    chatNotices: asFunction(
      ({ panes, runRepository, runJournal, paneSensor, ptyBroker }) =>
        new ChatNotices({
          panes,
          repo: runRepository,
          journal: runJournal,
          sensor: paneSensor,
          // The supervisor's nudge: the words, then Enter as its own write.
          nudge: (paneId, text) => ptyBroker.nudge(paneId, text),
        }),
    ),
    // Lines for agents' sessions that wait until the agent is idle, and steering a task's
    // sessions from its main chat (ADR-0093). One mail per repository: its file has one writer.
    paneMail: asFunction(
      ({ fileSystem, clock, panes, paneSensor, paneQuestions, ptyBroker, runJournal }) =>
        new PaneMail({
          fs: fileSystem,
          clock,
          panes,
          sensor: paneSensor,
          asksInPane: (paneId) => paneQuestions.waiting(paneId),
          nudge: (paneId, text) => ptyBroker.nudge(paneId, text),
          journal: runJournal,
        }),
    ).singleton(),
    // Threads (ADR-0095): one per topic with its chat terminal; one per repository, kept with its layout.
    threads: asFunction(
      ({ fileSystem, fileLock, panes, runRepository, runJournal, paneMail, chatAgent, clock }) =>
        new Threads({
          store: new ThreadStore(fileSystem, fileLock),
          panes,
          runs: runRepository,
          journal: runJournal,
          mail: paneMail,
          chatAgent,
          clock,
        }),
    ).singleton(),
    sessionSteering: asFunction(
      ({ panes, runRepository, paneMail, ptyBroker, runJournal, root, paneSensor, paneTyped }) =>
        new SessionSteering({
          panes,
          repo: runRepository,
          mail: paneMail,
          interrupt: (paneId, text) => ptyBroker.interrupt(paneId, text),
          journal: runJournal,
          repoName: basename(root),
          typedByDaemon: async (paneId, text) => (await paneTyped.by(paneId, text)) !== undefined,
          sensor: paneSensor,
        }),
    ),
    // A session the daemon resumed is told, once, to go on (ADR-0092).
    resumeNotices: asFunction(
      ({ panes, runRepository, runJournal, paneSensor, ptyBroker, paneQuestions }) =>
        new ResumeNotices({
          asksInPane: (paneId) => paneQuestions.waiting(paneId),
          panes,
          sensor: paneSensor,
          repo: runRepository,
          journal: runJournal,
          nudge: (paneId, text) => ptyBroker.nudge(paneId, text),
        }),
    ),
    continueTask: asValue((repos: () => readonly TaskRepository[]) => new ContinueTask(repos)),
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
        fileSystem,
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
          fs: fileSystem,
        }),
    ).singleton(),
    // The supervisor needs a way to start a drive again, which only the CLI process knows (its own
    // argv). Not a singleton (its drivers are not): the caller keeps the one instance it ticks.
    supervisor: asFunction(
      ({
        config,
        runRepository,
        runDrivers,
        runJournal,
        ptyBroker,
        workOverview,
        hostPrompts,
        panes,
        paneQuestions,
      }) =>
        (restart: SupervisorDependencies["restart"]) =>
          new Supervisor({
            asksInPane: (paneId) => paneQuestions.waiting(paneId),
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
        checkoutReader,
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
          notes: (cwd) => workNotes(checkoutReader, cwd),
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
    workingTree: asFunction(
      ({ processRunner, root }) => new GitWorkingTree(processRunner, root, OWN_STATE),
    ).singleton(),
    // Scratch (ADR-0093): direct edits not meant for a commit, as patches that can be taken out again.
    workingPatches: asFunction(
      ({ processRunner, root }) => new GitWorkingPatches(processRunner, root, OWN_STATE),
    ).singleton(),
    scratch: asFunction(
      ({ fileSystem, clock, workingPatches }) =>
        new Scratch({ fs: fileSystem, clock, patches: workingPatches }),
    ),
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
    // Rule engines and the declaration emitter run a tool from PATH where a project's dependencies
    // are not installed (a fresh worktree still checks its rules); gate steps do not (`binResolver`).
    toolBins: asFunction(({ root }) => new NodeBinResolver(root, "path")).singleton(),
    // The JavaScript workspace's packages, then the Java build's modules (ADR-0107).
    workspaceReader: asFunction(
      ({ root, javaBuild }) =>
        new MergedWorkspace([new ManypkgWorkspaceReader(root), new JavaWorkspace(javaBuild)]),
    ).singleton(),
    toolBoundariesReader: asFunction(({ root }) => new JsonToolBoundariesReader(root)).singleton(),
    manifestReader: asFunction(
      ({ root, workspaceReader }) => new ManypkgManifestReader(root, workspaceReader),
    ).singleton(),
    // One oxc analyzer behind both ports: one set of resolvers and tsconfig lookups.
    oxc: asFunction(({ root }) => new OxcImportAnalyzer(root)).singleton(),
    // Each file goes to its language's analyzer: TypeScript/JavaScript (oxc) and Java (ADR-0107).
    analyzers: asFunction(({ oxc, root }) => {
      const java = new JavaImportAnalyzer(root);
      return new AnalyzerByExtension([
        { imports: oxc, symbols: oxc },
        { imports: java, symbols: java },
      ]);
    }).singleton(),
    importAnalyzer: asFunction(({ analyzers }) => analyzers).singleton(),
    symbolAnalyzer: asFunction(({ analyzers }) => analyzers).singleton(),
    javaBuild: asFunction(({ root }) => new JavaBuildFiles(root)).singleton(),
    javaParser: asFunction(() => {
      const grammar: JavaGrammarFiles | undefined = options.installation?.javaGrammar;
      return grammar ? new TreeSitterJavaParser(() => grammar) : new TreeSitterJavaParser();
    }).singleton(),
    readJava: asFunction(
      ({ sourceFiles, fileSystem, javaBuild, javaParser, contentHasher, clock, paths }) =>
        new ReadJava(
          sourceFiles,
          fileSystem,
          javaBuild,
          javaParser,
          new JavaDescriptors(),
          contentHasher,
          clock,
          paths,
        ),
    ).singleton(),
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
          analyzersId([OxcImportAnalyzer.id, JavaImportAnalyzer.id]),
        ),
    ).singleton(),
    importGraphReader: asFunction(({ buildImportGraph }) => new IndexedImportGraphReader(buildImportGraph)),
    graphQueries: asFunction(({ buildImportGraph }) => new GraphQueries(buildImportGraph)),
    ruleEngines: asFunction(({ processRunner, root, toolBins }) => [
      new AstGrepEngine(processRunner, root, toolBins),
      new BiomeEngine(processRunner, root, toolBins),
      new TscEngine(processRunner, root, toolBins),
      new BunTestEngine(
        processRunner,
        root,
        undefined,
        options.installation?.beBun ? { BUN_BE_BUN: "1" } : undefined,
      ),
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
    declarationEmitter: asFunction(
      ({ processRunner, root, toolBins }) => new TscDeclarationEmitter(processRunner, root, toolBins),
    ).singleton(),
    apiSnapshots: asFunction(
      ({ declarationEmitter, workspaceReader, fileSystem, paths }) =>
        new ApiSnapshots(declarationEmitter, workspaceReader, fileSystem, paths),
    ),
    coverageReader: asFunction(({ root }) => new LcovCoverageReader(root)).singleton(),
    diffCoverage: asFunction(
      ({ revisionReader, coverageReader, testGlobs }) =>
        new DiffCoverage(revisionReader, coverageReader, testGlobs),
    ),
    checkFlaky: asFunction(
      ({ packageManager, processRunner }) => new CheckFlaky(packageManager, processRunner),
    ),
    checkDebugTags: asFunction(
      ({ vcs, fileSystem, sourceIgnores }) => new CheckDebugTags(vcs, fileSystem, sourceIgnores),
    ),
    checkQuote: asFunction(({ fileSystem }) => new CheckQuote(fileSystem)),
    findOwners: asFunction(({ fileSystem }) => new FindOwners(fileSystem)),
    // Contract kinds the installed plugins provide (ADR-0047): the ones a differ compares.
    contractKinds: asFunction(({ contractDiffers }) =>
      contractDiffers.map((d: ContractDiffer) => d.kind),
    ).singleton(),
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
      ({ config, root, systemLocation, cloneCache, checkoutReader, vcs, optionStore }) =>
        new SystemSources(
          config.config.system,
          root,
          systemLocation,
          cloneCache,
          checkoutReader,
          vcs,
          // The directories the person set where the applications' checkouts are (`system.roots`).
          async () => {
            const o = await optionStore.get("system.roots");
            return o.isOk() && Array.isArray(o.value.value) ? (o.value.value as string[]) : [];
          },
        ),
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
    plannedBreakingChanges: asFunction(({ systemPlanStore }) => new PlannedBreakingChanges(systemPlanStore)),
    diffContracts: asFunction(
      ({ systemSources, revisionReader, fileSystem, contractDiffers, plannedBreakingChanges }) =>
        new DiffContracts(systemSources, revisionReader, fileSystem, contractDiffers, plannedBreakingChanges),
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
      return { start: there.resolve("startRun"), runs: there.resolve("runRepository") };
    }),
    runSystemPlan: asFunction(
      ({ systemPlanStore, systemSources, repositoryRuns, clock, runRepository }) =>
        new RunSystemPlan(systemPlanStore, systemSources, repositoryRuns, clock, runRepository),
    ),
    systemPlanStatus: asFunction(
      ({ systemPlanStore, systemSources, repositoryRuns }) =>
        new SystemPlanStatus(systemPlanStore, systemSources, repositoryRuns),
    ),
    retrySystemStep: asFunction(
      ({ systemPlanStore, systemSources, repositoryRuns, clock }) =>
        new RetrySystemStep(systemPlanStore, systemSources, repositoryRuns, clock),
    ),
    startSystemStep: asFunction(
      ({ systemPlanStore, systemSources, repositoryRuns, clock, runRepository }) =>
        new StartSystemStep(systemPlanStore, systemSources, repositoryRuns, clock, runRepository),
    ),
    systemRunGate: asFunction(
      ({ systemPlanStatus, runRepository, clock, runSystemPlan }) =>
        new SystemRunGate(systemPlanStatus, runRepository, clock, runSystemPlan),
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
          () => agentDefinitionFiles(fileSystem, HOSTS, ["mt-system-scout", "mt-system-planner"]),
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
        styleImports,
      }) =>
        new ArchitectureFacts(buildImportGraph, manifestReader, architecturePolicyCatalog, clock, {
          symbols: symbolQueries,
          history: changeHistory,
          owners: findOwners,
          styles: styleImports,
        }),
    ),
    styleImports: asFunction(({ sourceFiles, fileSystem }) => new StyleImports(sourceFiles, fileSystem)),
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
          () => agentDefinitionFiles(fileSystem, HOSTS, ["mt-arch-planner"]),
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
    // A person edits plans in the app (ADR-0087): the run's plan, system plans, the map; reads run files.
    runPlans: asFunction(
      ({ fileSystem, runRepository, runJournal, workflowCatalog, lintPlan, scopePlan }) =>
        new RunPlans({
          fs: fileSystem,
          repo: runRepository,
          journal: runJournal,
          catalog: workflowCatalog,
          lint: lintPlan,
          scope: scopePlan,
        }),
    ),
    systemPlans: asFunction(
      ({
        fileSystem,
        systemPlanStore,
        lintSystemPlan,
        approveSystemPlan,
        systemSources,
        repositoryRuns,
        clock,
      }) =>
        new SystemPlans({
          fs: fileSystem,
          store: systemPlanStore,
          lint: lintSystemPlan,
          approve: approveSystemPlan,
          sources: systemSources,
          at: repositoryRuns,
          clock,
        }),
    ),
    systemMaps: asFunction(
      ({
        fileSystem,
        systemLocation,
        contractKinds,
        systemSources,
        discoverSystem,
        discoverySource,
        root,
        clock,
      }) =>
        new SystemMaps({
          fs: fileSystem,
          location: systemLocation,
          kinds: contractKinds,
          roots: () => checkoutRoots(systemSources),
          discover: discoverSystem,
          here: discoverySource,
          sourceAt: (at: string) =>
            at === root ? discoverySource : elsewhere(at).resolve("discoverySource"),
          system: basename(root),
          clock,
        }),
    ),
    fileStats: asFunction(({ root }: { root: string }) => new BunFileStats(root)).singleton(),
    runArtifacts: asFunction(
      ({ fileSystem, fileStats, runRepository, workflowCatalog }) =>
        new RunArtifacts({ fs: fileSystem, stats: fileStats, repo: runRepository, catalog: workflowCatalog }),
    ),
    checkPlanStep: asFunction(
      ({ fileSystem, runAffectedTests, clock }) => new CheckPlanStep(fileSystem, runAffectedTests, clock),
    ),
    planProgress: asFunction(({ fileSystem }) => new PlanProgress(fileSystem)),
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
      ({ fileSystem, sourceFiles, vcs, workspaceReader, packageManagerDetector, paths, javaBuild }) =>
        new Discover(fileSystem, sourceFiles, vcs, workspaceReader, packageManagerDetector, paths, javaBuild),
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
      ({
        config,
        packageManager,
        binResolver,
        processRunner,
        gateChecks,
        vcs,
        fileSystem,
        paths,
        clock,
        javaBuild,
      }) =>
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
          javaBuild,
          () => process.platform,
        ),
    ),
    installCanon: asFunction(
      ({ fileSystem, paths }) => new InstallCanon(resolveCanon(options.canon), fileSystem, paths),
    ),
    initProject: asFunction(
      ({ discover, fileSystem, paths }) => new InitProject(discover, fileSystem, paths),
    ),
    hostGenerators: asValue(HOSTS.flatMap((h) => (h.files ? [h.files.generator()] : []))),
    skillGenerators: asValue(HOSTS.flatMap((h) => (h.files ? [h.files.skills()] : []))),
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
    machineState: asFunction(() => new BunMachineState(options.stateDir ?? machineStateDir({}))).singleton(),
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
    // A run moved into a human gate gets its question, whoever moved it (a drive, a conductor, a person).
    gateQuestions: asFunction(
      ({ workflowCatalog, runRepository, runJournal, fileSystem, paths }) =>
        new GateQuestions({
          catalog: workflowCatalog,
          repo: runRepository,
          journal: runJournal,
          fs: fileSystem,
          gatesDir: paths.gates,
        }),
    ),
    // The plan a planner is sent back to revise is kept as its previous version (shown with what changed).
    planRevisions: asFunction(
      ({ fileSystem, runRepository, workflowCatalog, clock, systemPlanStore }) =>
        new PlanRevisions({
          fs: fileSystem,
          repo: runRepository,
          catalog: workflowCatalog,
          clock,
          systemPlans: {
            file: (id: string) => systemPlanStore.file(id),
            load: async (id: string) =>
              (await systemPlanStore.exists(id)) ? systemPlanStore.load(id) : ok(undefined),
          },
        }),
    ),
    advanceRun: asFunction(
      ({ workflowCatalog, runRepository, clock, runJournal, gateQuestions, planRevisions }) =>
        new AdvanceRun(workflowCatalog, runRepository, clock, runJournal, gateQuestions, planRevisions, {
          // Resolved when a run stops planned: the Backlog it hands its plan to is built then (ADR-0096).
          planned: (runId) => c.resolve("backlogWork").planned(runId),
        }),
    ),
    // A system run's plan-approval approves its system plan too (F7.5); a plan with lint errors
    // refuses the approval, at a terminal (`run approve`) as on a card.
    systemPlanApprovals: asFunction(
      ({ runRepository, workflowCatalog, systemPlanStore, lintSystemPlan, approveSystemPlan }) =>
        new SystemPlanApprovals(
          runRepository,
          workflowCatalog,
          systemPlanStore,
          lintSystemPlan,
          approveSystemPlan,
        ),
    ),
    // What a gate's card and answer refuse: the system plan's rule, and the gate of a run's own
    // plan while the plan has lint errors (a person at a terminal can still `run approve` it).
    gateApprovals: asFunction(
      ({ systemPlanApprovals, runRepository, workflowCatalog, fileSystem, lintPlan }) =>
        new AllGateApprovals([
          systemPlanApprovals,
          new RunPlanApprovals({
            fs: fileSystem,
            repo: runRepository,
            catalog: workflowCatalog,
            lint: lintPlan,
          }),
        ]),
    ),
    approveRun: asFunction(
      ({ advanceRun, runRepository, clock, workflowCatalog, systemPlanApprovals }) =>
        new ApproveRun(advanceRun, runRepository, clock, workflowCatalog, systemPlanApprovals),
    ),
    // The person's consents to guarded commands (ADR-0094): written by their words, used once.
    guardConsents: asFunction(({ fileSystem, clock }) => new GuardConsents(fileSystem, clock)),
    guardPreTool: asFunction(
      ({
        getRunStatus,
        runRepository,
        agentCatalog,
        fileSystem,
        root,
        role,
        config,
        guardConsents,
        scratch,
      }) =>
        new GuardPreTool(getRunStatus, runRepository, agentCatalog, fileSystem, root, role, {
          guard: config.config.guard,
          consents: guardConsents,
          // A commit that would hold debug changes is stopped; when git cannot say, nothing is claimed.
          debugFiles: async (reach) => {
            const files = await scratch.inCommit(reach);
            return files.isOk() ? files.value : [];
          },
          // What needs no approval prompt (`guard.prompts: metator`) is judged from the same
          // config: how the repository runs MetatorAI, and what its gates run.
          prompts: {
            metatorCommand: config.config.hosts.metatorCommand,
            gates: [...config.config.gates.quick, ...config.config.gates.full].map((s) => s.run),
          },
        }),
    ),
    guardUserPrompt: asFunction(
      ({ guardConsents, config }) => new GuardUserPrompt(guardConsents, config.config.guard),
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
      ({ workflowCatalog, runRepository, clock, gateQuestions, runJournal }) =>
        new ResumeRun(workflowCatalog, runRepository, clock, gateQuestions, runJournal),
    ),
    writeRunArtifact: asFunction(
      ({ workflowCatalog, runRepository, fileSystem }) =>
        new WriteRunArtifact(workflowCatalog, runRepository, fileSystem),
    ),
    readRunArtifact: asFunction(
      ({ runRepository, fileSystem, root }) =>
        new ReadRunArtifact(runRepository, fileSystem, (dir, file) => {
          // Links followed: a link in the run directory that points elsewhere is not inside it.
          try {
            const within = realpathSync(join(root, dir));
            return realpathSync(join(root, file)).startsWith(`${within}${sep}`);
          } catch {
            return false;
          }
        }),
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
    // What a person does to a run, once for every front (the commands, the daemon).
    detachedDrive: asFunction(
      ({ runDrivers, root }): DetachedDrive =>
        options.detachedDrive?.({ runDrivers, root }) ?? {
          start: async () =>
            err(new MetatorError("COMMAND_FAILED", "this program cannot start a drive in the background")),
        },
    ),
    runPanes: asFunction(({ panes, root }): RunPanes => options.runPanes?.({ panes, root }) ?? panes),
    // The team's order first (`supervisor.hostOrder`): a run nobody chose a host for (intake, a
    // system run's child) takes the host the team works with.
    defaultDriveHost: asFunction(
      ({ agentHosts, config, driveHostProblem }) =>
        () =>
          driveHostOf({
            chosen: options.defaultHost,
            order: config.config.supervisor.hostOrder,
            targets: config.config.hosts.targets,
            known: [...agentHosts.keys()],
            problem: driveHostProblem,
          }),
    ),
    startDrive: asFunction(
      ({ runRepository, agentHosts, driveHostProblem, detachedDrive }) =>
        new StartDrive(runRepository, agentHosts, driveHostProblem, detachedDrive),
    ),
    ensureDriven: asFunction(
      ({ runRepository, runDrivers, agentHosts, defaultDriveHost, startDrive }) =>
        new EnsureDriven(runRepository, runDrivers, agentHosts, defaultDriveHost, startDrive),
    ),
    startRun: asFunction(
      ({
        initRun,
        setupWorktree,
        checkReadiness,
        workOverview,
        ensureDriven,
        config,
        root,
        hostStatus,
        runJournal,
      }) =>
        new StartRun(
          initRun,
          setupWorktree,
          checkReadiness,
          workOverview,
          ensureDriven,
          config.config.supervisor.wipLimit,
          options.conductorSessions
            ? { sessions: options.conductorSessions({ root }), hosts: hostStatus, journal: runJournal }
            : undefined,
        ),
    ),
    // The quick way (ADR-0093): is a change small enough, and the run that carries it.
    quickCheck: asFunction(
      ({
        config,
        testGlobs,
        vcs,
        changePatch,
        workspaceReader,
        graphQueries,
        systemImpactQuery,
        fileSystem,
        apiSnapshots,
      }) =>
        new QuickCheck({
          limits: config.config.quick,
          testGlobs,
          vcs,
          patch: changePatch,
          workspace: workspaceReader,
          graph: graphQueries,
          impact: systemImpactQuery,
          exists: (file) => fileSystem.exists(file),
          // Only a package with a snapshot is compared (`metator api snapshot`): without one, its entry module says it.
          apiChanged: async (pkg) => {
            const diff = await apiSnapshots.diff({ package: pkg });
            return diff.isOk() ? diff.value.changed : undefined;
          },
        }),
    ),
    quickOverrides: asFunction(
      ({ fileSystem, runRepository, runJournal, clock }) =>
        new QuickOverrides(fileSystem, runRepository, runJournal, clock),
    ),
    quickStart: asFunction(
      ({ startRun, runRepository, runJournal, quickOverrides, workingTree, config }) =>
        new QuickStart({
          quickGate: { steps: config.config.gates.quick.length, source: config.source },
          start: startRun,
          repo: runRepository,
          journal: runJournal,
          overrides: quickOverrides,
          tree: workingTree,
        }),
    ),
    quickFit: asFunction(
      ({ startRun, runRepository, runJournal, quickOverrides, workingTree, closeRun, worktreeRegistry }) =>
        new QuickFit({
          adopted: (worktree, run) =>
            worktreeRegistry.update((all: readonly WorktreeEntry[]) =>
              all.map((e) => (e.id === worktree ? { ...e, run } : e)),
            ),
          start: startRun,
          repo: runRepository,
          journal: runJournal,
          overrides: quickOverrides,
          tree: workingTree,
          close: closeRun,
        }),
    ),
    quickReviewed: asFunction(
      ({ runRepository, fileSystem }) => new QuickReviewed({ repo: runRepository, fs: fileSystem }),
    ),
    quickReady: asFunction(
      ({ runRepository, runJournal, advanceRun, runDrivers }) =>
        new QuickReady({
          repo: runRepository,
          journal: runJournal,
          advance: advanceRun,
          driven: async (runId) => {
            const driver = await runDrivers.status(runId);
            return driver.isOk() && driver.value?.alive === true;
          },
        }),
    ),
    answerQuestion: asFunction(
      ({
        runRepository,
        runJournal,
        answerPolicyStore,
        runDrivers,
        ensureDriven,
        clock,
        ptyBroker,
        approveRun,
        advanceRun,
        gateApprovals,
        hostPrompts,
      }) =>
        new AnswerQuestion(
          runRepository,
          runJournal,
          answerPolicyStore,
          runDrivers,
          ensureDriven,
          clock,
          (runId) => ptyBroker.byRun(runId).some((s: { readonly alive: boolean }) => s.alive),
          // A human gate's question decides the gate, whoever drives the run.
          {
            approve: approveRun,
            advance: advanceRun,
            refusal: (runId: string, stage: string) => gateApprovals.refusal(runId, stage),
          },
          hostPrompts,
        ),
    ),
    askInRun: asFunction(
      ({ runRepository, runJournal, timer }) => new AskInRun(runRepository, runJournal, timer),
    ),
    briefRun: asFunction(({ runRepository, runJournal }) => new BriefRun(runRepository, runJournal)),
    reviveRuns: asFunction(
      ({ runRepository, runDrivers, runJournal, ensureDriven }) =>
        new ReviveRuns(runRepository, runDrivers, runJournal, ensureDriven),
    ),
    // `metator setup` as typed calls; the steps after the config is written read it again.
    setupRepository: asFunction(
      ({ config, paths, fileSystem, launcher, installCanon, initProject, updateConfig }) =>
        new SetupRepository({
          config: { source: config.source, hosts: config.config.hosts.targets },
          installLock: paths.installLock,
          fs: fileSystem,
          hostsOnPath: () => {
            const found = launcher.available(HOST_TARGETS);
            return HOST_TARGETS.filter((h) => found.includes(h));
          },
          installCanon,
          initProject,
          updateConfig,
          configured: () =>
            loadConfig(options.root).map((now) => {
              const fresh = bootstrap({ ...options, config: now });
              return {
                installCanon: fresh.resolve("installCanon"),
                generateHosts: fresh.resolve("generateHosts"),
                generateSkills: fresh.resolve("generateSkills"),
                lintAgents: fresh.resolve("lintAgents"),
                lintSkills: fresh.resolve("lintSkills"),
                lintWorkflows: fresh.resolve("lintWorkflows"),
              };
            }),
        }),
    ),
    endRun: asFunction(
      ({ closeRun, runRepository, runPanes, removeWorktree }) =>
        new EndRun(closeRun, runRepository, runPanes, removeWorktree),
    ),
    getRunStatus: asFunction(
      ({ workflowCatalog, runRepository }) => new GetRunStatus(workflowCatalog, runRepository),
    ),
    listRuns: asFunction(({ runRepository }) => new ListRuns(runRepository)),
  });
  return c;
}
