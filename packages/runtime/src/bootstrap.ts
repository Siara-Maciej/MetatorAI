import {
  AdvanceRun,
  BuildImportGraph,
  CheckMemory,
  CheckRules,
  type Clock,
  ComputeAffected,
  DEFAULT_PATHS,
  DEFAULT_SOURCE_IGNORES,
  DEFAULT_TEST_GLOBS,
  GenerateRuleAdapters,
  GetRunStatus,
  GraphQueries,
  IndexedImportGraphReader,
  InitRun,
  InventoryMemory,
  KnowledgeFiles,
  LintRules,
  ListRuns,
  MemoryBudget,
  MemoryMapReader,
  type MetatorPaths,
  PackRules,
  RuleCatalog,
  RunRepository,
  SourceFiles,
  ValidateCitations,
  WorkflowCatalog,
} from "@metator/core";
import { BunFileSystem, BunProcessRunner } from "@metator/plugin-bun";

export { findRepoRoot } from "@metator/plugin-bun";

import { AstGrepEngine } from "@metator/plugin-astgrep";
import { GitVcs } from "@metator/plugin-git";
import { ManypkgWorkspaceReader } from "@metator/plugin-node";
import { OxcImportAnalyzer } from "@metator/plugin-typescript";
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
    ]).singleton(),
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
