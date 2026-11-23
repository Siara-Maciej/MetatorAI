/**
 * A Java build as read from its files, without running it (ADR-0107): Maven POMs and Gradle
 * scripts give the modules, their source roots and dependencies; web.xml, persistence.xml,
 * Spring XML and `application*.{properties,yml}` give the descriptors framework rules read.
 */

export type JavaBuildTool = "maven" | "gradle";

/** Where a fact comes from: `path:line` and what made it. */
export interface JavaEvidence {
  readonly at: string;
  readonly source: string;
}

export interface JavaSourceRoot {
  /** Repo-relative directory: `shop-api/src/main/java`. */
  readonly path: string;
  readonly kind: "main" | "test" | "generated";
  /** Declared in the build (`<sourceDirectory>`, `sourceSets`) rather than the convention. */
  readonly declared: boolean;
}

export interface JavaDependency {
  readonly group: string;
  readonly artifact: string;
  /** Resolved from `${...}` along the POM chain when it can be, else as written. */
  readonly version?: string;
  /** Maven scope (`compile` when none) or Gradle configuration (`implementation`). */
  readonly scope: string;
  /** Another module of this build. */
  readonly module?: string;
  /** Where the build file declares it. */
  readonly line?: number;
}

export interface JavaModule {
  /** Maven artifactId; Gradle project path without the leading `:` (`app`, `libs:core`). */
  readonly name: string;
  /** Repo-relative, `.` for the root. */
  readonly dir: string;
  readonly build: JavaBuildTool;
  readonly buildFile: string;
  readonly group?: string;
  readonly version?: string;
  readonly packaging?: string;
  /** The parent module's name when it is in the build, else `group:artifact:version`. */
  readonly parent?: string;
  /** Set when only a Maven profile's `<modules>` lists it. */
  readonly profile?: string;
  readonly javaVersion?: { readonly version: string; readonly evidence: JavaEvidence };
  readonly sourceRoots: readonly JavaSourceRoot[];
  readonly modules: readonly string[];
  readonly dependencies: readonly JavaDependency[];
  /**
   * The check plugins this module's build runs by default (round 22: the gates' `lint` and
   * `format`): Maven's `<build><plugins>` (not `<pluginManagement>`, `<reporting>` or a profile),
   * Gradle's plugin ids. Each with where.
   */
  readonly checks?: readonly { readonly tool: JavaCheckTool; readonly evidence: JavaEvidence }[];
}

/** Check plugins a gate can run: Checkstyle, PMD, SpotBugs (lint) and Spotless (format). */
export type JavaCheckTool = "checkstyle" | "pmd" | "spotbugs" | "spotless";

/** A build at the top of the tree read: its folder, the file that makes it one, its wrapper. */
export interface JavaTopBuild {
  readonly tool: JavaBuildTool;
  /** Repo-relative, `.` for the root. */
  readonly dir: string;
  /** `pom.xml`, `settings.gradle.kts`, `build.gradle`…, repo-relative. */
  readonly file: string;
  /** `mvnw` or `gradlew` beside it, repo-relative; null without one. */
  readonly wrapper: string | null;
}

export interface JavaBuild {
  readonly tools: readonly JavaBuildTool[];
  /** The top-level builds (round 22): what `setup`, the gates and `doctor` start from. */
  readonly builds?: readonly JavaTopBuild[];
  readonly modules: readonly JavaModule[];
  /** Build files that could not be read, and what made reading approximate. */
  readonly notes: readonly string[];
}

export interface JavaServletMapping {
  readonly name: string;
  readonly className: string;
  readonly urlPatterns: readonly string[];
  readonly line: number;
}

export interface JavaPersistenceUnit {
  readonly name: string;
  readonly transactionType?: string;
  readonly provider?: string;
  readonly classes: readonly string[];
  readonly line: number;
}

export interface JavaXmlBean {
  readonly id?: string;
  readonly className: string;
  readonly scope?: string;
  readonly line: number;
  readonly properties: readonly {
    readonly name: string;
    readonly ref?: string;
    readonly value?: string;
    readonly line: number;
  }[];
  readonly constructorArgs: readonly {
    readonly ref?: string;
    readonly value?: string;
    readonly line: number;
  }[];
}

export interface JavaConfigEntry {
  readonly key: string;
  readonly value: string;
  /** Absent for the default profile. */
  readonly profile?: string;
  readonly line: number;
}

/** What one descriptor file says; empty lists for the kinds it is not. */
export interface JavaDescriptorFacts {
  readonly servlets: readonly JavaServletMapping[];
  readonly persistenceUnits: readonly JavaPersistenceUnit[];
  readonly beans: readonly JavaXmlBean[];
  readonly config: readonly JavaConfigEntry[];
}

export const NO_DESCRIPTOR_FACTS: JavaDescriptorFacts = {
  servlets: [],
  persistenceUnits: [],
  beans: [],
  config: [],
};

/** Whether a file is one the descriptor reader looks at. */
export function isJavaDescriptor(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/^(application|bootstrap)([-.][\w.-]*)?\.(properties|ya?ml)$/.test(name)) return true;
  if (!name.endsWith(".xml") || name === "pom.xml") return false;
  return (
    name === "web.xml" ||
    name === "persistence.xml" ||
    /(^|\/)(src\/main\/(resources|webapp)|WEB-INF|META-INF)\//.test(path)
  );
}

/** The profile a config file name carries: `application-dev.yml` → `dev`; undefined for `application.yml`. */
export function profileOfConfigFile(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const m = /^(?:application|bootstrap)-([\w.-]+)\.(?:properties|ya?ml)$/.exec(name);
  return m?.[1];
}

/**
 * `${name}` placeholders replaced by `properties` (repeatedly, for a property defined by another);
 * a name with no value is kept as written, so a reader sees what is unknown.
 */
export function resolvePlaceholders(text: string, properties: ReadonlyMap<string, string>): string {
  let out = text;
  for (let i = 0; i < 10 && out.includes("${"); i++) {
    const next = out.replace(/\$\{([^}]+)\}/g, (whole, name: string) => properties.get(name.trim()) ?? whole);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** The module owning a repo-relative path: the deepest module directory that contains it. */
export function moduleOfPath(path: string, modules: readonly Pick<JavaModule, "name" | "dir">[]): string {
  let best: Pick<JavaModule, "name" | "dir"> | undefined;
  const depth = (dir: string) => (dir === "." ? 0 : dir.split("/").length);
  for (const m of modules) {
    const inside = m.dir === "." || path.startsWith(`${m.dir}/`);
    if (inside && (!best || depth(m.dir) > depth(best.dir))) best = m;
  }
  return best?.name ?? "";
}

/** The source root holding a path (the longest), if any. */
export function sourceRootOf(path: string, roots: readonly JavaSourceRoot[]): JavaSourceRoot | undefined {
  let best: JavaSourceRoot | undefined;
  for (const r of roots)
    if (path.startsWith(`${r.path}/`) && (!best || r.path.length > best.path.length)) best = r;
  return best;
}

/**
 * The kind of a source root a path is under when the build declares none for it: test code in
 * `src/test*`, generated code under `target/generated-*` or `build/generated*`.
 */
export function conventionalRootKind(path: string): JavaSourceRoot["kind"] {
  if (/(^|\/)(target\/generated-[\w-]+|build\/generated[\w-]*)\//.test(path)) return "generated";
  if (/(^|\/)src\/(test|it|integration-?test)[\w-]*\//i.test(path)) return "test";
  return "main";
}
