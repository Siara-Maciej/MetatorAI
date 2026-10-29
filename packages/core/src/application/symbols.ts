import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  callersOf,
  findSymbol,
  type ResolvedModule,
  type SymbolCaller,
  type SymbolDefinition,
} from "../domain/symbols.ts";
import type { FileSystem, ImportAnalyzer, SymbolAnalyzer } from "../ports/index.ts";
import type { SourceFiles } from "./source-files.ts";

/** `symbols find` and `graph callers` (ADR-0040): every source module's names, resolved to files. */
export class SymbolQueries {
  constructor(
    private readonly sources: SourceFiles,
    private readonly fs: FileSystem,
    private readonly imports: ImportAnalyzer,
    private readonly symbols: SymbolAnalyzer,
  ) {}

  async find(name: string): Promise<
    Result<
      {
        readonly name: string;
        readonly definitions: readonly SymbolDefinition[];
        readonly reexportedBy: readonly string[];
      },
      MetatorError
    >
  > {
    const modules = await this.resolvedModules();
    if (modules.isErr()) return err(modules.error);
    const definitions = findSymbol(name, modules.value);
    const reexportedBy = new Set<string>();
    for (const d of definitions)
      for (const p of callersOf(name, d.file, modules.value).providers)
        if (p.file !== d.file) reexportedBy.add(p.file);
    return ok({ name, definitions, reexportedBy: [...reexportedBy].sort() });
  }

  async callers(input: {
    readonly name: string;
    readonly file?: string;
  }): Promise<
    Result<
      { readonly name: string; readonly definedIn: string; readonly callers: readonly SymbolCaller[] },
      MetatorError
    >
  > {
    const modules = await this.resolvedModules();
    if (modules.isErr()) return err(modules.error);
    const definitions = findSymbol(input.name, modules.value);
    const candidates = input.file ? definitions.filter((d) => d.file === input.file) : definitions;
    if (candidates.length === 0)
      return err(
        MetatorError.notFound(`exported symbol ${input.name}${input.file ? ` in ${input.file}` : ""}`, {
          definedIn: definitions.map((d) => d.file),
        }),
      );
    const files = [...new Set(candidates.map((d) => d.file))];
    if (files.length > 1)
      return err(
        MetatorError.usage(
          `${input.name} is exported by ${files.length} files: ${files.join(", ")}`,
          "Pick one with --file <path>.",
        ),
      );
    const definedIn = files[0] as string;
    return ok({
      name: input.name,
      definedIn,
      callers: callersOf(input.name, definedIn, modules.value).callers,
    });
  }

  /** Every source module's names with their specifiers resolved to files. */
  async resolvedModules(): Promise<Result<Map<string, ResolvedModule>, MetatorError>> {
    const files = await this.sources.list(this.imports.extensions);
    if (files.isErr()) return err(files.error);
    const out = new Map<string, ResolvedModule>();
    for (const file of files.value) {
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      const parsed = this.symbols.symbols(file, text.value);
      if (parsed.isErr()) continue; // a file that does not parse has no usable names
      const target = (specifier: string) => {
        const r = this.imports.resolve(file, specifier);
        return r.type === "file" ? r.path : undefined;
      };
      const withTarget = <T extends { readonly specifier: string }>(items: readonly T[]) =>
        items.flatMap((i) => {
          const t = target(i.specifier);
          return t ? [{ ...i, target: t }] : [];
        });
      out.set(file, {
        exports: parsed.value.exports,
        reexports: withTarget(parsed.value.reexports),
        imports: withTarget(parsed.value.imports),
      });
    }
    return ok(out);
  }
}
