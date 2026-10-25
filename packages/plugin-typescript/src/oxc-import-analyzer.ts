import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  err,
  type ImportAnalyzer,
  type ImportSpecifier,
  MetatorError,
  normalizePath,
  ok,
  type Resolution,
  type Result,
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
export class OxcImportAnalyzer implements ImportAnalyzer {
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

  parse(path: string, content: string): Result<readonly ImportSpecifier[], MetatorError> {
    const parsed = parseSync(path, content);
    const fatal = parsed.errors.filter((e) => e.severity === "Error");
    if (fatal.length > 0) {
      return err(
        new MetatorError("PARSE_FAILED", `${path}: ${fatal[0]?.message ?? "syntax error"}`, {
          details: { path, errors: fatal.slice(0, 5).map((e) => e.message) },
        }),
      );
    }
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
