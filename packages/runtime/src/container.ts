import type {
  AddLesson,
  AdvanceRun,
  AgentCatalog,
  AgentHost,
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
  BackgroundProcess,
  BaseArchitectureFacts,
  BinResolver,
  BranchHistory,
  BranchPublication,
  BuildImportGraph,
  BuildModuleCards,
  BuildReport,
  CalibrateFinding,
  ChangeHistory,
  ChangePatch,
  CheckArchitecture,
  CheckDebugTags,
  CheckFlaky,
  CheckMemory,
  CheckoutReader,
  CheckPublished,
  CheckpointRun,
  CheckQuote,
  CheckReadiness,
  CheckRules,
  Clock,
  CloneCache,
  CloseRun,
  CodeHost,
  CompareEvals,
  ComputeAffected,
  Conductor,
  ContainerRuntime,
  ContractDetector,
  ContractDiffer,
  ConversationRepository,
  CreateRefactorPlan,
  CreateSystemPlan,
  CreateWorktree,
  DataIsolator,
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
  EnvironmentCatalog,
  EnvironmentServices,
  EvalCatalog,
  FileSystem,
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
  HealthProbe,
  HostGenerator,
  HostManifestCatalog,
  HostPrompts,
  ImportAnalyzer,
  ImportGraphReader,
  InitArchitecturePolicy,
  InitEnvironment,
  InitProject,
  InitRun,
  InstallCanon,
  InteractiveHost,
  InventoryMemory,
  Issues,
  JudgeFindings,
  KnowledgeFiles,
  Launcher,
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
  MachineLeases,
  MachineState,
  ManifestReader,
  MeasureRuleCoverage,
  MemoryBudget,
  MemoryMapReader,
  MergeFindingSets,
  MetatorPaths,
  MyReviews,
  Notifier,
  OpenEditor,
  OptionStore,
  PackageManager,
  PackageManagerDetector,
  PackRules,
  PaneSensor,
  Panes,
  PatternCatalog,
  PlanBoard,
  PlanReview,
  PortProbe,
  ProcessRunner,
  ProposeRefactorPlan,
  ProposeSystemPlan,
  ProvideWorktree,
  PruneWorktrees,
  PtyBroker,
  RecordArchitectureBaseline,
  RefactorPlanStore,
  RemoveWorktree,
  RenderReport,
  RepositoryCloner,
  RepositoryDiscoverySource,
  RepositoryRuns,
  ResumeRun,
  ReviewFeedback,
  ReviewHost,
  ReviewNotes,
  RevisionReader,
  RuleCatalog,
  RuleEngine,
  RuleScaffolder,
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
  Sandbox,
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
  SkillGenerator,
  SourceFiles,
  Supervisor,
  SupervisorDependencies,
  SymbolAnalyzer,
  SymbolQueries,
  SyncRefactorPlan,
  SystemCatalog,
  SystemImpactQuery,
  SystemLocation,
  SystemPlanStatus,
  SystemPlanStore,
  SystemSources,
  Terminal,
  Timer,
  ToolBoundariesReader,
  TreeCopier,
  UpdateConfig,
  UserConfigStore,
  ValidateCitations,
  ValidateFindings,
  Vcs,
  WarmPool,
  WorkflowCatalog,
  WorkOverview,
  WorkspaceReader,
  WorktreeConflicts,
  WorktreeManager,
  WorktreeRegistry,
  WriteRunArtifact,
} from "@metator/core";
import { type AwilixContainer, createContainer, InjectionMode } from "awilix";
import type { LoadedConfig } from "./config.ts";

/**
 * DI is awilix (ADR-0011): no decorators, lazy resolution and strict lifetime checks.
 * The cradle types every port and use case; `bootstrap()` (bootstrap.ts) registers all of them
 * statically in one container per repository root. There are no scopes and no plugin loading.
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
  fileSystem: FileSystem;
  processRunner: ProcessRunner;
  /** The one git adapter of the repository; the git ports below resolve to it. */
  git: Vcs & RevisionReader & ChangeHistory & BranchHistory & ChangePatch & BranchPublication;
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
  codeHost: CodeHost;
  scanIntake: ScanIntake;
  reviewHost: ReviewHost;
  myReviews: MyReviews;
  planBoard: PlanBoard;
  openEditor: OpenEditor;
  reviewFeedback: ReviewFeedback;
  renderReport: RenderReport;
  seedGoldenSet: SeedGoldenSet;
  quarterlyReview: RunQuarterlyReview;
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
