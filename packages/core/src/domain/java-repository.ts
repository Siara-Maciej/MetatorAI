import {
  conventionalRootKind,
  type JavaBuild,
  type JavaDescriptorFacts,
  type JavaModule,
  type JavaSourceRoot,
  moduleOfPath,
  sourceRootOf,
} from "./java-build.ts";
import { allTypes, type JavaParsedFile, type JavaTypeDecl, rawType } from "./java-model.ts";

/** One parsed source file in the repository model. */
export interface JavaFileRecord {
  readonly path: string;
  readonly facts: JavaParsedFile;
  readonly module: string;
  readonly test: boolean;
  readonly generated: boolean;
}

/** One type with the file it lives in (nested types too). */
export interface JavaTypeEntry {
  readonly decl: JavaTypeDecl;
  readonly file: JavaFileRecord;
  /** The qualified name of the type it is nested in, if any. */
  readonly outer?: string;
}

/** A type as the commands show it: the declaration plus where it lives. */
export interface JavaTypeView extends Omit<JavaTypeDecl, "nested"> {
  readonly package: string;
  readonly at: string;
  readonly module: string;
  readonly test: boolean;
  readonly generated: boolean;
  readonly nested: readonly JavaTypeView[];
}

const JAVA_LANG = new Set([
  "Object",
  "String",
  "Integer",
  "Long",
  "Short",
  "Byte",
  "Double",
  "Float",
  "Boolean",
  "Character",
  "Number",
  "Void",
  "Iterable",
  "Comparable",
  "Runnable",
  "Thread",
  "Exception",
  "RuntimeException",
  "Error",
  "Throwable",
  "Record",
  "Enum",
  "Class",
  "Math",
  "System",
  "Override",
  "Deprecated",
  "FunctionalInterface",
  "SuppressWarnings",
  "AutoCloseable",
  "CharSequence",
  "StringBuilder",
]);

/**
 * The repository's Java model (ADR-0107): the build's modules and every parsed file, with an
 * index of qualified type names. What a later porting workflow plans from: every type knows its
 * module, whether it is test or generated code, and names resolve through the file's imports.
 */
export class JavaRepository {
  readonly types: ReadonlyMap<string, JavaTypeEntry>;
  /** Simple name → qualified names. */
  private readonly bySimple = new Map<string, string[]>();

  constructor(
    readonly build: JavaBuild,
    readonly files: readonly JavaFileRecord[],
    readonly descriptors: readonly {
      readonly path: string;
      readonly facts: JavaDescriptorFacts;
      readonly module: string;
    }[],
  ) {
    const types = new Map<string, JavaTypeEntry>();
    for (const file of files) {
      const walk = (t: JavaTypeDecl, outer?: string) => {
        if (!types.has(t.qualifiedName))
          types.set(t.qualifiedName, { decl: t, file, ...(outer ? { outer } : {}) });
        for (const n of t.nested) walk(n, t.qualifiedName);
      };
      for (const t of file.facts.types) walk(t);
    }
    this.types = types;
    for (const name of types.keys()) {
      const simple = name.slice(name.lastIndexOf(".") + 1);
      this.bySimple.set(simple, [...(this.bySimple.get(simple) ?? []), name]);
    }
  }

  /** Where a repo-relative file belongs: module, test or generated. */
  static place(path: string, build: JavaBuild): { module: string; test: boolean; generated: boolean } {
    const roots: JavaSourceRoot[] = build.modules.flatMap((m) => m.sourceRoots);
    const kind = sourceRootOf(path, roots)?.kind ?? conventionalRootKind(path);
    return {
      module: moduleOfPath(path, build.modules),
      test: kind === "test",
      generated: kind === "generated",
    };
  }

  module(name: string): JavaModule | undefined {
    return this.build.modules.find((m) => m.name === name);
  }

  /** Qualified names with this simple name. */
  named(simple: string): readonly string[] {
    return this.bySimple.get(simple) ?? [];
  }

  /**
   * A type name as written in a file, qualified: nested types of the file, single-type imports,
   * the file's package, on-demand imports; a type of no import stays as written (`String`).
   * Imported types outside the repository come back qualified by their import.
   */
  resolve(written: string, file: JavaFileRecord, context?: string): string {
    const raw = rawType(written).trim();
    if (raw === "" || (/^[a-z]/.test(raw) && !raw.includes("."))) return raw;
    const [head, ...rest] = raw.split(".");
    const tail = rest.length > 0 ? `.${rest.join(".")}` : "";
    if (this.types.has(raw)) return raw;
    // Nested in the type it is written in, or in an outer one.
    if (context)
      for (let c = context; c !== ""; c = c.includes(".") ? c.slice(0, c.lastIndexOf(".")) : "") {
        const candidate = `${c}.${raw}`;
        if (this.types.has(candidate)) return candidate;
      }
    for (const t of allTypes(file.facts.types)) if (t.name === head) return `${t.qualifiedName}${tail}`;
    const imported = file.facts.imports.find((i) => !i.static && !i.onDemand && i.name.endsWith(`.${head}`));
    if (imported) return `${imported.name}${tail}`;
    const pkg = file.facts.package;
    const same = pkg ? `${pkg}.${raw}` : raw;
    if (this.types.has(same)) return same;
    for (const i of file.facts.imports)
      if (i.onDemand && !i.static && this.types.has(`${i.name}.${raw}`)) return `${i.name}.${raw}`;
    if (head && JAVA_LANG.has(head)) return raw;
    return raw;
  }

  /** `List<OrderDto>` with each repository type qualified: `List<com.example.OrderDto>`. */
  resolveExpression(written: string, file: JavaFileRecord, context?: string): string {
    return written.replace(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g, (name) => {
      if (name === "extends" || name === "super") return name;
      const q = this.resolve(name, file, context);
      return this.types.has(q) ? q : name;
    });
  }

  entry(name: string): JavaTypeEntry | undefined {
    return this.types.get(name);
  }

  /** Every supertype of a repository type within the repository (transitive), qualified. */
  supertypes(name: string): string[] {
    const out: string[] = [];
    const visit = (n: string) => {
      const e = this.types.get(n);
      if (!e) return;
      for (const s of [...e.decl.extends, ...e.decl.implements]) {
        const q = this.resolve(s, e.file, e.outer ?? n);
        if (out.includes(q)) continue;
        out.push(q);
        visit(q);
      }
    };
    visit(name);
    return out;
  }

  /** Repository types that extend or implement `name`, directly or not. */
  subtypes(name: string): string[] {
    const out: string[] = [];
    for (const [q] of this.types) if (q !== name && this.supertypes(q).includes(name)) out.push(q);
    return out.sort();
  }

  /** The view of a type: the declaration with its place. */
  view(entry: JavaTypeEntry): JavaTypeView {
    const toView = (t: JavaTypeDecl): JavaTypeView => {
      const { nested, ...rest } = t;
      return {
        ...rest,
        package: entry.file.facts.package,
        at: `${entry.file.path}:${t.line}`,
        module: entry.file.module,
        test: entry.file.test,
        generated: entry.file.generated,
        nested: nested.map(toView),
      };
    };
    return toView(entry.decl);
  }

  /** Files that import a type or (same package, on-demand) name it. */
  usersOf(name: string): string[] {
    const e = this.types.get(name);
    if (!e) return [];
    const simple = e.decl.name;
    const pkg = name.slice(0, name.length - simple.length - 1);
    const top = e.outer ? this.topOf(name) : name;
    const out: string[] = [];
    for (const f of this.files) {
      if (f === e.file) continue;
      const imports = f.facts.imports.some(
        (i) =>
          (!i.onDemand && (i.name === name || i.name === top || i.name.startsWith(`${name}.`))) ||
          (i.onDemand && (i.name === pkg || i.name === top)),
      );
      const samePackage = f.facts.package === pkg;
      if (
        imports ||
        (samePackage && f.facts.references.includes(e.outer ? (top.split(".").pop() as string) : simple))
      )
        if (
          imports ? f.facts.references.includes(simple) || f.facts.imports.some((i) => i.name === name) : true
        )
          out.push(f.path);
    }
    return out.sort();
  }

  private topOf(name: string): string {
    let n = name;
    for (let e = this.types.get(n); e?.outer; e = this.types.get(n)) n = e.outer;
    return n;
  }
}
