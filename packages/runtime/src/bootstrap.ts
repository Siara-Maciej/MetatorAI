import {
  AdvanceRun,
  BuildImportGraph,
  BuildModuleCards,
  CheckMemory,
  CheckRules,
  type Clock,
  ComputeAffected,
  DEFAULT_PATHS,
  DEFAULT_SOURCE_IGNORES,
  DEFAULT_TEST_GLOBS,
  Discover,
  FindMemoryDupes,
  FindSimilar,
  GenerateRuleAdapters,
  GetRunStatus,
  GraphQueries,
  IndexedImportGraphReader,
  InitRun,
  InventoryMemory,
  KnowledgeFiles,
  LintAdrs,
  LintRules,
  ListRuns,
  MeasureRuleCoverage,
  MemoryBudget,
  MemoryMapReader,
  type MetatorPaths,
  PackRules,
  PatternCatalog,
  RuleCatalog,
  RunRepository,
  ScaffoldRule,
  ScanPatterns,
  SourceFiles,
  ValidateCitations,
  WorkflowCatalog,
} from "@metator/core";
import { BunFileSystem, BunProcessRunner } from "@metator/plugin-bun";

export { findRepoRoot } from "@metator/plugin-bun";

import { AstGrepEngine, AstGrepScaffolder } from "@metator/plugin-astgrep";
import { BiomeEngine } from "@metator/plugin-biome";
import { GitVcs } from "@metator/plugin-git";
import { ManypkgWorkspaceReader, NodePackageManager } from "@metator/plugin-node";
import { OxcImportAnalyzer, TscEngine } from "@metator/plugin-typescript";
import { asFunction, asValue } from "awilix";
import { createMetatorContainer, type MetatorContainer } from "./container.ts";

export interface BootstrapOptions {
  readonly root: string;
  readonly paths?: MetatorPaths;
  /** ISO timestamp pinning the clock (METATOR_NOW): reproducible run ids and logs. */
  readonly now?: string;
}

const systemClock: Clock = { now: () => new Date() };

/**
 * Composition root: the only place that knows concrete adapters. Use cases keep plain
 * constructors (framework-agnostic); awilix wires them through factories.
 */
export function bootstrap(options: BootstrapOptions): MetatorContainer {
  const c = createMetatorContainer();
  const pinned = options.now ? new Date(options.now) : undefined;
  c.register({
    root: asValue(options.root),
    paths: asValue(options.paths ?? DEFAULT_PATHS),
    sourceIgnores: asValue(DEFAULT_SOURCE_IGNORES),
    testGlobs: asValue(DEFAULT_TEST_GLOBS),
    clock: asValue(pinned && !Number.isNaN(pinned.getTime()) ? { now: () => new Date(pinned) } : systemClock),
    fileSystem: asFunction(({ root }: { root: string }) => new BunFileSystem(root)).singleton(),
    processRunner: asFunction(() => new BunProcessRunner()).singleton(),
    vcs: asFunction(({ root }) => new GitVcs(root)).singleton(),
    nodePackageManager: asFunction(({ root }) => new NodePackageManager(root)).singleton(),
    packageManagerDetector: asFunction(({ nodePackageManager }) => nodePackageManager).singleton(),
    packageManager: asFunction(({ nodePackageManager }) => nodePackageManager).singleton(),
    workspaceReader: asFunction(({ root }) => new ManypkgWorkspaceReader(root)).singleton(),
    importAnalyzer: asFunction(({ root }) => new OxcImportAnalyzer(root)).singleton(),
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
      ({ buildImportGraph, fileSystem, paths, testGlobs }) =>
        new BuildModuleCards(buildImportGraph, fileSystem, paths, testGlobs),
    ),
    patternCatalog: asFunction(({ fileSystem, paths }) => new PatternCatalog(fileSystem, paths)).singleton(),
    scanPatterns: asFunction(
      ({ patternCatalog, ruleCatalog, ruleEngines, workspaceReader, fileSystem, paths }) =>
        new ScanPatterns(patternCatalog, ruleCatalog, ruleEngines, workspaceReader, fileSystem, paths),
    ),
    findSimilar: asFunction(({ scanPatterns }) => new FindSimilar(scanPatterns)),
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
    computeAffected: asFunction(
      ({ vcs, importGraphReader, testGlobs }) => new ComputeAffected(vcs, importGraphReader, testGlobs),
    ),
    workflowCatalog: asFunction(
      ({ fileSystem, paths }) => new WorkflowCatalog(fileSystem, paths),
    ).singleton(),
    runRepository: asFunction(({ fileSystem, paths }) => new RunRepository(fileSystem, paths)).singleton(),
    initRun: asFunction(
      ({ workflowCatalog, runRepository, clock }) => new InitRun(workflowCatalog, runRepository, clock),
    ),
    advanceRun: asFunction(
      ({ workflowCatalog, runRepository, clock }) => new AdvanceRun(workflowCatalog, runRepository, clock),
    ),
    getRunStatus: asFunction(
      ({ workflowCatalog, runRepository }) => new GetRunStatus(workflowCatalog, runRepository),
    ),
    listRuns: asFunction(({ runRepository }) => new ListRuns(runRepository)),
  });
  return c;
}
