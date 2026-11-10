import {
  type AddLesson,
  type AdvanceRun,
  type AgentCatalog,
  type AgentHost,
  type AnalyzeArchitecture,
  type AnalyzeEnvironment,
  type AnalyzeSystem,
  type AnswerPolicyStore,
  type ApiSnapshots,
  type ApproveRefactorPlan,
  type ApproveRun,
  type ApproveSystemPlan,
  type ArchitectureBaselineStore,
  type ArchitectureFacts,
  type ArchitecturePolicyCatalog,
  type AskQuestion,
  type AuditAgents,
  type BackgroundProcess,
  type BaseArchitectureFacts,
  type BinResolver,
  type BranchHistory,
  type BranchPublication,
  type BuildImportGraph,
  type BuildModuleCards,
  type BuildReport,
  type CalibrateFinding,
  type ChangeHistory,
  type ChangePatch,
  type CheckArchitecture,
  type CheckDebugTags,
  type CheckFlaky,
  type CheckMemory,
  type CheckoutReader,
  type CheckPublished,
  type CheckpointRun,
  type CheckQuote,
  type CheckReadiness,
  type CheckRules,
  type Clock,
  type CloneCache,
  type CloseRun,
  type CompareEvals,
  type ComputeAffected,
  type Conductor,
  type ContainerRuntime,
  type ContractDetector,
  type ContractDiffer,
  type ConversationRepository,
  type CreateRefactorPlan,
  type CreateSystemPlan,
  type CreateWorktree,
  type DataIsolator,
  type DescribeReviewedChange,
  type DiffContracts,
  type DiffCoverage,
  type DiffImportGraph,
  type Discover,
  type DiscoverEnvironment,
  type DiscoverSystem,
  type DocsDrift,
  type DocsInventory,
  type DocsLinks,
  type DriveRun,
  type DriverLock,
  type EnvironmentCatalog,
  type EnvironmentServices,
  type EvalCatalog,
  err,
  type FileSystem,
  type FindMemoryDupes,
  type FindOwners,
  type FindSimilar,
  type FormatReviewComments,
  type GateChecks,
  type GenerateHosts,
  type GenerateRuleAdapters,
  type GenerateSkills,
  type GetRunStatus,
  type GraphQueries,
  type GuardPostEdit,
  type GuardPreTool,
  type GuardSessionStart,
  type GuardStop,
  type GuardSubagentOutput,
  type HandoffRun,
  type HealthProbe,
  type HostGenerator,
  type HostManifestCatalog,
  type HostPrompts,
  type ImportAnalyzer,
  type ImportGraphReader,
  type InitArchitecturePolicy,
  type InitEnvironment,
  type InitProject,
  type InitRun,
  type InstallCanon,
  type InteractiveHost,
  type InventoryMemory,
  type Issues,
  type JudgeFindings,
  type KnowledgeFiles,
  type Launcher,
  type LayoutStore,
  type LintAdrs,
  type LintAgents,
  type LintPlan,
  type LintRefactorPlan,
  type LintRules,
  type LintSkills,
  type LintSystem,
  type LintSystemPlan,
  type LintWorkflows,
  type ListRuns,
  type ListWorktrees,
  type Logger,
  type MachineLeases,
  type MachineState,
  type ManifestReader,
  type MeasureRuleCoverage,
  type MemoryBudget,
  type MemoryMapReader,
  type MergeFindingSets,
  MetatorError,
  type MetatorPaths,
  type Notifier,
  type OpenEditor,
  type OptionStore,
  ok,
  type PackageManager,
  type PackageManagerDetector,
  type PackRules,
  type PaneSensor,
  type Panes,
  type PatternCatalog,
  type PlanBoard,
  type PlanReview,
  type PortProbe,
  type ProcessRunner,
  type ProposeRefactorPlan,
  type ProposeSystemPlan,
  type ProvideWorktree,
  type PruneWorktrees,
  type PtyBroker,
  type RecordArchitectureBaseline,
  type RefactorPlanStore,
  type RemoveWorktree,
  type RepositoryCloner,
  type RepositoryDiscoverySource,
  type RepositoryRuns,
  type Result,
  type ResumeRun,
  type ReviewNotes,
  type RevisionReader,
  type RuleCatalog,
  type RuleEngine,
  type RuleScaffolder,
  type RunAffectedTests,
  type RunArchEvals,
  type RunChanges,
  type RunDrivers,
  type RunEvals,
  type RunGate,
  type RunJournal,
  type RunMessages,
  type RunRefactorPlan,
  type RunRepository,
  type RunSystemEvals,
  type RunSystemPlan,
  type Sandbox,
  type ScaffoldRule,
  type ScanPatterns,
  type ScopePlan,
  type ScoreEvals,
  type SetupWorktree,
  type ShowChangeDiff,
  type ShowSystem,
  type SimulateArchitecture,
  type SimulateRefactorPlan,
  type SkillCatalog,
  type SkillGenerator,
  type SourceFiles,
  type Supervisor,
  type SupervisorDependencies,
  type SymbolAnalyzer,
  type SymbolQueries,
  type SyncRefactorPlan,
  type SystemCatalog,
  type SystemImpactQuery,
  type SystemLocation,
  type SystemPlanStatus,
  type SystemPlanStore,
  type SystemSources,
  type Terminal,
  type Timer,
  type ToolBoundariesReader,
  type TreeCopier,
  type UpdateConfig,
  type UserConfigStore,
  type ValidateCitations,
  type ValidateFindings,
  type Vcs,
  type WarmPool,
  type WorkflowCatalog,
  type WorkOverview,
  type WorkspaceReader,
  type WorktreeConflicts,
  type WorktreeManager,
  type WorktreeRegistry,
  type WriteRunArtifact,
} from "@metator/core";
import { type AwilixContainer, AwilixResolutionError, createContainer, InjectionMode } from "awilix";
import type { LoadedConfig } from "./config.ts";

/**
 * DI is awilix (ADR-0011): no decorators, lazy resolution, scopes (one per workflow run),
 * strict lifetime checks, and plain re-registration for config > preset > default overrides.
 * The cradle lists every port and use case; plugins and bootstrap register implementations.
 */
export interface Cradle {
  // configuration values
  root: string;
  config: LoadedConfig;
  paths: MetatorPaths;
  sourceIgnores: readonly string[];
  testGlobs: readonly string[];
  // ports
  clock: Clock;
  logger: Logger;
  fileSystem: FileSystem;
  processRunner: ProcessRunner;
  vcs: Vcs;
  revisionReader: RevisionReader;
  changeHistory: ChangeHistory;
  sandbox: Sandbox;
  nodePackageManager: PackageManagerDetector & PackageManager;
  packageManagerDetector: PackageManagerDetector;
  packageManager: PackageManager;
  binResolver: BinResolver;
  workspaceReader: WorkspaceReader;
  manifestReader: ManifestReader;
  toolBoundariesReader: ToolBoundariesReader;
  importAnalyzer: ImportAnalyzer;
  symbolAnalyzer: SymbolAnalyzer;
  importGraphReader: ImportGraphReader;
  ruleEngines: readonly RuleEngine[];
  ruleScaffolders: readonly RuleScaffolder[];
  // application services and use cases
  workflowCatalog: WorkflowCatalog;
  runRepository: RunRepository;
  initRun: InitRun;
  timer: Timer;
  launcher: Launcher;
  dataIsolator: DataIsolator;
  treeCopier: TreeCopier;
  updateConfig: UpdateConfig;
  userConfig: UserConfigStore;
  optionStore: OptionStore;
  issues: Issues;
  planBoard: PlanBoard;
  openEditor: OpenEditor;
  reviewNotes: ReviewNotes;
  runChanges: RunChanges;
  containerRuntime: ContainerRuntime;
  healthProbe: HealthProbe;
  environmentCatalog: EnvironmentCatalog;
  discoverEnvironment: DiscoverEnvironment;
  initEnvironment: InitEnvironment;
  environmentServices: EnvironmentServices;
  backgroundProcess: BackgroundProcess;
  agentHosts: ReadonlyMap<string, AgentHost>;
  conversationRepository: ConversationRepository;
  askQuestion: AskQuestion;
  workOverview: WorkOverview;
  checkReadiness: CheckReadiness;
  setupWorktree: SetupWorktree;
  worktreeConflicts: WorktreeConflicts;
  answerPolicyStore: AnswerPolicyStore;
  buildReport: BuildReport;
  driverLock: DriverLock;
  terminal: Terminal;
  interactiveHosts: ReadonlyMap<string, InteractiveHost>;
  ptyBroker: PtyBroker;
  layoutStore: LayoutStore;
  panes: Panes;
  conductor: Conductor;
  supervisor: (restart: SupervisorDependencies["restart"]) => Supervisor;
  hostManifests: HostManifestCatalog;
  paneSensor: PaneSensor;
  hostPrompts: HostPrompts;
  notifier: Notifier;
  runMessages: RunMessages;
  runJournal: RunJournal;
  runDrivers: RunDrivers;
  driveRun: DriveRun;
  worktreeManager: WorktreeManager;
  portProbe: PortProbe;
  worktreeRegistry: WorktreeRegistry;
  machineState: MachineState;
  machineLeases: MachineLeases;
  createWorktree: CreateWorktree;
  provideWorktree: ProvideWorktree;
  warmPool: WarmPool;
  analyzeEnvironment: AnalyzeEnvironment;
  listWorktrees: ListWorktrees;
  removeWorktree: RemoveWorktree;
  pruneWorktrees: PruneWorktrees;
  advanceRun: AdvanceRun;
  approveRun: ApproveRun;
  getRunStatus: GetRunStatus;
  role: string | undefined;
  guardPreTool: GuardPreTool;
  guardPostEdit: GuardPostEdit;
  guardStop: GuardStop;
  guardSubagentOutput: GuardSubagentOutput;
  guardSessionStart: GuardSessionStart;
  checkpointRun: CheckpointRun;
  writeRunArtifact: WriteRunArtifact;
  resumeRun: ResumeRun;
  handoffRun: HandoffRun;
  closeRun: CloseRun;
  listRuns: ListRuns;
  sourceFiles: SourceFiles;
  buildImportGraph: BuildImportGraph;
  graphQueries: GraphQueries;
  computeAffected: ComputeAffected;
  ruleCatalog: RuleCatalog;
  lintRules: LintRules;
  packRules: PackRules;
  generateRuleAdapters: GenerateRuleAdapters;
  checkRules: CheckRules;
  memoryMapReader: MemoryMapReader;
  knowledgeFiles: KnowledgeFiles;
  inventoryMemory: InventoryMemory;
  memoryBudget: MemoryBudget;
  validateCitations: ValidateCitations;
  checkMemory: CheckMemory;
  findMemoryDupes: FindMemoryDupes;
  buildModuleCards: BuildModuleCards;
  patternCatalog: PatternCatalog;
  scanPatterns: ScanPatterns;
  findSimilar: FindSimilar;
  symbolQueries: SymbolQueries;
  checkFlaky: CheckFlaky;
  checkDebugTags: CheckDebugTags;
  checkQuote: CheckQuote;
  findOwners: FindOwners;
  contractKinds: readonly string[];
  systemCatalog: SystemCatalog;
  contractDetectors: readonly ContractDetector[];
  contractDiffers: readonly ContractDiffer[];
  diffContracts: DiffContracts;
  cloneCache: CloneCache;
  repositoryRuns: (root: string) => RepositoryRuns;
  runSystemPlan: RunSystemPlan;
  systemPlanStatus: SystemPlanStatus;
  runSystemEvals: RunSystemEvals;
  runArchEvals: RunArchEvals;
  systemPlanStore: SystemPlanStore;
  analyzeSystem: AnalyzeSystem;
  createSystemPlan: CreateSystemPlan;
  lintSystemPlan: LintSystemPlan;
  approveSystemPlan: ApproveSystemPlan;
  proposeSystemPlan: ProposeSystemPlan;
  discoverySource: RepositoryDiscoverySource;
  discoverSystem: DiscoverSystem;
  repositoryCloner: RepositoryCloner;
  checkoutReader: CheckoutReader;
  systemLocation: SystemLocation;
  systemSources: SystemSources;
  systemImpactQuery: SystemImpactQuery;
  architecturePolicyCatalog: ArchitecturePolicyCatalog;
  architectureFacts: ArchitectureFacts;
  analyzeArchitecture: AnalyzeArchitecture;
  architectureBaselineStore: ArchitectureBaselineStore;
  baseArchitectureFacts: BaseArchitectureFacts;
  checkArchitecture: CheckArchitecture;
  recordArchitectureBaseline: RecordArchitectureBaseline;
  initArchitecturePolicy: InitArchitecturePolicy;
  simulateArchitecture: SimulateArchitecture;
  refactorPlanStore: RefactorPlanStore;
  createRefactorPlan: CreateRefactorPlan;
  simulateRefactorPlan: SimulateRefactorPlan;
  lintRefactorPlan: LintRefactorPlan;
  approveRefactorPlan: ApproveRefactorPlan;
  proposeRefactorPlan: ProposeRefactorPlan;
  runRefactorPlan: RunRefactorPlan;
  syncRefactorPlan: SyncRefactorPlan;
  lintSystem: LintSystem;
  showSystem: ShowSystem;
  docsLinks: DocsLinks;
  docsInventory: DocsInventory;
  docsDrift: DocsDrift;
  addLesson: AddLesson;
  diffCoverage: DiffCoverage;
  apiSnapshots: ApiSnapshots;
  diffImportGraph: DiffImportGraph;
  lintPlan: LintPlan;
  scopePlan: ScopePlan;
  lintAdrs: LintAdrs;
  measureRuleCoverage: MeasureRuleCoverage;
  scaffoldRule: ScaffoldRule;
  discover: Discover;
  runGate: RunGate;
  gateChecks: GateChecks;
  runAffectedTests: RunAffectedTests;
  initProject: InitProject;
  installCanon: InstallCanon;
  hostGenerators: readonly HostGenerator[];
  agentCatalog: AgentCatalog;
  lintAgents: LintAgents;
  generateHosts: GenerateHosts;
  skillGenerators: readonly SkillGenerator[];
  skillCatalog: SkillCatalog;
  auditAgents: AuditAgents;
  lintSkills: LintSkills;
  lintWorkflows: LintWorkflows;
  generateSkills: GenerateSkills;
  validateFindings: ValidateFindings;
  mergeFindings: MergeFindingSets;
  calibrateFinding: CalibrateFinding;
  planReview: PlanReview;
  describeReviewedChange: DescribeReviewedChange;
  branchHistory: BranchHistory;
  showChangeDiff: ShowChangeDiff;
  checkPublished: CheckPublished;
  changePatch: ChangePatch & Vcs & BranchPublication;
  judgeFindings: JudgeFindings;
  formatReviewComments: FormatReviewComments;
  evalCatalog: EvalCatalog;
  scoreEvals: ScoreEvals;
  compareEvals: CompareEvals;
  runEvals: RunEvals;
}

export type MetatorContainer = AwilixContainer<Cradle>;

export function createMetatorContainer(): MetatorContainer {
  return createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });
}

/** Resolves a port, translating awilix errors into actionable MetatorErrors (errors as values). */
export function resolvePort<K extends keyof Cradle>(
  container: MetatorContainer,
  name: K,
): Result<Cradle[K], MetatorError> {
  try {
    return ok(container.resolve(name));
  } catch (e) {
    if (!(e instanceof AwilixResolutionError)) throw e;
    if (e.message.includes("Cyclic dependencies")) {
      return err(
        new MetatorError("INTERNAL", `Dependency cycle while resolving ${String(name)}`, {
          details: { message: e.message },
        }),
      );
    }
    return err(
      new MetatorError("BINDING_MISSING", `No implementation registered for ${String(name)}`, {
        hint: "Enable the plugin that provides it or bind the capability in metator.config.",
      }),
    );
  }
}
