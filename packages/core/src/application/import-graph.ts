import type { ResolvedImport } from "../domain/architecture.ts";
import { MetatorError } from "../domain/errors.ts";
import { DependencyGraph, type Edge } from "../domain/graph.ts";
import {
  classifyEdge,
  type ImportIndex,
  ImportIndexDocument,
  manifestPath,
  type PackageRef,
  packageOf,
} from "../domain/import-index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type {
  FileSystem,
  ImportAnalyzer,
  ImportGraphReader,
  Resolution,
  WorkspacePackage,
  WorkspaceReader,
} from "../ports/index.ts";
import { parseDocumentText, writeDocument } from "./document-io.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

export interface UnresolvedImport {
  readonly from: string;
  readonly specifier: string;
  /** Where a specifier that is not relative leads: paths an alias maps it to, or a package's directory. */
  readonly candidates?: readonly string[];
}

export interface ImportGraphReport {
  readonly files: readonly string[];
  readonly edges: readonly Edge[];
  readonly packages: readonly WorkspacePackage[];
  readonly externals: readonly string[];
  /** Which file imports which external package or builtin (typeOnly: only through `import type`). */
  readonly externalUses: readonly {
    readonly from: string;
    readonly name: string;
    readonly typeOnly: boolean;
  }[];
  /** Every import that resolved to a file, with its specifier (for the package architecture). */
  readonly imports: readonly ResolvedImport[];
  readonly unresolved: readonly UnresolvedImport[];
  /**
   * Imports of a workspace package by name that led to its manifest: the file they name is not
   * there (deleted, or the package names no entry). A change in the package reaches the importer.
   */
  readonly missingEntries?: readonly UnresolvedImport[];
  readonly stats: { readonly parsed: number; readonly reused: number; readonly failed: number };
  /** What made resolution approximate, from the analyzer. */
  readonly notes?: readonly string[];
  readonly parseErrors: readonly { readonly file: string; readonly message: string }[];
}

/**
 * Where an import leads. A workspace package imported by name is that package's entry whether
 * or not `node_modules` links it (no install yet, or a package manager that links nothing):
 * the entry its manifest names (`exports`, then `main`), or the manifest itself when it names none.
 */
export function resolveImport(
  analyzer: Pick<ImportAnalyzer, "resolve">,
  packages: readonly PackageRef[],
  from: string,
  specifier: string,
): Resolution {
  const target = analyzer.resolve(from, specifier);
  if (target.type !== "external") return target;
  const pkg = packages.find((p) => p.name === target.name);
  if (!pkg || !(specifier === pkg.name || specifier.startsWith(`${pkg.name}/`))) return target;
  const manifest = manifestPath(pkg.dir);
  // From inside the package: its own name (`exports`), then the path under its directory (`main`).
  for (const inside of [specifier, `.${specifier.slice(pkg.name.length)}`]) {
    const entry = analyzer.resolve(manifest, inside);
    if (entry.type === "file") return entry;
  }
  return { type: "file", path: manifest };
}

/**
 * The directory of the workspace package an import names, when the import led to the package's
 * manifest instead of a file (`resolveImport`'s last resort); undefined otherwise.
 */
export function missingPackageEntry(
  packages: readonly PackageRef[],
  specifier: string,
  resolved: string,
): string | undefined {
  const pkg = packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
  // The root package's directory is the repository: every change would count.
  if (!pkg || pkg.dir === "." || pkg.dir === "" || resolved !== manifestPath(pkg.dir)) return undefined;
  return specifier === `${pkg.name}/package.json` ? undefined : `${pkg.dir}/`;
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
    const externalUses = new Map<string, { from: string; name: string; typeOnly: boolean }>();
    const imports: ResolvedImport[] = [];
    const unresolved: UnresolvedImport[] = [];
    const missingEntries: UnresolvedImport[] = [];
    for (const [from, entry] of Object.entries(next.files)) {
      for (const imp of entry.imports) {
        const target = resolveImport(this.analyzer, packages.value, from, imp.specifier);
        if (target.type === "file") {
          edges.push({ from, to: target.path, kind: classifyEdge(from, target.path, packages.value) });
          imports.push({ from, to: target.path, specifier: imp.specifier, typeOnly: imp.typeOnly });
          const dir = missingPackageEntry(packages.value, imp.specifier, target.path);
          if (dir && !missingEntries.some((u) => u.from === from && u.specifier === imp.specifier))
            missingEntries.push({ from, specifier: imp.specifier, candidates: [dir] });
        } else if (target.type === "external") {
          externals.add(target.name);
          const key = `${from}\u0000${target.name}`;
          const typeOnly = imp.typeOnly && (externalUses.get(key)?.typeOnly ?? true);
          externalUses.set(key, { from, name: target.name, typeOnly });
        } else if (!unresolved.some((u) => u.from === from && u.specifier === imp.specifier)) {
          unresolved.push({
            from,
            specifier: imp.specifier,
            ...(target.candidates && target.candidates.length > 0 ? { candidates: target.candidates } : {}),
          });
        }
      }
    }

    const saved = await writeDocument(this.fs, this.indexFile(), ImportIndexDocument, next, "json");
    if (saved.isErr()) return err(saved.error);

    return ok({
      files: Object.keys(next.files).sort(),
      edges: dedupe(edges),
      packages: packages.value,
      externals: [...externals].sort(),
      externalUses: [...externalUses.values()],
      imports,
      unresolved,
      missingEntries,
      stats: { parsed, reused, failed: parseErrors.length },
      parseErrors,
      notes: this.analyzer.notes?.() ?? [],
    });
  }

  /** A stale or unreadable cache is never fatal: it is ignored and rebuilt. */
  private async loadIndex(): Promise<ImportIndex | undefined> {
    const text = await this.fs.read(this.indexFile());
    if (text.isErr()) return undefined;
    const index = parseDocumentText(text.value, this.indexFile(), ImportIndexDocument, "json");
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

  async graph() {
    return (await this.build.execute()).map(({ edges, unresolved, missingEntries }) => ({
      edges,
      unresolved: [...unresolved, ...(missingEntries ?? [])],
    }));
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
