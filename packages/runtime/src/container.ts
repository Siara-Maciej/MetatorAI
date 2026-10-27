import {
  type AddLesson,
  type AdvanceRun,
  type AgentCatalog,
  type ApiSnapshots,
  type ApproveRun,
  type AuditAgents,
  type BinResolver,
  type BuildImportGraph,
  type BuildModuleCards,
  type CheckDebugTags,
  type CheckFlaky,
  type CheckMemory,
  type CheckpointRun,
  type CheckQuote,
  type CheckRules,
  type Clock,
  type CloseRun,
  type CompareEvals,
  type ComputeAffected,
  type CreateWorktree,
  type DiffCoverage,
  type DiffImportGraph,
  type Discover,
  type DocsDrift,
  type DocsInventory,
  type DocsLinks,
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
  type HostGenerator,
  type ImportAnalyzer,
  type ImportGraphReader,
  type InitProject,
  type InitRun,
  type InstallCanon,
  type InventoryMemory,
  type JudgeFindings,
  type KnowledgeFiles,
  type LintAdrs,
  type LintAgents,
  type LintPlan,
  type LintRules,
  type LintSkills,
  type LintSystem,
  type LintWorkflows,
  type ListRuns,
  type ListWorktrees,
  type Logger,
  type MeasureRuleCoverage,
  type MemoryBudget,
  type MemoryMapReader,
  type MergeFindingSets,
  MetatorError,
  type MetatorPaths,
  ok,
  type PackageManager,
  type PackageManagerDetector,
  type PackRules,
  type PatternCatalog,
  type PlanReview,
  type PortProbe,
  type ProcessRunner,
  type PruneWorktrees,
  type RemoveWorktree,
  type Result,
  type RevisionReader,
  type RuleCatalog,
  type RuleEngine,
  type RuleScaffolder,
  type RunAffectedTests,
  type RunEvals,
  type RunGate,
  type RunRepository,
  type ScaffoldRule,
  type ScanPatterns,
  type ScopePlan,
  type ScoreEvals,
  type ShowSystem,
  type SkillCatalog,
  type SkillGenerator,
  type SourceFiles,
  type SymbolAnalyzer,
  type SymbolQueries,
  type SystemCatalog,
  type ValidateCitations,
  type ValidateFindings,
  type Vcs,
  type WorkflowCatalog,
  type WorkspaceReader,
  type WorktreeManager,
  type WorktreeRegistry,
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
  nodePackageManager: PackageManagerDetector & PackageManager;
  packageManagerDetector: PackageManagerDetector;
  packageManager: PackageManager;
  binResolver: BinResolver;
  workspaceReader: WorkspaceReader;
  importAnalyzer: ImportAnalyzer;
  symbolAnalyzer: SymbolAnalyzer;
  importGraphReader: ImportGraphReader;
  ruleEngines: readonly RuleEngine[];
  ruleScaffolders: readonly RuleScaffolder[];
  // application services and use cases
  workflowCatalog: WorkflowCatalog;
  runRepository: RunRepository;
  initRun: InitRun;
  worktreeManager: WorktreeManager;
  portProbe: PortProbe;
  worktreeRegistry: WorktreeRegistry;
  createWorktree: CreateWorktree;
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
  planReview: PlanReview;
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
