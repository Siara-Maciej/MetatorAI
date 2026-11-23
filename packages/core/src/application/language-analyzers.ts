import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ModuleSymbols } from "../domain/symbols.ts";
import type {
  ImportAnalyzer,
  ImportSpecifier,
  Resolution,
  SymbolAnalyzer,
  WorkspacePackage,
  WorkspaceReader,
} from "../ports/index.ts";

/** One language: its import analyzer and, when it has one, its symbol analyzer. */
export interface LanguageAnalyzer {
  readonly imports: ImportAnalyzer;
  readonly symbols?: SymbolAnalyzer;
}

/**
 * Several languages behind the one `ImportAnalyzer` and `SymbolAnalyzer` the use cases take
 * (ADR-0107): each file goes to the analyzer of its extension, an import resolves with the
 * analyzer of the file it is written in. A repository with TypeScript and Java builds one graph.
 */
export class AnalyzerByExtension implements ImportAnalyzer, SymbolAnalyzer {
  readonly extensions: readonly string[];

  constructor(private readonly languages: readonly LanguageAnalyzer[]) {
    this.extensions = [...new Set(languages.flatMap((l) => l.imports.extensions))];
  }

  private of(path: string | undefined): LanguageAnalyzer | undefined {
    if (path === undefined) return this.languages[0];
    return this.languages.find((l) => l.imports.extensions.some((ext) => path.endsWith(ext)));
  }

  fingerprint(content: string, path?: string): string {
    const language = this.of(path) ?? this.languages[0];
    return language ? language.imports.fingerprint(content, path) : "";
  }

  parse(path: string, content: string): Result<readonly ImportSpecifier[], MetatorError> {
    const language = this.of(path);
    if (!language)
      return err(new MetatorError("PARSE_FAILED", `${path}: no analyzer reads this kind of file`));
    return language.imports.parse(path, content);
  }

  resolve(fromPath: string, specifier: string): Resolution {
    // A workspace package's manifest (package.json) resolves its entry with the JavaScript analyzer.
    const language = this.of(fromPath) ?? this.languages[0];
    return language ? language.imports.resolve(fromPath, specifier) : { type: "unresolved" };
  }

  notes(): readonly string[] {
    return this.languages.flatMap((l) => l.imports.notes?.() ?? []);
  }

  symbols(path: string, content: string): Result<ModuleSymbols, MetatorError> {
    const language = this.of(path);
    if (!language?.symbols) return ok({ exports: [], reexports: [], imports: [] });
    return language.symbols.symbols(path, content);
  }
}

/** The cache key of the import index for several analyzers: `oxc/1+java/1`. */
export const analyzersId = (ids: readonly string[]): string => ids.join("+");

/**
 * The workspace packages of every build in the repository: the JavaScript workspace's, then the
 * Java modules (ADR-0107). A directory claimed twice keeps the first; a reader that fails fails all.
 */
export class MergedWorkspace implements WorkspaceReader {
  constructor(private readonly readers: readonly WorkspaceReader[]) {}

  async packages(): Promise<Result<readonly WorkspacePackage[], MetatorError>> {
    const out: WorkspacePackage[] = [];
    for (const reader of this.readers) {
      const packages = await reader.packages();
      if (packages.isErr()) return err(packages.error);
      for (const p of packages.value) if (!out.some((o) => o.dir === p.dir)) out.push(p);
    }
    return ok(out);
  }
}
