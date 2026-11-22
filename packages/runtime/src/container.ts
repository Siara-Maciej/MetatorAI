import type {
  AddLesson,
  AdvanceRun,
  AgentCatalog,
  AgentHost,
  AllGateApprovals,
  AnalyzeArchitecture,
  AnalyzeEnvironment,
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
  BackgroundProcess,
  BacklogWork,
  BaseArchitectureFacts,
  BinResolver,
  BranchHistory,
  BranchPublication,
  BriefRun,
  BuildImportGraph,
  BuildModuleCards,
  BuildReport,
  CalibrateFinding,
  ChangeHistory,
  ChangePatch,
  ChatNotices,
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
  ContentHasher,
  ContinueTask,
  ContractDetector,
  ContractDiffer,
  ConversationRepository,
  CoverageReader,
  CreateRefactorPlan,
  CreateSystemPlan,
  CreateWorktree,
  DataIsolator,
  DeclarationEmitter,
  DescribeReviewedChange,
  DetachedDrive,
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
  EndRun,
  EnsureDriven,
  EnvironmentCatalog,
  EnvironmentServices,
  EvalCatalog,
  FileLock,
  FileStats,
  FileSystem,
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
  HealthProbe,
  HostBins,
  HostDescriptor,
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
  IssueSnapshots,
  Issues,
  JudgeFindings,
  KnowledgeFiles,
  Launcher,
  LayoutPaneIdentity,
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
  OpenPrompt,
  OptionStore,
  PackageManager,
  PackageManagerDetector,
  PackRules,
  PaneMail,
  PaneQuestions,
  PaneSensor,
  Panes,
  PaneTyped,
  PatternCatalog,
  PlanBoard,
  PlannedBreakingChanges,
  PlanReview,
  PlanRevisions,
  PortProbe,
  ProcessRunner,
  ProposeRefactorPlan,
  ProposeSystemPlan,
  ProvideWorktree,
  PruneWorktrees,
  PtyBroker,
  QuickCheck,
  QuickFit,
  QuickOverrides,
  QuickReady,
  QuickReviewed,
  QuickStart,
  RecordArchitectureBaseline,
  RefactorPlanStore,
  RemoveWorktree,
  RenderReport,
  RepositoryCloner,
  RepositoryDiscoverySource,
  RepositoryRuns,
  ResumeNotices,
  ResumeRun,
  RetrySystemStep,
  ReviewFeedback,
  ReviewHost,
  ReviewNotes,
  RevisionReader,
  ReviveRuns,
  RuleCatalog,
  RuleEngine,
  RuleScaffolder,
  RunAffectedTests,
  RunArchEvals,
  RunArtifacts,
  RunChanges,
  RunDrivers,
  RunEvals,
  RunGate,
  RunJournal,
  RunMessages,
  RunPanes,
  RunPlans,
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
  Scratch,
  ScreenRenderer,
  SeedGoldenSet,
  SessionSteering,
  SetupRepository,
  SetupWorktree,
  ShowChangeDiff,
  ShowSystem,
  SimulateArchitecture,
  SimulateRefactorPlan,
  SkillCatalog,
  SkillGenerator,
  SourceFiles,
  StartDrive,
  StartRun,
  StartSystemStep,
  StyleImports,
  Supervisor,
  SupervisorDependencies,
  SymbolAnalyzer,
  SymbolQueries,
  SyncRefactorPlan,
  SystemCatalog,
  SystemImpactQuery,
  SystemLocation,
  SystemMaps,
  SystemPlanApprovals,
  SystemPlanStatus,
  SystemPlanStore,
  SystemPlans,
  SystemRunGate,
  SystemSources,
  TaskRepository,
  Terminal,
  Threads,
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
  WorkingPatches,
  WorkingTree,
  WorkOverview,
  WorkspaceReader,
  WorktreeConflicts,
  WorktreeManager,
  WorktreeRegistry,
  WriteRunArtifact,
} from "@metator/core";
import type { McpToolCaller } from "@metator/plugin-codehost-mcp";
import { type AwilixContainer, createContainer, InjectionMode } from "awilix";
import type { LoadedConfig } from "./config.ts";

/**
 * DI is awilix (ADR-0084): no decorators, lazy resolution and strict lifetime checks.
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
  fileLock: FileLock;
  processRunner: ProcessRunner;
  /** The one git adapter of the repository; the git ports below resolve to it. */
  git: Vcs & RevisionReader & ChangeHistory & BranchHistory & ChangePatch & BranchPublication;
  vcs: Vcs;
  /** The working tree of the repository and of its worktrees, as git sees it now. */
  workingTree: WorkingTree;
  /** The Vcs of another checkout (a worktree's directory): one reading of "changed files" everywhere. */
  vcsAt: (dir: string) => Vcs;
  revisionReader: RevisionReader;
  changeHistory: ChangeHistory;
  sandbox: Sandbox;
  nodePackageManager: PackageManagerDetector & PackageManager;
  packageManagerDetector: PackageManagerDetector;
  packageManager: PackageManager;
  binResolver: BinResolver;
  /** Binaries of rule engines: the repository's pinned one first, PATH otherwise, installed or not. */
  toolBins: BinResolver;
  workspaceReader: WorkspaceReader;
  manifestReader: ManifestReader;
  toolBoundariesReader: ToolBoundariesReader;
  /** The one analyzer of the repository; the two ports below resolve to it. */
  oxc: ImportAnalyzer & SymbolAnalyzer;
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
  contentHasher: ContentHasher;
  issueSnapshots: IssueSnapshots;
  backlogWork: BacklogWork;
  mcpToolCaller: McpToolCaller;
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
  knownHosts: readonly HostDescriptor[];
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
  screenRenderer: ScreenRenderer;
  interactiveHosts: ReadonlyMap<string, InteractiveHost>;
  /** The scenario host while a test plays one; empty otherwise. */
  played: readonly HostDescriptor[];
  /** The hosts a session can take, the default first. */
  sessionHosts: readonly HostDescriptor[];
  /** The program given for a host, by host id. */
  hostBins: HostBins;
  /** Why a host that drives agents cannot start on this machine; undefined when it can. */
  driveHostProblem: (host: string) => string | undefined;
  /** Every interactive host with the program it starts and whether that program is on this machine. */
  hostStatus: () => readonly {
    readonly id: string;
    readonly command?: string;
    readonly installed: boolean;
  }[];
  ptyBroker: PtyBroker;
  layoutStore: LayoutStore;
  panes: Panes;
  conductor: Conductor;
  chatNotices: ChatNotices;
  paneMail: PaneMail;
  threads: Threads;
  paneTyped: PaneTyped;
  guardAsked: GuardAsked;
  sessionSteering: SessionSteering;
  resumeNotices: ResumeNotices;
  taskRepository: TaskRepository;
  continueTask: (repos: () => readonly TaskRepository[]) => ContinueTask;
  supervisor: (restart: SupervisorDependencies["restart"]) => Supervisor;
  hostManifests: HostManifestCatalog;
  paneSensor: PaneSensor;
  hostPrompts: HostPrompts;
  openPrompts: Map<string, OpenPrompt>;
  paneQuestions: PaneQuestions;
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
  guardConsents: GuardConsents;
  guardUserPrompt: GuardUserPrompt;
  guardPostEdit: GuardPostEdit;
  guardStop: GuardStop;
  guardSubagentOutput: GuardSubagentOutput;
  guardSessionStart: GuardSessionStart;
  checkpointRun: CheckpointRun;
  writeRunArtifact: WriteRunArtifact;
  resumeRun: ResumeRun;
  gateQuestions: GateQuestions;
  paneIdentity: LayoutPaneIdentity;
  gateApprovals: AllGateApprovals;
  systemPlanApprovals: SystemPlanApprovals;
  handoffRun: HandoffRun;
  closeRun: CloseRun;
  detachedDrive: DetachedDrive;
  runPanes: RunPanes;
  defaultDriveHost: () => string;
  startDrive: StartDrive;
  ensureDriven: EnsureDriven;
  startRun: StartRun;
  scratch: Scratch;
  /** The agent a new chat opens with; undefined: the agent that started runs before. */
  chatAgent: () => Promise<string | undefined>;
  workingPatches: WorkingPatches;
  quickCheck: QuickCheck;
  quickOverrides: QuickOverrides;
  quickStart: QuickStart;
  quickFit: QuickFit;
  quickReady: QuickReady;
  quickReviewed: QuickReviewed;
  answerQuestion: AnswerQuestion;
  askInRun: AskInRun;
  briefRun: BriefRun;
  reviveRuns: ReviveRuns;
  endRun: EndRun;
  setupRepository: SetupRepository;
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
  plannedBreakingChanges: PlannedBreakingChanges;
  diffContracts: DiffContracts;
  styleImports: StyleImports;
  cloneCache: CloneCache;
  repositoryRuns: (root: string) => RepositoryRuns;
  runSystemPlan: RunSystemPlan;
  systemPlanStatus: SystemPlanStatus;
  retrySystemStep: RetrySystemStep;
  startSystemStep: StartSystemStep;
  systemRunGate: SystemRunGate;
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
  coverageReader: CoverageReader;
  diffCoverage: DiffCoverage;
  declarationEmitter: DeclarationEmitter;
  apiSnapshots: ApiSnapshots;
  diffImportGraph: DiffImportGraph;
  lintPlan: LintPlan;
  scopePlan: ScopePlan;
  runPlans: RunPlans;
  planRevisions: PlanRevisions;
  systemPlans: SystemPlans;
  systemMaps: SystemMaps;
  fileStats: FileStats;
  runArtifacts: RunArtifacts;
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
