import { existsSync } from "node:fs";
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
  CheckArchitecture,
  CheckDebugTags,
  CheckFlaky,
  CheckMemory,
  CheckpointRun,
  CheckQuote,
  CheckRules,
  type Clock,
  CloneCache,
  CloseRun,
  CompareEvals,
  ComputeAffected,
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
  EnvironmentCatalog,
  EnvironmentServices,
  EvalCatalog,
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
  IndexedImportGraphReader,
  InitArchitecturePolicy,
  InitEnvironment,
  InitProject,
  InitRun,
  InstallCanon,
  InventoryMemory,
  JudgeFindings,
  KnowledgeFiles,
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
  type MetatorPaths,
  PackRules,
  PatternCatalog,
  PinnedSystemLocation,
  PlannedBreakingChanges,
  PlanReview,
  ProposeRefactorPlan,
  ProposeSystemPlan,
  ProvideWorktree,
  PruneWorktrees,
  RecordArchitectureBaseline,
  RefactorPlanStore,
  RemoveWorktree,
  RepositoryDiscoverySource,
  type RepositoryRuns,
  ResumeRun,
  RuleCatalog,
  RunAffectedTests,
  RunArchEvals,
  RunDrivers,
  RunEvals,
  RunGate,
  RunJournal,
  RunRefactorPlan,
  RunRepository,
  RunSystemEvals,
  RunSystemPlan,
  ScaffoldRule,
  ScanPatterns,
  ScopePlan,
  ScoreEvals,
  ShowChangeDiff,
  ShowSystem,
  SimulateArchitecture,
  SimulateRefactorPlan,
  SkillCatalog,
  SourceFiles,
  StyleImports,
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
  WorktreeRegistry,
  WriteRunArtifact,
} from "@metator/core";
import {
  BunBackgroundProcess,
  BunCheckoutReader,
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
import { DockerComposeRuntime } from "@metator/plugin-docker";
import { GitRepositoryCloner, GitVcs, GitWorktreeManager } from "@metator/plugin-git";
import { ClaudeAgentHost, ClaudeGenerator, ClaudeSkillGenerator } from "@metator/plugin-host-claude";
import { CopilotAgentHost, CopilotGenerator, CopilotSkillGenerator } from "@metator/plugin-host-copilot";
import { ScenarioAgentHost } from "@metator/plugin-host-scenario";
import {
  GetPortProbe,
  JsonToolBoundariesReader,
  LcovCoverageReader,
  ManypkgManifestReader,
  ManypkgWorkspaceReader,
  NodePackageManager,
  WaitOnHealthProbe,
} from "@metator/plugin-node";
import { OpenApiContractDetector, OpenApiContractDiffer } from "@metator/plugin-openapi";
import { OxcImportAnalyzer, TscDeclarationEmitter, TscEngine } from "@metator/plugin-typescript";
import { asFunction, asValue } from "awilix";
import { resolveCanon } from "./canon.ts";
import { type LoadedConfig, loadConfig, resolvePaths } from "./config.ts";
import { createMetatorContainer, type MetatorContainer } from "./container.ts";

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
  /** The Docker CLI (METATOR_DOCKER_BIN); default `docker` on PATH. */
  readonly dockerBin?: string;
  /** Machine-wide state shared by every repository (`machineStateDir`); default from the process env. */
  readonly stateDir?: string;
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

const systemClock: Clock = { now: () => new Date() };

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
    fileSystem: asFunction(({ root }: { root: string }) => new BunFileSystem(root)).singleton(),
    processRunner: asFunction(() => new BunProcessRunner()).singleton(),
    timer: asFunction(() => new BunTimer()).singleton(),
    launcher: asFunction(() => new BunLauncher()).singleton(),
    updateConfig: asFunction(({ fileSystem }) => new UpdateConfig(fileSystem)),
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
        fileSystem,
        timer,
        root,
        config,
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
        }),
    ),
    // `.metator/` is MetatorAI's own state: never a change, even before setup gitignores it.
    vcs: asFunction(({ root }) => new GitVcs(root, [".metator/"])).singleton(),
    revisionReader: asFunction(({ root }) => new GitVcs(root)).singleton(),
    changeHistory: asFunction(({ root }) => new GitVcs(root)).singleton(),
    branchHistory: asFunction(({ root }) => new GitVcs(root)).singleton(),
    changePatch: asFunction(({ root }) => new GitVcs(root, [".metator/"])).singleton(),
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
      ({ sourceFiles, fileSystem, importAnalyzer, symbolAnalyzer }) =>
        new SymbolQueries(sourceFiles, fileSystem, importAnalyzer, symbolAnalyzer),
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
      ({ agentCatalog, hostGenerators, fileSystem, config }) =>
        new GenerateHosts(agentCatalog, hostGenerators, fileSystem, config.config),
    ),
    validateFindings: asFunction(({ fileSystem }) => new ValidateFindings(fileSystem)),
    mergeFindings: asFunction(
      ({ fileSystem, validateFindings }) => new MergeFindingSets(fileSystem, validateFindings),
    ),
    planReview: asFunction(
      ({ vcs, workspaceReader, ruleCatalog, fileSystem, paths, sourceIgnores }) =>
        new PlanReview(vcs, workspaceReader, ruleCatalog, fileSystem, paths, sourceIgnores),
    ),
    showChangeDiff: asFunction(({ changePatch, fileSystem }) => new ShowChangeDiff(changePatch, fileSystem)),
    describeReviewedChange: asFunction(
      ({ vcs, branchHistory, fileSystem }) => new DescribeReviewedChange(vcs, branchHistory, fileSystem),
    ),
    judgeFindings: asFunction(({ fileSystem }) => new JudgeFindings(fileSystem)),
    formatReviewComments: asFunction(({ fileSystem }) => new FormatReviewComments(fileSystem)),
    evalCatalog: asFunction(({ fileSystem, paths }) => new EvalCatalog(fileSystem, paths)).singleton(),
    scoreEvals: asFunction(({ evalCatalog, fileSystem }) => new ScoreEvals(evalCatalog, fileSystem)),
    compareEvals: asFunction(({ fileSystem }) => new CompareEvals(fileSystem)),
    runEvals: asFunction(
      ({ evalCatalog, binResolver, processRunner }) => new RunEvals(evalCatalog, binResolver, processRunner),
    ),
    runAffectedTests: asFunction(
      ({ computeAffected, packageManager, processRunner }) =>
        new RunAffectedTests(computeAffected, packageManager, processRunner),
    ),
    computeAffected: asFunction(
      ({ vcs, importGraphReader, testGlobs }) => new ComputeAffected(vcs, importGraphReader, testGlobs),
    ),
    lintWorkflows: asFunction(
      ({ workflowCatalog, agentCatalog, skillCatalog }) =>
        new LintWorkflows(workflowCatalog, agentCatalog, skillCatalog),
    ),
    workflowCatalog: asFunction(
      ({ fileSystem, paths }) => new WorkflowCatalog(fileSystem, paths),
    ).singleton(),
    runRepository: asFunction(
      ({ fileSystem, paths }) => new RunRepository(fileSystem, paths, options.run),
    ).singleton(),
    initRun: asFunction(
      ({ workflowCatalog, runRepository, clock, provideWorktree }) =>
        new InitRun(workflowCatalog, runRepository, clock, provideWorktree),
    ),
    worktreeManager: asFunction(({ root }) => new GitWorktreeManager(root)).singleton(),
    portProbe: asFunction(() => new GetPortProbe()).singleton(),
    worktreeRegistry: asFunction(
      ({ fileSystem, paths }) => new WorktreeRegistry(fileSystem, paths),
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
      ({ workflowCatalog, runRepository, clock }) => new AdvanceRun(workflowCatalog, runRepository, clock),
    ),
    approveRun: asFunction(
      ({ advanceRun, runRepository, clock }) => new ApproveRun(advanceRun, runRepository, clock),
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
      ({ advanceRun, runRepository, fileSystem, clock }) =>
        new CloseRun(advanceRun, runRepository, fileSystem, clock),
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
 * What an agent must know about the directory it works in. A Node project without node_modules
 * cannot run its tests, type checker or linters there, and installing is not the agent's call.
 */
export function workNotes(cwd: string): string[] {
  if (existsSync(join(cwd, "package.json")) && !existsSync(join(cwd, "node_modules")))
    return [
      "The project's dependencies are not installed here (no node_modules): its tests, type checker and linters cannot run. Do not install anything or try to run them; write the code and tests, and say plainly that they were not run.",
    ];
  return [];
}
