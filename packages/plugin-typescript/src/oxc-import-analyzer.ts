import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
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

const RESOLVE = {
  extensions: [...EXTENSIONS, ".json"],
  extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] },
  conditionNames: ["import", "module", "default", "require", "node"],
  mainFields: ["module", "main"],
};

/**
 * A tsconfig's own `compilerOptions.paths` as resolver aliases (`@/*` → `<baseUrl>/*`, an exact
 * key as `key$`). What it extends is not read; patterns with `*` elsewhere than the end are skipped.
 */
export function pathAliases(tsconfig: string): Record<string, string[]> {
  let options: { baseUrl?: unknown; paths?: unknown };
  try {
    const parsed = Bun.JSONC.parse(readFileSync(tsconfig, "utf8")) as { compilerOptions?: typeof options };
    options = parsed?.compilerOptions ?? {};
  } catch {
    return {};
  }
  const base = join(dirname(tsconfig), typeof options.baseUrl === "string" ? options.baseUrl : ".");
  const aliases: Record<string, string[]> = {};
  const paths = options.paths && typeof options.paths === "object" ? options.paths : {};
  for (const [key, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(targets)) continue;
    const wild = key.endsWith("/*");
    if (key.slice(0, wild ? -2 : undefined).includes("*")) continue;
    const to = targets
      .filter((t): t is string => typeof t === "string" && (wild ? t.endsWith("/*") : !t.includes("*")))
      .map((t) => join(base, wild ? t.slice(0, -2) : t));
    if (to.length > 0) aliases[wild ? key.slice(0, -2) : `${key}$`] = to;
  }
  return aliases;
}

/**
 * JS/TS import analysis on oxc (ADR-0017): oxc-parser for the module record (static imports,
 * re-exports, dynamic imports, `import type`), oxc-resolver for resolution (relative paths,
 * tsconfig paths, package exports, workspace symlinks, `.js` → `.ts` extension aliasing).
 * Each file resolves through its nearest `tsconfig.json` (apps of a monorepo keep their own
 * `paths`). A tsconfig oxc cannot load (it extends a package that is not installed) would fail
 * every import, so its own `paths` become aliases instead, and `notes()` says so.
 * CommonJS `require()` calls are not analyzed.
 */
export class OxcImportAnalyzer implements ImportAnalyzer, SymbolAnalyzer {
  /** Cache key of the import index: bump when what `parse` extracts changes. */
  static readonly id = "oxc/1";
  readonly extensions = EXTENSIONS;
  /** By tsconfig file ("" for none). */
  private readonly resolvers = new Map<string, ResolverFactory>();
  /** By directory: the nearest tsconfig.json up to the root, or "". */
  private readonly nearest = new Map<string, string>();
  private readonly degraded: string[] = [];

  constructor(private readonly root: string) {}

  /** Tsconfigs read without what they extend (not installed): resolution is approximate there. */
  notes(): readonly string[] {
    return this.degraded.map(
      (t) =>
        `${normalizePath(relative(this.root, t))} extends a config that is not installed; its own paths are used as aliases. Install dependencies for exact resolution.`,
    );
  }

  private tsconfigFor(dir: string): string {
    const known = this.nearest.get(dir);
    if (known !== undefined) return known;
    const here = join(dir, "tsconfig.json");
    const parent = dirname(dir);
    const found = existsSync(here)
      ? here
      : dir === this.root || parent === dir || relative(this.root, dir).startsWith("..")
        ? ""
        : this.tsconfigFor(parent);
    this.nearest.set(dir, found);
    return found;
  }

  private resolverFor(tsconfig: string): ResolverFactory {
    const known = this.resolvers.get(tsconfig);
    if (known) return known;
    let resolver = new ResolverFactory({
      ...RESOLVE,
      ...(tsconfig ? { tsconfig: { configFile: tsconfig, references: "auto" as const } } : {}),
    });
    // The tsconfig itself always resolves; when it does not, oxc could not load the config.
    if (tsconfig && !resolver.sync(dirname(tsconfig), "./tsconfig.json").path) {
      resolver = new ResolverFactory({ ...RESOLVE, alias: pathAliases(tsconfig) });
      this.degraded.push(tsconfig);
    }
    this.resolvers.set(tsconfig, resolver);
    return resolver;
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
    // `fs`, `path/posix`: builtins read as `node:` ones, never as packages to declare.
    if (bare && isBuiltin(specifier)) return { type: "external", name: `node:${specifier}` };
    const dir = dirname(join(this.root, fromPath));
    const result = this.resolverFor(this.tsconfigFor(dir)).sync(dir, specifier);
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
