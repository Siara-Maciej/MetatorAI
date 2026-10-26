import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  err,
  type ImportAnalyzer,
  type ImportSpecifier,
  MetatorError,
  type ModuleSymbols,
  normalizePath,
  ok,
  type Resolution,
  type Result,
  type SymbolAnalyzer,
} from "@metator/core";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * JS/TS import analysis on oxc (ADR-0017): oxc-parser for the module record (static imports,
 * re-exports, dynamic imports, `import type`), oxc-resolver for resolution (relative paths,
 * tsconfig paths, package exports, workspace symlinks, `.js` → `.ts` extension aliasing).
 * CommonJS `require()` calls are not analyzed.
 */
export class OxcImportAnalyzer implements ImportAnalyzer, SymbolAnalyzer {
  /** Cache key of the import index: bump when what `parse` extracts changes. */
  static readonly id = "oxc/1";
  readonly extensions = EXTENSIONS;
  private readonly resolver: ResolverFactory;

  constructor(private readonly root: string) {
    const tsconfig = join(root, "tsconfig.json");
    this.resolver = new ResolverFactory({
      extensions: [...EXTENSIONS, ".json"],
      extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] },
      conditionNames: ["import", "module", "default", "require", "node"],
      mainFields: ["module", "main"],
      ...(existsSync(tsconfig) ? { tsconfig: { configFile: tsconfig, references: "auto" as const } } : {}),
    });
  }

  fingerprint(content: string): string {
    return Bun.hash(content).toString(16);
  }

  /** Names a module exports and imports (oxc module record), with 1-based lines. */
  symbols(path: string, content: string): Result<ModuleSymbols, MetatorError> {
    const parsed = this.moduleRecord(path, content);
    if (parsed.isErr()) return err(parsed.error);
    const starts: number[] = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
    const lineAt = (offset: number | null | undefined) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= (offset ?? 0)) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const exports: { name: string; line: number; typeOnly: boolean }[] = [];
    const reexports: ModuleSymbols["reexports"][number][] = [];
    for (const exp of parsed.value.staticExports) {
      for (const e of exp.entries) {
        const exported = e.exportName.kind === "Default" ? "default" : (e.exportName.name ?? "*");
        if (e.moduleRequest) {
          const imported = e.importName.kind === "Name" ? (e.importName.name as string) : "*";
          reexports.push({ specifier: e.moduleRequest.value, imported, exported, line: lineAt(exp.start) });
        } else
          exports.push({ name: exported, line: lineAt(e.exportName.start ?? exp.start), typeOnly: e.isType });
      }
    }
    const imports: ModuleSymbols["imports"][number][] = [];
    for (const imp of parsed.value.staticImports) {
      for (const e of imp.entries) {
        const imported =
          e.importName.kind === "Name"
            ? (e.importName.name as string)
            : e.importName.kind === "Default"
              ? "default"
              : "*";
        imports.push({
          specifier: imp.moduleRequest.value,
          imported,
          local: e.localName.value,
          line: lineAt(imp.start),
          typeOnly: e.isType,
        });
      }
    }
    return ok({ exports, reexports, imports });
  }

  private moduleRecord(path: string, content: string) {
    const parsed = parseSync(path, content);
    const fatal = parsed.errors.filter((e) => e.severity === "Error");
    if (fatal.length > 0) {
      return err(
        new MetatorError("PARSE_FAILED", `${path}: ${fatal[0]?.message ?? "syntax error"}`, {
          details: { path, errors: fatal.slice(0, 5).map((e) => e.message) },
        }),
      );
    }
    return ok(parsed.module);
  }

  parse(path: string, content: string): Result<readonly ImportSpecifier[], MetatorError> {
    const record = this.moduleRecord(path, content);
    if (record.isErr()) return err(record.error);
    const parsed = { module: record.value };
    const imports: ImportSpecifier[] = [];
    for (const imp of parsed.module.staticImports) {
      const typeOnly = imp.entries.length > 0 && imp.entries.every((e) => e.isType);
      imports.push({ specifier: imp.moduleRequest.value, kind: "static", typeOnly });
    }
    for (const exp of parsed.module.staticExports) {
      const fromModule = exp.entries.filter((e) => e.moduleRequest);
      if (fromModule.length === 0) continue;
      const specifier = fromModule[0]?.moduleRequest?.value as string;
      imports.push({ specifier, kind: "reexport", typeOnly: fromModule.every((e) => e.isType) });
    }
    for (const dyn of parsed.module.dynamicImports) {
      const literal = /^(['"`])([^'"`$]+)\1$/.exec(
        content.slice(dyn.moduleRequest.start, dyn.moduleRequest.end),
      );
      if (literal) imports.push({ specifier: literal[2] as string, kind: "dynamic", typeOnly: false });
    }
    return ok(imports);
  }

  resolve(fromPath: string, specifier: string): Resolution {
    const bare = !specifier.startsWith(".") && !isAbsolute(specifier);
    if (specifier.startsWith("node:")) return { type: "external", name: specifier };
    const result = this.resolver.sync(dirname(join(this.root, fromPath)), specifier);
    if (!result.path)
      return bare ? { type: "external", name: packageName(specifier) } : { type: "unresolved" };
    const rel = normalizePath(relative(this.root, result.path));
    const outside = rel.startsWith("../") || rel === ".." || isAbsolute(rel);
    if (outside || rel.startsWith("node_modules/") || rel.includes("/node_modules/")) {
      return { type: "external", name: bare ? packageName(specifier) : rel };
    }
    return { type: "file", path: rel };
  }
}

/** "@scope/pkg/sub/path" → "@scope/pkg", "lodash/fp" → "lodash". */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}
