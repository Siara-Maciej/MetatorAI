import { MetatorError } from "../domain/errors.ts";
import { DependencyGraph, type Edge } from "../domain/graph.ts";
import { classifyEdge, type ImportIndex, ImportIndexDocument, packageOf } from "../domain/import-index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type {
  FileSystem,
  ImportAnalyzer,
  ImportGraphReader,
  WorkspacePackage,
  WorkspaceReader,
} from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

export interface UnresolvedImport {
  readonly from: string;
  readonly specifier: string;
}

export interface ImportGraphReport {
  readonly files: readonly string[];
  readonly edges: readonly Edge[];
  readonly packages: readonly WorkspacePackage[];
  readonly externals: readonly string[];
  readonly unresolved: readonly UnresolvedImport[];
  readonly stats: { readonly parsed: number; readonly reused: number; readonly failed: number };
  readonly parseErrors: readonly { readonly file: string; readonly message: string }[];
}

/**
 * Builds the file-level import graph incrementally. Parsing is cached per content fingerprint
 * in a versioned ImportIndex document; resolution always runs against the current tree.
 */
export class BuildImportGraph {
  constructor(
    private readonly sources: SourceFiles,
    private readonly fs: FileSystem,
    private readonly analyzer: ImportAnalyzer,
    private readonly workspace: WorkspaceReader,
    private readonly paths: MetatorPaths,
    private readonly analyzerId: string,
  ) {}

  indexFile(): string {
    return `${this.paths.index}/imports.json`;
  }

  async execute(): Promise<Result<ImportGraphReport, MetatorError>> {
    const files = await this.sources.list(this.analyzer.extensions);
    if (files.isErr()) return err(files.error);
    const packages = await this.workspace.packages();
    if (packages.isErr()) return err(packages.error);

    const previous = await this.loadIndex();
    const next: ImportIndex = { analyzer: this.analyzerId, files: {} };
    const parseErrors: { file: string; message: string }[] = [];
    let parsed = 0;
    let reused = 0;

    for (const file of files.value) {
      const content = await this.fs.read(file);
      if (content.isErr()) continue; // deleted between listing and reading
      const fingerprint = this.analyzer.fingerprint(content.value);
      const cached = previous?.files[file];
      if (cached && cached.fingerprint === fingerprint) {
        next.files[file] = cached;
        reused++;
        continue;
      }
      const imports = this.analyzer.parse(file, content.value);
      if (imports.isErr()) {
        parseErrors.push({ file, message: imports.error.message });
        continue;
      }
      next.files[file] = { fingerprint, imports: [...imports.value] };
      parsed++;
    }

    const edges: Edge[] = [];
    const externals = new Set<string>();
    const unresolved: UnresolvedImport[] = [];
    for (const [from, entry] of Object.entries(next.files)) {
      for (const imp of entry.imports) {
        const target = this.analyzer.resolve(from, imp.specifier);
        if (target.type === "file") {
          edges.push({ from, to: target.path, kind: classifyEdge(from, target.path, packages.value) });
        } else if (target.type === "external") {
          externals.add(target.name);
        } else if (!unresolved.some((u) => u.from === from && u.specifier === imp.specifier)) {
          unresolved.push({ from, specifier: imp.specifier });
        }
      }
    }

    const saved = await this.fs.write(
      this.indexFile(),
      serializeJsonDocument(ImportIndexDocument.stamp(next)),
    );
    if (saved.isErr()) return err(saved.error);

    return ok({
      files: Object.keys(next.files).sort(),
      edges: dedupe(edges),
      packages: packages.value,
      externals: [...externals].sort(),
      unresolved,
      stats: { parsed, reused, failed: parseErrors.length },
      parseErrors,
    });
  }

  /** A stale or unreadable cache is never fatal: it is ignored and rebuilt. */
  private async loadIndex(): Promise<ImportIndex | undefined> {
    const text = await this.fs.read(this.indexFile());
    if (text.isErr()) return undefined;
    const index = parseJsonDocument(text.value, this.indexFile()).andThen((raw) =>
      ImportIndexDocument.parse(raw, this.indexFile()),
    );
    return index.isOk() && index.value.analyzer === this.analyzerId ? index.value : undefined;
  }
}

function dedupe(edges: readonly Edge[]): Edge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** ImportGraphReader backed by the incremental index (used by ComputeAffected). */
export class IndexedImportGraphReader implements ImportGraphReader {
  constructor(private readonly build: BuildImportGraph) {}

  async read(): Promise<Result<readonly Edge[], MetatorError>> {
    return (await this.build.execute()).map((report) => report.edges);
  }
}

/** Read-side queries over the graph, with actionable errors for unknown files. */
export class GraphQueries {
  constructor(private readonly build: BuildImportGraph) {}

  async dependencies(file: string, transitive: boolean): Promise<Result<readonly string[], MetatorError>> {
    return this.withGraph(file, (graph) =>
      (transitive ? graph.dependencyClosure(file) : [...graph.dependenciesOf(file)]).sort(),
    );
  }

  async dependents(file: string, transitive: boolean): Promise<Result<readonly string[], MetatorError>> {
    return this.withGraph(file, (graph) =>
      (transitive
        ? [...graph.affected([file])].filter((f) => f !== file)
        : [...graph.dependentsOf(file)]
      ).sort(),
    );
  }

  async cycles(): Promise<Result<readonly (readonly string[])[], MetatorError>> {
    return (await this.build.execute()).map((report) => new DependencyGraph(report.edges).cycles());
  }

  async path(from: string, to: string): Promise<Result<readonly string[] | null, MetatorError>> {
    return this.withGraph(from, (graph, report) => {
      if (!report.files.includes(to)) return null;
      return graph.path(from, to) ?? null;
    });
  }

  /** Which workspace package each file belongs to, plus cross-package edges per package pair. */
  async packageEdges(): Promise<
    Result<readonly { from: string; to: string; count: number }[], MetatorError>
  > {
    return (await this.build.execute()).map((report) => {
      const counts = new Map<string, number>();
      for (const e of report.edges) {
        if (e.kind !== "cross-package") continue;
        const a = packageOf(e.from, report.packages)?.name ?? "(root)";
        const b = packageOf(e.to, report.packages)?.name ?? "(root)";
        counts.set(`${a}\u0000${b}`, (counts.get(`${a}\u0000${b}`) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([key, count]) => {
          const [from, to] = key.split("\u0000") as [string, string];
          return { from, to, count };
        })
        .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
    });
  }

  private async withGraph<T>(
    file: string,
    query: (graph: DependencyGraph, report: ImportGraphReport) => T,
  ): Promise<Result<T, MetatorError>> {
    const report = await this.build.execute();
    if (report.isErr()) return err(report.error);
    if (!report.value.files.includes(file)) {
      return err(
        new MetatorError("NOT_FOUND", `${file} is not a source file in the import graph`, {
          hint: "Use a repo-relative path to a source file (e.g. packages/app/src/index.ts).",
        }),
      );
    }
    return ok(query(new DependencyGraph(report.value.edges), report.value));
  }
}
