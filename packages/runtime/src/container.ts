import {
  type AdvanceRun,
  type BuildImportGraph,
  type BuildModuleCards,
  type CheckMemory,
  type CheckRules,
  type Clock,
  type ComputeAffected,
  type Discover,
  err,
  type FileSystem,
  type FindMemoryDupes,
  type FindSimilar,
  type GenerateRuleAdapters,
  type GetRunStatus,
  type GraphQueries,
  type ImportAnalyzer,
  type ImportGraphReader,
  type InitRun,
  type InventoryMemory,
  type KnowledgeFiles,
  type LintAdrs,
  type LintRules,
  type ListRuns,
  type Logger,
  type MeasureRuleCoverage,
  type MemoryBudget,
  type MemoryMapReader,
  MetatorError,
  type MetatorPaths,
  ok,
  type PackageManager,
  type PackageManagerDetector,
  type PackRules,
  type PatternCatalog,
  type ProcessRunner,
  type Result,
  type RuleCatalog,
  type RuleEngine,
  type RuleScaffolder,
  type RunRepository,
  type ScaffoldRule,
  type ScanPatterns,
  type SourceFiles,
  type ValidateCitations,
  type Vcs,
  type WorkflowCatalog,
  type WorkspaceReader,
} from "@metator/core";
import { type AwilixContainer, AwilixResolutionError, createContainer, InjectionMode } from "awilix";

/**
 * DI is awilix (ADR-0011): no decorators, lazy resolution, scopes (one per workflow run),
 * strict lifetime checks, and plain re-registration for config > preset > default overrides.
 * The cradle lists every port and use case; plugins and bootstrap register implementations.
 */
export interface Cradle {
  // configuration values
  root: string;
  paths: MetatorPaths;
  sourceIgnores: readonly string[];
  testGlobs: readonly string[];
  // ports
  clock: Clock;
  logger: Logger;
  fileSystem: FileSystem;
  processRunner: ProcessRunner;
  vcs: Vcs;
  nodePackageManager: PackageManagerDetector & PackageManager;
  packageManagerDetector: PackageManagerDetector;
  packageManager: PackageManager;
  workspaceReader: WorkspaceReader;
  importAnalyzer: ImportAnalyzer;
  importGraphReader: ImportGraphReader;
  ruleEngines: readonly RuleEngine[];
  ruleScaffolders: readonly RuleScaffolder[];
  // application services and use cases
  workflowCatalog: WorkflowCatalog;
  runRepository: RunRepository;
  initRun: InitRun;
  advanceRun: AdvanceRun;
  getRunStatus: GetRunStatus;
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
  lintAdrs: LintAdrs;
  measureRuleCoverage: MeasureRuleCoverage;
  scaffoldRule: ScaffoldRule;
  discover: Discover;
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
