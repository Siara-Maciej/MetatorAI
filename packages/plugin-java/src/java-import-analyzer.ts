import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ImportAnalyzer,
  type ImportSpecifier,
  type MetatorError,
  type ModuleSymbols,
  ok,
  type Resolution,
  type Result,
  type SymbolAnalyzer,
} from "@metator/core";
import { lexJava } from "./java-lexer.ts";

/** Folders never holding a repository's own Java sources. */
const SKIP = new Set(["node_modules", ".git", ".metator", ".gradle", ".idea", ".mvn"]);

/** Top-level declarations at the start of a line: how almost every formatter writes them. */
const TOP_LEVEL =
  /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|abstract|final|sealed|non-sealed|static|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/gm;

/** The fully qualified names of the repository's top-level types, by name, and the packages they make. */
export interface JavaTypeIndex {
  readonly files: ReadonlyMap<string, string>;
  readonly packages: ReadonlySet<string>;
  /** Changes whenever a type is added, removed or moved: parse output depends on it. */
  readonly digest: string;
}

/** Package and top-level type names of one file, read with patterns (no parse): cheap for every file. */
export function declaredTypes(path: string, content: string): { package: string; types: string[] } {
  const pkg =
    /^\s*package\s+([\w.\s]+?)\s*;/m
      .exec(content.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1]
      ?.replace(/\s+/g, "") ?? "";
  const stem = path.slice(path.lastIndexOf("/") + 1, -".java".length);
  const types = new Set([stem]);
  for (const m of content.matchAll(TOP_LEVEL)) types.add(m[1] as string);
  return { package: pkg, types: [...types] };
}

/** Every `.java` file of the repository, repo-relative. */
function javaFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || (e.name.startsWith(".") && e.isDirectory())) continue;
      const path = dir === "" ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) visit(path);
      else if (e.isFile() && e.name.endsWith(".java")) out.push(path);
    }
  };
  visit("");
  return out.sort();
}

export function buildTypeIndex(root: string, files: readonly string[] = javaFiles(root)): JavaTypeIndex {
  const byName = new Map<string, string>();
  const packages = new Set<string>();
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const d = declaredTypes(file, content);
    if (d.package) packages.add(d.package);
    for (const t of d.types) {
      const fqn = d.package ? `${d.package}.${t}` : t;
      // Two files declaring one name (a generated copy): the first in path order wins.
      if (!byName.has(fqn)) byName.set(fqn, file);
    }
  }
  const lines = [...byName.entries()].map(([k, v]) => `${k}=${v}`).sort();
  return { files: byName, packages, digest: Bun.hash(lines.join("\n")).toString(16) };
}

/** The package part of a qualified name: the segments before the first capitalized one. */
export function packageOf(name: string): string {
  const parts = name.split(".");
  const i = parts.findIndex((p) => /^[A-Z]/.test(p));
  return (i < 0 ? parts.slice(0, -1) : parts.slice(0, i)).join(".");
}

/**
 * Java import analysis (ADR-0107): imports and the type names a file uses are lexical, so they
 * come from a tokenizer that never fails, and resolve through an index of the repository's
 * fully qualified type names (every `.java` file of every source root of every module):
 * - `import a.b.C` → C's file; `import a.b.C.Inner` → C's file; `import static a.b.C.m` → C's file;
 * - `import a.b.*` and the file's own package: each type the file names that the package declares;
 * - JDK and third-party types are external, named `java:<package>` (never an npm package).
 * What a file's imports become depends on the index, so its fingerprint carries the index's digest.
 */
export class JavaImportAnalyzer implements ImportAnalyzer, SymbolAnalyzer {
  /** Cache key of the import index: bump when what `parse` extracts changes. */
  static readonly id = "java/1";
  readonly extensions = [".java"] as const;
  private index: JavaTypeIndex | undefined;

  constructor(
    private readonly root: string,
    private readonly indexOf: (root: string) => JavaTypeIndex = buildTypeIndex,
  ) {}

  private types(): JavaTypeIndex {
    this.index ??= this.indexOf(this.root);
    return this.index;
  }

  fingerprint(content: string): string {
    return `${Bun.hash(content).toString(16)}:${this.types().digest}`;
  }

  /** The repository file of a qualified type name (or of its outer type), if any. */
  fileOf(name: string): string | undefined {
    const files = this.types().files;
    for (let n = name; n.includes("."); n = n.slice(0, n.lastIndexOf("."))) {
      const file = files.get(n);
      if (file) return file;
    }
    return files.get(name);
  }

  /** The qualified names a file depends on, each with the line it first appears on. */
  private dependencies(
    path: string,
    content: string,
  ): { name: string; local: string; imported: string; line: number }[] {
    const lex = lexJava(content);
    const index = this.types();
    const out: { name: string; local: string; imported: string; line: number }[] = [];
    const seen = new Set<string>();
    const add = (name: string, local: string, imported: string, line: number) => {
      const key = `${name}\u0000${local}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name, local, imported, line });
    };
    const explicit = new Set<string>();
    const onDemand: string[] = [];
    for (const imp of lex.imports) {
      if (imp.static) {
        const owner = imp.onDemand ? imp.name : imp.name.slice(0, imp.name.lastIndexOf("."));
        add(
          owner,
          imp.onDemand ? "*" : imp.name.slice(imp.name.lastIndexOf(".") + 1),
          imp.onDemand ? "*" : imp.name.slice(imp.name.lastIndexOf(".") + 1),
          imp.line,
        );
      } else if (imp.onDemand) {
        if (index.packages.has(imp.name)) onDemand.push(imp.name);
        else add(`${imp.name}.*`, "*", "*", imp.line);
      } else {
        const simple = imp.name.slice(imp.name.lastIndexOf(".") + 1);
        explicit.add(simple);
        add(imp.name, simple, simple, imp.line);
      }
    }
    for (const [ref, line] of lex.references) {
      if (explicit.has(ref) || lex.declared.has(ref)) continue;
      for (const pkg of [lex.package, ...onDemand]) {
        const fqn = pkg ? `${pkg}.${ref}` : ref;
        const file = index.files.get(fqn);
        if (file && file !== path) {
          add(fqn, ref, ref, line);
          break;
        }
      }
    }
    return out;
  }

  parse(path: string, content: string): Result<readonly ImportSpecifier[], MetatorError> {
    return ok(
      [...new Set(this.dependencies(path, content).map((d) => d.name))].map((specifier) => ({
        specifier,
        kind: "static" as const,
        typeOnly: false,
      })),
    );
  }

  resolve(_fromPath: string, specifier: string): Resolution {
    if (specifier.endsWith(".*")) {
      const pkg = specifier.slice(0, -2);
      return this.types().packages.has(pkg)
        ? { type: "unresolved" }
        : { type: "external", name: `java:${pkg}` };
    }
    const file = this.fileOf(specifier);
    if (file) return { type: "file", path: file };
    const pkg = packageOf(specifier);
    // A type of one of the repository's own packages that no file declares: a missing file.
    if (this.types().packages.has(pkg)) return { type: "unresolved" };
    return { type: "external", name: `java:${pkg || specifier}` };
  }

  /** Top-level types and their public members (`Type.member`); imports by simple name. */
  symbols(path: string, content: string): Result<ModuleSymbols, MetatorError> {
    const lex = lexJava(content);
    const exports: { name: string; line: number; typeOnly: boolean }[] = [];
    for (const t of lex.types) {
      exports.push({ name: t.name, line: t.line, typeOnly: false });
      for (const m of t.members)
        if (m.public && !exports.some((e) => e.name === `${t.name}.${m.name}`))
          exports.push({ name: `${t.name}.${m.name}`, line: m.line, typeOnly: false });
    }
    const imports = this.dependencies(path, content)
      .filter((d) => !d.name.endsWith(".*"))
      .map((d) => ({
        specifier: d.name,
        imported: d.imported,
        local: d.local,
        line: d.line,
        typeOnly: false,
      }));
    return ok({ exports, reexports: [], imports });
  }
}
