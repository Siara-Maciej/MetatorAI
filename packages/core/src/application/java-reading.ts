import { MetatorError } from "../domain/errors.ts";
import { type JavaBean, javaBeans } from "../domain/java-beans.ts";
import {
  isJavaDescriptor,
  type JavaDescriptorFacts,
  type JavaModule,
  moduleOfPath,
} from "../domain/java-build.ts";
import { type JavaEndpoint, type JavaWebFramework, javaEndpoints } from "../domain/java-endpoints.ts";
import {
  configKeys,
  configReads,
  type JavaConfigKey,
  type JavaConfigRead,
  type JavaEntrypoint,
  type JavaFramework,
  javaEntrypoints,
  javaFrameworks,
} from "../domain/java-facts.ts";
import {
  type JavaIndex,
  JavaIndexDocument,
  type JavaTypeKind,
  rawType,
  simpleAnnotationName,
} from "../domain/java-model.ts";
import {
  type JavaDataRepository,
  type JavaEntity,
  type JavaPersistenceUnitFact,
  javaEntities,
  javaRepositories,
  persistenceUnits,
} from "../domain/java-persistence.ts";
import { type JavaFileRecord, JavaRepository, type JavaTypeView } from "../domain/java-repository.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { serializeJsonLine } from "../domain/versioned.ts";
import type {
  Clock,
  ContentHasher,
  FileSystem,
  JavaBuildReader,
  JavaDescriptorParser,
  JavaSourceParser,
} from "../ports/index.ts";
import { parseDocumentText } from "./document-io.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

export interface JavaIndexReport {
  readonly current: boolean;
  readonly files: number;
  readonly parsed: number;
  readonly reused: number;
  readonly failed: number;
  readonly ms: number;
  readonly path: string;
  readonly stale?: readonly string[];
}

export interface JavaParseFailure {
  readonly file: string;
  readonly message: string;
  readonly line?: number;
}

/** What every list command filters by: a module (exact) and a package prefix. */
export interface JavaFilter {
  readonly module?: string;
  readonly package?: string;
}

export interface JavaOverview {
  readonly buildTools: readonly string[];
  readonly modules: readonly { readonly name: string; readonly dir: string; readonly profile?: string }[];
  readonly javaVersions: readonly {
    readonly version: string;
    readonly module: string;
    readonly evidence: { readonly at: string; readonly source: string };
  }[];
  readonly sourceRoots: readonly {
    readonly path: string;
    readonly kind: string;
    readonly declared: boolean;
    readonly module: string;
  }[];
  readonly counts: {
    readonly files: number;
    readonly types: number;
    readonly endpoints: number;
    readonly entities: number;
    readonly repositories: number;
    readonly beans: number;
    readonly configKeys: number;
    readonly entrypoints: number;
  };
  readonly frameworks: readonly JavaFramework[];
  readonly parseFailures: readonly JavaParseFailure[];
  readonly notes: readonly string[];
  readonly index: {
    readonly files: number;
    readonly parsed: number;
    readonly reused: number;
    readonly ms: number;
  };
}

export interface JavaTypeLine {
  readonly name: string;
  readonly kind: JavaTypeKind;
  readonly at: string;
  readonly module: string;
  readonly annotations: readonly string[];
  readonly extends: readonly string[];
  readonly implements: readonly string[];
  readonly test: boolean;
  readonly generated: boolean;
}

export interface JavaShow {
  readonly type: JavaTypeView;
  readonly supertypes: readonly string[];
  readonly subtypes: readonly { readonly name: string; readonly at: string }[];
  readonly usedBy: readonly { readonly file: string }[];
  readonly roles: readonly string[];
}

interface Loaded {
  readonly repo: JavaRepository;
  readonly failures: readonly JavaParseFailure[];
  readonly stats: {
    readonly files: number;
    readonly parsed: number;
    readonly reused: number;
    readonly ms: number;
  };
}

const INDEX_FILE = "java.json";

/**
 * Reads a Java repository into its model and answers the `metator java` commands (ADR-0107).
 * Parsing is cached per file in the JavaIndex document by content fingerprint; the build, the
 * descriptors and every framework fact are read again each time (they are cheap and depend on
 * other files). A file with a syntax error is reported and the rest is read.
 */
export class ReadJava {
  private loaded: Promise<Result<Loaded, MetatorError>> | undefined;

  constructor(
    private readonly sources: SourceFiles,
    private readonly fs: FileSystem,
    private readonly build: JavaBuildReader,
    private readonly parser: JavaSourceParser,
    private readonly descriptors: JavaDescriptorParser,
    private readonly hasher: ContentHasher,
    private readonly clock: Clock,
    private readonly paths: MetatorPaths,
  ) {}

  indexFile(): string {
    return `${this.paths.index}/${INDEX_FILE}`;
  }

  /** The `.java` files to read: git's view of the repository, plus generated source roots (often git-ignored). */
  private async javaFiles(modules: readonly JavaModule[]): Promise<Result<string[], MetatorError>> {
    const listed = await this.sources.list([".java"]);
    if (listed.isErr()) return err(listed.error);
    const files = new Set(listed.value);
    // Every source root is read whole: a generated one is often git-ignored, and a package may be
    // named like a build output (`org.hibernate.internal.build`) that the source ignores leave out.
    const roots = modules.flatMap((m) => m.sourceRoots.map((r) => `${r.path}/**/*.java`));
    if (roots.length > 0) for (const f of await this.fs.glob(roots)) files.add(f);
    return ok([...files].sort());
  }

  private async loadIndex(): Promise<JavaIndex | undefined> {
    const text = await this.fs.read(this.indexFile());
    if (text.isErr()) return undefined;
    const index = parseDocumentText(text.value, this.indexFile(), JavaIndexDocument, "json");
    return index.isOk() && index.value.parser === this.parser.id ? index.value : undefined;
  }

  /** Builds or refreshes the cache; with `check`, only says whether it is current (STALE_INDEX when not). */
  async index(input: { readonly check?: boolean } = {}): Promise<Result<JavaIndexReport, MetatorError>> {
    if (input.check) {
      const build = await this.build.read();
      if (build.isErr()) return err(build.error);
      const files = await this.javaFiles(build.value.modules);
      if (files.isErr()) return err(files.error);
      const previous = await this.loadIndex();
      const stale: string[] = [];
      for (const file of files.value) {
        const content = await this.fs.read(file);
        if (content.isErr()) continue;
        if (previous?.files[file]?.fingerprint !== this.hasher.sha256(content.value)) stale.push(file);
      }
      for (const file of Object.keys(previous?.files ?? {}))
        if (!files.value.includes(file)) stale.push(file);
      const report = {
        current: previous !== undefined && stale.length === 0,
        files: files.value.length,
        parsed: 0,
        reused: files.value.length - stale.length,
        failed: Object.values(previous?.files ?? {}).filter((f) => f.facts.error).length,
        ms: 0,
        path: this.indexFile(),
        stale: stale.sort(),
      };
      if (report.current) return ok(report);
      return err(
        new MetatorError(
          "STALE_INDEX",
          `the Java index is not current: ${stale.length} file(s) changed, new or gone`,
          {
            hint: "Run `metator java index` to refresh it (every `metator java` command refreshes it too).",
            details: { ...report },
          },
        ),
      );
    }
    const loaded = await this.load();
    if (loaded.isErr()) return err(loaded.error);
    const { stats, failures } = loaded.value;
    return ok({ current: true, ...stats, failed: failures.length, path: this.indexFile() });
  }

  private load(): Promise<Result<Loaded, MetatorError>> {
    this.loaded ??= this.loadNow();
    return this.loaded;
  }

  private async loadNow(): Promise<Result<Loaded, MetatorError>> {
    const started = this.clock.now().getTime();
    const build = await this.build.read();
    if (build.isErr()) return err(build.error);
    const files = await this.javaFiles(build.value.modules);
    if (files.isErr()) return err(files.error);
    const previous = await this.loadIndex();
    const next: JavaIndex = { parser: this.parser.id, files: {} };
    let parsed = 0;
    let reused = 0;
    const records: JavaFileRecord[] = [];
    const failures: JavaParseFailure[] = [];
    for (const file of files.value) {
      const content = await this.fs.read(file);
      if (content.isErr()) continue;
      const fingerprint = this.hasher.sha256(content.value);
      const cached = previous?.files[file];
      let facts = cached?.fingerprint === fingerprint ? cached.facts : undefined;
      if (facts) reused++;
      else {
        const result = await this.parser.parse(file, content.value);
        if (result.isErr()) {
          // The parser itself cannot run (its grammar is missing): nothing can be read.
          if (result.error.code !== "PARSE_FAILED") return err(result.error);
          failures.push({ file, message: result.error.message });
          continue;
        }
        facts = result.value;
        parsed++;
      }
      next.files[file] = { fingerprint, facts };
      if (facts.error)
        failures.push({
          file,
          message: facts.error.message,
          ...(facts.error.line ? { line: facts.error.line } : {}),
        });
      records.push({ path: file, facts, ...JavaRepository.place(file, build.value) });
    }
    if (parsed > 0 || !previous || Object.keys(previous.files).length !== Object.keys(next.files).length) {
      // One line: the index of an enterprise repository is hundreds of megabytes indented.
      const saved = await this.fs.write(this.indexFile(), serializeJsonLine(JavaIndexDocument.stamp(next)));
      if (saved.isErr()) return err(saved.error);
    }
    const all = await this.sources.list();
    if (all.isErr()) return err(all.error);
    const descriptors: { path: string; facts: JavaDescriptorFacts; module: string }[] = [];
    for (const path of all.value.filter(isJavaDescriptor)) {
      const text = await this.fs.read(path);
      if (text.isErr()) continue;
      const facts = this.descriptors.parse(path, text.value);
      if (facts.isErr()) {
        failures.push({ file: path, message: facts.error.message });
        continue;
      }
      descriptors.push({ path, facts: facts.value, module: moduleOfPath(path, build.value.modules) });
    }
    return ok({
      repo: new JavaRepository(build.value, records, descriptors),
      failures,
      stats: { files: files.value.length, parsed, reused, ms: this.clock.now().getTime() - started },
    });
  }

  private async with<T>(f: (repo: JavaRepository, loaded: Loaded) => T): Promise<Result<T, MetatorError>> {
    const loaded = await this.load();
    if (loaded.isErr()) return err(loaded.error);
    return ok(f(loaded.value.repo, loaded.value));
  }

  async overview(): Promise<Result<JavaOverview, MetatorError>> {
    return this.with((repo, loaded) => {
      const modules = repo.build.modules;
      return {
        buildTools: repo.build.tools,
        modules: modules.map((m) => ({
          name: m.name,
          dir: m.dir,
          ...(m.profile ? { profile: m.profile } : {}),
        })),
        javaVersions: modules.flatMap((m) =>
          m.javaVersion
            ? [{ version: m.javaVersion.version, module: m.name, evidence: m.javaVersion.evidence }]
            : [],
        ),
        sourceRoots: modules.flatMap((m) => m.sourceRoots.map((r) => ({ ...r, module: m.name }))),
        counts: {
          files: repo.files.length,
          types: repo.types.size,
          endpoints: javaEndpoints(repo).length,
          entities: javaEntities(repo).length,
          repositories: javaRepositories(repo).length,
          beans: javaBeans(repo).length,
          configKeys: configKeys(repo).length,
          entrypoints: javaEntrypoints(repo).length,
        },
        frameworks: javaFrameworks(repo),
        parseFailures: loaded.failures,
        notes: repo.build.notes,
        index: loaded.stats,
      };
    });
  }

  async modules(filter: JavaFilter = {}) {
    return this.with((repo) => ({
      modules: repo.build.modules
        .filter((m) => !filter.module || m.name === filter.module)
        .map((m) => ({
          ...m,
          dependsOn: [...new Set(m.dependencies.flatMap((d) => (d.module ? [d.module] : [])))],
          external: m.dependencies
            .filter((d) => !d.module)
            .map((d) => ({
              coordinate: [d.group, d.artifact, d.version].filter((x) => x).join(":"),
              scope: d.scope,
            })),
        })),
    }));
  }

  private inScope(filter: JavaFilter, module: string, name: string): boolean {
    if (filter.module && module !== filter.module) return false;
    if (filter.package && !(name === filter.package || name.startsWith(`${filter.package}.`))) return false;
    return true;
  }

  async types(
    input: JavaFilter & {
      readonly kind?: JavaTypeKind;
      readonly annotated?: string;
      readonly implements?: string;
    },
  ): Promise<Result<{ readonly types: readonly JavaTypeLine[] }, MetatorError>> {
    return this.with((repo) => {
      const out: JavaTypeLine[] = [];
      const wanted = input.annotated?.replace(/^@/, "");
      for (const [name, e] of repo.types) {
        const d = e.decl;
        if (!this.inScope(input, e.file.module, name)) continue;
        if (input.kind && d.kind !== input.kind) continue;
        if (
          wanted &&
          !d.annotations.some((a) => simpleAnnotationName(a.name) === simpleAnnotationName(wanted))
        )
          continue;
        const context = e.outer ?? name;
        const supers = [...d.extends, ...d.implements];
        if (input.implements) {
          const all = repo.supertypes(name);
          const target = input.implements;
          const hit = [...all, ...supers].some(
            (s) => s === target || rawType(s) === target || rawType(s).split(".").pop() === target,
          );
          if (!hit) continue;
        }
        out.push({
          name,
          kind: d.kind,
          at: `${e.file.path}:${d.line}`,
          module: e.file.module,
          annotations: d.annotations.map((a) => simpleAnnotationName(a.name)),
          extends: d.extends.map((s) => repo.resolveExpression(s, e.file, context)),
          implements: d.implements.map((s) => repo.resolveExpression(s, e.file, context)),
          test: e.file.test,
          generated: e.file.generated,
        });
      }
      return { types: out.sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }

  /** One type in full: a qualified name, or a simple name only one type has. */
  async show(name: string): Promise<Result<JavaShow, MetatorError>> {
    const loaded = await this.load();
    if (loaded.isErr()) return err(loaded.error);
    const repo = loaded.value.repo;
    let qualified = repo.types.has(name) ? name : undefined;
    if (!qualified) {
      const candidates = repo.named(name);
      if (candidates.length > 1)
        return err(
          new MetatorError("AMBIGUOUS", `${candidates.length} types are named ${name}`, {
            hint: "Give the fully qualified name.",
            details: { candidates: [...candidates].sort() },
          }),
        );
      qualified = candidates[0];
    }
    const entry = qualified ? repo.entry(qualified) : undefined;
    if (!qualified || !entry)
      return err(
        new MetatorError("NOT_FOUND", `no type ${name} in this repository`, {
          hint: "`metator java types` lists them; a simple name or a fully qualified one.",
        }),
      );
    const roles: string[] = [];
    if (javaBeans(repo).some((b) => b.type === qualified)) roles.push("bean");
    if (javaEntities(repo).some((e) => e.type === qualified)) roles.push("entity");
    if (javaRepositories(repo).some((r) => r.type === qualified)) roles.push("repository");
    if (javaEndpoints(repo).some((e) => e.handler === qualified || e.handler.startsWith(`${qualified}#`)))
      roles.push("endpoint");
    if (javaEntrypoints(repo).some((e) => e.handler === qualified || e.handler.startsWith(`${qualified}#`)))
      roles.push("entrypoint");
    if (configReads(repo).some((r) => r.type === qualified && r.via === "@ConfigurationProperties"))
      roles.push("config-properties");
    return ok({
      type: repo.view(entry),
      supertypes: repo.supertypes(qualified),
      subtypes: repo.subtypes(qualified).map((s) => {
        const e = repo.entry(s);
        return { name: s, at: e ? `${e.file.path}:${e.decl.line}` : "" };
      }),
      usedBy: repo.usersOf(qualified).map((file) => ({ file })),
      roles,
    });
  }

  async endpoints(input: JavaFilter & { readonly framework?: JavaWebFramework }) {
    return this.with((repo) => ({
      endpoints: javaEndpoints(repo).filter(
        (e: JavaEndpoint) =>
          (!input.framework || e.framework === input.framework) &&
          this.inScope(input, e.module, e.handler.split("#")[0] as string),
      ),
    }));
  }

  async entities(input: JavaFilter) {
    return this.with((repo) => ({
      entities: javaEntities(repo).filter((e: JavaEntity) => this.inScope(input, e.module, e.type)),
      persistenceUnits: persistenceUnits(repo).filter(
        (u: JavaPersistenceUnitFact) =>
          !input.module || moduleOfPath(u.at, repo.build.modules) === input.module,
      ),
    }));
  }

  async repositories(input: JavaFilter) {
    return this.with((repo) => ({
      repositories: javaRepositories(repo).filter((r: JavaDataRepository) =>
        this.inScope(input, r.module, r.type),
      ),
    }));
  }

  async beans(input: JavaFilter & { readonly injects?: string }) {
    return this.with((repo) => {
      const injects = input.injects;
      const matches = (type: string) =>
        !injects ||
        type === injects ||
        (type.split(".").pop() === injects.split(".").pop() && (!injects.includes(".") || type === injects));
      return {
        beans: javaBeans(repo).filter(
          (b: JavaBean) =>
            this.inScope(input, b.module, b.type) && (!injects || b.injections.some((i) => matches(i.type))),
        ),
      };
    });
  }

  async config(input: JavaFilter & { readonly key?: string }) {
    return this.with((repo) => {
      const key = input.key;
      const wanted = (k: string) => !key || k === key || k.startsWith(`${key}.`) || k.startsWith(`${key}[`);
      return {
        keys: configKeys(repo).filter(
          (k: JavaConfigKey) =>
            wanted(k.key) && (!input.module || moduleOfPath(k.at, repo.build.modules) === input.module),
        ),
        reads: configReads(repo).filter(
          (r: JavaConfigRead) =>
            wanted(r.key) && this.inScope(input, moduleOfPath(r.at, repo.build.modules), r.type),
        ),
      };
    });
  }

  async entrypoints(input: JavaFilter) {
    return this.with((repo) => ({
      entrypoints: javaEntrypoints(repo).filter((e: JavaEntrypoint) =>
        this.inScope(input, e.module, e.handler.split("#")[0] as string),
      ),
    }));
  }
}
