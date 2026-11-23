import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import {
  err,
  type JavaBuild,
  type JavaBuildReader,
  type JavaBuildTool,
  type JavaCheckTool,
  type JavaDependency,
  type JavaEvidence,
  type JavaModule,
  type JavaSourceRoot,
  type JavaTopBuild,
  type MetatorError,
  ok,
  type Result,
  resolvePlaceholders,
  type WorkspacePackage,
  type WorkspaceReader,
} from "@metator/core";
import { child, children, childText, parseXml, type XmlElement } from "./xml.ts";

const SKIP_DIRS = new Set(["node_modules", "target", "build", "out", "bin", "dist"]);

/**
 * Maven and Gradle builds read from their files, never run (ADR-0107). Maven: `pom.xml` and its
 * `<modules>` recursively (a profile's modules are listed and marked), `<parent>`, packaging,
 * dependencies with their scope, `<sourceDirectory>`, the Java release; `${...}` resolved along
 * the POM chain inside the repository. Gradle: `settings.gradle(.kts)` includes, each project's
 * dependencies by configuration, simple `sourceSets` and the toolchain or compatibility version.
 * A build at the root wins; otherwise builds one or two folders down are read (a Java service
 * beside a TypeScript app).
 */
export class JavaBuildFiles implements JavaBuildReader {
  private cached: Promise<Result<JavaBuild, MetatorError>> | undefined;

  constructor(private readonly root: string) {}

  read(): Promise<Result<JavaBuild, MetatorError>> {
    this.cached ??= Promise.resolve(ok(this.readNow()));
    return this.cached;
  }

  private readNow(): JavaBuild {
    const notes: string[] = [];
    const tools = new Set<JavaBuildTool>();
    const modules: JavaModule[] = [];
    const builds: JavaTopBuild[] = [];
    for (const dir of buildDirs(this.root)) {
      const abs = join(this.root, dir);
      // The shell script, else Windows' own (a repository kept for Windows only).
      const wrapper = (...names: string[]) => {
        const name = names.find((n) => existsSync(join(abs, n)));
        return name ? rel(dir, name) : null;
      };
      if (existsSync(join(abs, "pom.xml"))) {
        tools.add("maven");
        builds.push({ tool: "maven", dir, file: rel(dir, "pom.xml"), wrapper: wrapper("mvnw", "mvnw.cmd") });
        modules.push(...new MavenReader(this.root, notes).read(dir));
      } else {
        const file = GRADLE_FILES.find((f) => existsSync(join(abs, f)));
        if (!file) continue;
        tools.add("gradle");
        builds.push({
          tool: "gradle",
          dir,
          file: rel(dir, file),
          wrapper: wrapper("gradlew", "gradlew.bat"),
        });
        modules.push(...readGradle(this.root, dir, notes));
      }
    }
    return { tools: [...tools], builds, modules, notes };
  }
}

const GRADLE_FILES = ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"];

/** Directories holding a top-level build: the root, else folders one or two levels down. */
export function buildDirs(root: string): string[] {
  const has = (dir: string) =>
    existsSync(join(root, dir, "pom.xml")) || GRADLE_FILES.some((f) => existsSync(join(root, dir, f)));
  if (has(".")) return ["."];
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const sub = dir === "." ? name : `${dir}/${name}`;
      try {
        if (!statSync(join(root, sub)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (has(sub)) out.push(sub);
      else if (depth < 2) visit(sub, depth + 1);
    }
  };
  visit(".", 1);
  return out;
}

const rel = (dir: string, ...parts: string[]) => {
  const joined = posix.normalize(posix.join(dir, ...parts));
  return joined === "" ? "." : joined;
};

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Default and declared source roots of a module, plus the generated ones present on disk. */
function sourceRoots(
  root: string,
  dir: string,
  declared: readonly { path: string; kind: JavaSourceRoot["kind"] }[],
  generatedParents: readonly string[],
): JavaSourceRoot[] {
  const out: JavaSourceRoot[] = [];
  const add = (path: string, kind: JavaSourceRoot["kind"], isDeclared: boolean) => {
    if (!out.some((r) => r.path === path)) out.push({ path, kind, declared: isDeclared });
  };
  for (const d of declared) add(d.path, d.kind, true);
  for (const [path, kind] of [
    ["src/main/java", "main"],
    ["src/test/java", "test"],
  ] as const) {
    const full = rel(dir, path);
    if (isDir(join(root, full))) add(full, kind, false);
  }
  for (const parent of generatedParents) {
    const full = rel(dir, parent);
    if (!isDir(join(root, full))) continue;
    for (const name of readdirSync(join(root, full)).sort())
      if (isDir(join(root, full, name))) add(rel(full, name), "generated", false);
  }
  return out;
}

interface Pom {
  readonly dir: string;
  readonly file: string;
  readonly el: XmlElement;
  readonly group?: string;
  readonly artifact: string;
  readonly version?: string;
  readonly parentRef?: { group: string; artifact: string; version: string; path: string };
}

/** Maven: POMs read once each, the chain of parents inside the repository resolved for properties. */
class MavenReader {
  private readonly poms = new Map<string, Pom | undefined>();

  constructor(
    private readonly root: string,
    private readonly notes: string[],
  ) {}

  private pom(dir: string): Pom | undefined {
    if (this.poms.has(dir)) return this.poms.get(dir);
    const file = rel(dir, "pom.xml");
    let pom: Pom | undefined;
    try {
      const xml = parseXml(readFileSync(join(this.root, file), "utf8"));
      if (xml.isErr()) {
        this.notes.push(`${file}: ${xml.error.message}`);
        this.poms.set(dir, undefined);
        return undefined;
      }
      const el = xml.value;
      const parent = child(el, "parent");
      const parentRef = parent
        ? {
            group: childText(parent, "groupId") ?? "",
            artifact: childText(parent, "artifactId") ?? "",
            version: childText(parent, "version") ?? "",
            path: rel(dir, childText(parent, "relativePath") ?? "../pom.xml"),
          }
        : undefined;
      const group = childText(el, "groupId") ?? parentRef?.group;
      const version = childText(el, "version") ?? parentRef?.version;
      pom = {
        dir,
        file,
        el,
        ...(group ? { group } : {}),
        artifact: childText(el, "artifactId") ?? posix.basename(dir),
        ...(version ? { version } : {}),
        ...(parentRef ? { parentRef } : {}),
      };
    } catch (e) {
      this.notes.push(`${file}: ${(e as Error).message.split("\n")[0]}`);
    }
    this.poms.set(dir, pom);
    return pom;
  }

  /** The parent POM inside the repository, when its coordinates match. */
  private parentOf(pom: Pom): Pom | undefined {
    const ref = pom.parentRef;
    if (!ref) return undefined;
    const path = ref.path.endsWith(".xml") ? posix.dirname(ref.path) : ref.path;
    if (path.startsWith("..") && relative(this.root, join(this.root, path)).startsWith(".."))
      return undefined;
    if (!existsSync(join(this.root, path, "pom.xml"))) return undefined;
    const parent = this.pom(path === "" ? "." : path);
    return parent && parent.artifact === ref.artifact ? parent : undefined;
  }

  /** Properties along the chain, the module's own last (they win), plus `project.*`. */
  private properties(pom: Pom): Map<string, string> {
    const chain: Pom[] = [];
    for (let p: Pom | undefined = pom; p && !chain.includes(p); p = this.parentOf(p)) chain.unshift(p);
    const props = new Map<string, string>();
    for (const p of chain)
      for (const prop of child(p.el, "properties")?.children ?? []) props.set(prop.name, prop.text);
    if (pom.version) props.set("project.version", pom.version);
    if (pom.group) props.set("project.groupId", pom.group);
    props.set("project.artifactId", pom.artifact);
    props.set("project.basedir", pom.dir);
    if (pom.parentRef?.version) props.set("project.parent.version", pom.parentRef.version);
    return props;
  }

  /** `<dependencyManagement>` versions along the chain, by `group:artifact`. */
  private managed(pom: Pom, props: ReadonlyMap<string, string>): Map<string, string> {
    const out = new Map<string, string>();
    const chain: Pom[] = [];
    for (let p: Pom | undefined = pom; p && !chain.includes(p); p = this.parentOf(p)) chain.unshift(p);
    for (const p of chain)
      for (const d of children(child(child(p.el, "dependencyManagement"), "dependencies"), "dependency")) {
        const version = childText(d, "version");
        if (version)
          out.set(
            `${resolvePlaceholders(childText(d, "groupId") ?? "", props)}:${childText(d, "artifactId")}`,
            resolvePlaceholders(version, props),
          );
      }
    return out;
  }

  read(top: string): JavaModule[] {
    const found: { pom: Pom; profile?: string }[] = [];
    const visit = (dir: string, profile: string | undefined) => {
      if (found.some((f) => f.pom.dir === dir)) return;
      const pom = this.pom(dir);
      if (!pom) return;
      found.push({ pom, ...(profile ? { profile } : {}) });
      for (const m of children(child(pom.el, "modules"), "module")) visit(rel(dir, m.text), profile);
      for (const p of children(child(pom.el, "profiles"), "profile")) {
        const id = childText(p, "id") ?? "profile";
        for (const m of children(child(p, "modules"), "module")) visit(rel(dir, m.text), profile ?? id);
      }
    };
    visit(top, undefined);
    const byCoordinate = new Map(found.map((f) => [`${f.pom.group}:${f.pom.artifact}`, f.pom.artifact]));
    return found.map(({ pom, profile }) => {
      const props = this.properties(pom);
      const managed = this.managed(pom, props);
      const r = (t: string) => resolvePlaceholders(t, props);
      const dependencies: JavaDependency[] = children(child(pom.el, "dependencies"), "dependency").map(
        (d) => {
          const group = r(childText(d, "groupId") ?? "");
          const artifact = r(childText(d, "artifactId") ?? "");
          const written = childText(d, "version");
          const version = written ? r(written) : managed.get(`${group}:${artifact}`);
          const module = byCoordinate.get(`${group}:${artifact}`);
          return {
            group,
            artifact,
            ...(version ? { version } : {}),
            scope: r(childText(d, "scope") ?? "compile"),
            ...(module ? { module } : {}),
            line: d.line,
          };
        },
      );
      const build = child(pom.el, "build");
      const declared: { path: string; kind: JavaSourceRoot["kind"] }[] = [];
      const src = childText(build, "sourceDirectory");
      if (src)
        declared.push({
          path: rel(pom.dir, r(src).replace(/^\$\{(project\.)?basedir\}\/?/, "")),
          kind: "main",
        });
      const testSrc = childText(build, "testSourceDirectory");
      if (testSrc)
        declared.push({
          path: rel(pom.dir, r(testSrc).replace(/^\$\{(project\.)?basedir\}\/?/, "")),
          kind: "test",
        });
      const parent = this.parentOf(pom);
      const javaVersion = this.javaVersion(pom, props);
      const checks = mavenChecks(pom.file, build);
      return {
        name: pom.artifact,
        dir: pom.dir,
        build: "maven" as const,
        buildFile: pom.file,
        ...(pom.group ? { group: r(pom.group) } : {}),
        ...(pom.version ? { version: r(pom.version) } : {}),
        packaging: r(childText(pom.el, "packaging") ?? "jar"),
        ...(pom.parentRef
          ? {
              parent:
                parent && found.some((f) => f.pom === parent)
                  ? parent.artifact
                  : `${pom.parentRef.group}:${pom.parentRef.artifact}:${pom.parentRef.version}`,
            }
          : {}),
        ...(profile ? { profile } : {}),
        ...(javaVersion ? { javaVersion } : {}),
        sourceRoots: sourceRoots(this.root, pom.dir, declared, [
          "target/generated-sources",
          "target/generated-test-sources",
        ]),
        ...(checks.length > 0 ? { checks } : {}),
        modules: children(child(pom.el, "modules"), "module").map(
          (m) => this.pom(rel(pom.dir, m.text))?.artifact ?? m.text,
        ),
        dependencies,
      };
    });
  }

  /** The release a module compiles for: `maven.compiler.release`/`source`, `java.version`, or the compiler plugin's configuration. */
  private javaVersion(pom: Pom, props: ReadonlyMap<string, string>): JavaModule["javaVersion"] {
    const chain: Pom[] = [];
    for (let p: Pom | undefined = pom; p && !chain.includes(p); p = this.parentOf(p)) chain.push(p);
    for (const p of chain) {
      for (const plugin of [
        ...children(child(child(p.el, "build"), "plugins"), "plugin"),
        ...children(child(child(child(p.el, "build"), "pluginManagement"), "plugins"), "plugin"),
      ]) {
        if (childText(plugin, "artifactId") !== "maven-compiler-plugin") continue;
        const config = child(plugin, "configuration");
        for (const key of ["release", "source"]) {
          const el = child(config, key);
          if (el?.text) return this.version(resolvePlaceholders(el.text, props), p, el, `<${key}>`);
        }
      }
      for (const key of ["maven.compiler.release", "maven.compiler.source", "java.version"]) {
        const el = child(child(p.el, "properties"), key);
        if (el?.text) return this.version(resolvePlaceholders(el.text, props), p, el, `<${key}>`);
      }
    }
    return undefined;
  }

  private version(version: string, pom: Pom, el: XmlElement, what: string): JavaModule["javaVersion"] {
    const evidence: JavaEvidence = {
      at: `${pom.file}:${el.line}`,
      source: `${what}${version}</${what.slice(1)}`,
    };
    return { version, evidence };
  }
}

/** Gradle: settings includes, then each project's build script read as text. */
function readGradle(root: string, top: string, notes: string[]): JavaModule[] {
  const settingsFile = ["settings.gradle.kts", "settings.gradle"]
    .map((f) => rel(top, f))
    .find((f) => existsSync(join(root, f)));
  const settings = settingsFile ? readFileSync(join(root, settingsFile), "utf8") : "";
  const rootName =
    /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings)?.[1] ??
    posix.basename(top === "." ? root : top);
  const props = gradleProperties(root, top);
  const projects: { path: string; dir: string }[] = [];
  for (const m of stripComments(settings).matchAll(/\binclude\s*\(?([^)\n]*)\)?/g)) {
    for (const q of (m[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      const path = (q[1] as string).replace(/^:/, "");
      projects.push({ path, dir: rel(top, path.replaceAll(":", "/")) });
    }
  }
  for (const m of settings.matchAll(
    /project\(\s*["']:?([^"']+)["']\s*\)\.projectDir\s*=\s*(?:file\()?\s*["']([^"']+)["']/g,
  )) {
    const p = projects.find((x) => x.path === m[1]);
    if (p) p.dir = rel(top, m[2] as string);
  }
  const out: JavaModule[] = [];
  const all = [{ path: rootName, dir: top, isRoot: true }, ...projects.map((p) => ({ ...p, isRoot: false }))];
  for (const p of all) {
    const buildFile = ["build.gradle.kts", "build.gradle"]
      .map((f) => rel(p.dir, f))
      .find((f) => existsSync(join(root, f)));
    const script = buildFile ? stripComments(readFileSync(join(root, buildFile), "utf8")) : "";
    // The root project is a module only when it builds Java itself.
    if (
      p.isRoot &&
      projects.length > 0 &&
      !/\bjava\b|java-library|application/.test(pluginsOf(script)) &&
      !isDir(join(root, p.dir, "src/main/java"))
    )
      continue;
    const declared = gradleSourceSets(script).map((d) => ({ path: rel(p.dir, d.path), kind: d.kind }));
    const javaVersion = gradleJavaVersion(script, buildFile ?? rel(p.dir, "build.gradle"));
    const checks = buildFile ? gradleChecks(buildFile, script) : [];
    const group = /\bgroup\s*=\s*["']([^"']+)["']/.exec(script)?.[1];
    const version = /\bversion\s*=\s*["']([^"']+)["']/.exec(script)?.[1];
    out.push({
      name: p.path,
      dir: p.dir,
      build: "gradle",
      buildFile: buildFile ?? settingsFile ?? rel(p.dir, "build.gradle"),
      ...(group ? { group } : {}),
      ...(version ? { version } : {}),
      packaging: /\bapplication\b|org\.springframework\.boot/.test(pluginsOf(script)) ? "application" : "jar",
      ...(p.isRoot ? {} : { parent: rootName }),
      ...(javaVersion ? { javaVersion } : {}),
      sourceRoots: sourceRoots(root, p.dir, declared, [
        "build/generated/sources/annotationProcessor/java",
        "build/generated/sources",
      ]),
      ...(checks.length > 0 ? { checks } : {}),
      modules: p.isRoot ? projects.map((x) => x.path) : [],
      dependencies: gradleDependencies(script, props),
    });
  }
  if (out.length === 0 && !settingsFile) notes.push(`${top}: a Gradle build with no Java project`);
  return out;
}

/** The check plugins' Maven artifacts. */
const MAVEN_CHECKS: Readonly<Record<JavaCheckTool, string>> = {
  checkstyle: "maven-checkstyle-plugin",
  pmd: "maven-pmd-plugin",
  spotbugs: "spotbugs-maven-plugin",
  spotless: "spotless-maven-plugin",
};

/**
 * The check plugins a POM's `<build><plugins>` runs by default (round 22). `<pluginManagement>`
 * only sets versions, and `<reporting>` and profiles run only when asked: none of them counts.
 */
export function mavenChecks(file: string, build: XmlElement | undefined): NonNullable<JavaModule["checks"]> {
  const plugins = children(child(build, "plugins"), "plugin");
  return (Object.keys(MAVEN_CHECKS) as JavaCheckTool[]).flatMap((tool) => {
    const plugin = plugins.find((p) => childText(p, "artifactId") === MAVEN_CHECKS[tool]);
    const at = plugin ? child(plugin, "artifactId") : undefined;
    return at ? [{ tool, evidence: { at: `${file}:${at.line}`, source: MAVEN_CHECKS[tool] } }] : [];
  });
}

/** The check plugins' Gradle ids; Checkstyle and PMD are core plugins that may stand bare in `plugins { }`. */
const GRADLE_CHECKS: Readonly<Record<JavaCheckTool, string>> = {
  checkstyle: "checkstyle",
  pmd: "pmd",
  spotbugs: "com.github.spotbugs",
  spotless: "com.diffplug.spotless",
};

/** The check plugins a Gradle script applies (`id("x")`, `id 'x'`, `apply plugin: 'x'`, bare core plugins), comments stripped. */
export function gradleChecks(file: string, script: string): NonNullable<JavaModule["checks"]> {
  const lines = script.split(/\r?\n/);
  const plugins = /plugins\s*\{([^}]*)\}/.exec(script);
  const pluginsFrom = plugins ? script.slice(0, plugins.index).split("\n").length - 1 : -1;
  const pluginsTo = plugins ? pluginsFrom + plugins[0].split("\n").length - 1 : -1;
  return (Object.keys(GRADLE_CHECKS) as JavaCheckTool[]).flatMap((tool) => {
    const id = GRADLE_CHECKS[tool].replaceAll(".", "\\.");
    const byId = new RegExp(`(\\bid\\s*\\(?\\s*|apply\\s*\\(?\\s*plugin\\s*[:=]\\s*)["']${id}["']`);
    const bare = new RegExp(`^\\s*\`?${id}\`?\\s*$`);
    const i = lines.findIndex(
      (l, n) =>
        byId.test(l) || (!tool.startsWith("spot") && n >= pluginsFrom && n <= pluginsTo && bare.test(l)),
    );
    return i < 0 ? [] : [{ tool, evidence: { at: `${file}:${i + 1}`, source: (lines[i] as string).trim() } }];
  });
}

function stripComments(text: string): string {
  // Block comments keep their line breaks: lines stay where the file has them.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

function pluginsOf(script: string): string {
  return /plugins\s*\{([^}]*)\}/.exec(script)?.[1] ?? /apply\s+plugin:[^\n]*/.exec(script)?.[0] ?? "";
}

function gradleProperties(root: string, top: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = join(root, top, "gradle.properties");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
}

/** `implementation("g:a:v")`, `testImplementation 'g:a'`, `api(project(":core"))`, map notation. */
export function gradleDependencies(
  script: string,
  props: ReadonlyMap<string, string> = new Map(),
): JavaDependency[] {
  const block = blockOf(script, "dependencies");
  const out: JavaDependency[] = [];
  const subst = (v: string) =>
    v.replace(/\$\{?([\w.]+)\}?/g, (whole, name: string) => props.get(name) ?? whole);
  const offset = script.slice(0, script.indexOf(block)).split("\n").length - 1;
  const lines = block.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] as string;
    const at = offset + n + 1;
    const conf = /^\s*(\w+)\s*[( ]/.exec(line)?.[1];
    if (!conf || conf === "dependencies") continue;
    const project = /project\(\s*(?:path\s*[:=]\s*)?["']:?([^"']+)["']/.exec(line);
    if (project) {
      out.push({
        group: "",
        artifact: project[1] as string,
        scope: conf,
        module: project[1] as string,
        line: at,
      });
      continue;
    }
    const coordinate = /["']([^"':\s]+):([^"':\s]+)(?::([^"'\s]+))?["']/.exec(line);
    if (coordinate) {
      out.push({
        group: coordinate[1] as string,
        artifact: coordinate[2] as string,
        ...(coordinate[3] ? { version: subst(coordinate[3]) } : {}),
        scope: conf,
        line: at,
      });
      continue;
    }
    const map =
      /group\s*[:=]\s*["']([^"']+)["']\s*,\s*name\s*[:=]\s*["']([^"']+)["'](?:\s*,\s*version\s*[:=]\s*["']([^"']+)["'])?/.exec(
        line,
      );
    if (map)
      out.push({
        group: map[1] as string,
        artifact: map[2] as string,
        ...(map[3] ? { version: subst(map[3]) } : {}),
        scope: conf,
        line: at,
      });
  }
  return out;
}

/** The text inside the first top-level `name { ... }` block (balanced braces). */
function blockOf(script: string, name: string): string {
  const re = new RegExp(`(^|\\n)\\s*${name}\\s*\\{`, "g");
  const m = re.exec(script);
  if (!m) return "";
  let depth = 1;
  const start = m.index + m[0].length;
  for (let i = start; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}" && --depth === 0) return script.slice(start, i);
  }
  return script.slice(start);
}

/** `sourceSets { main { java { srcDir("x") } } }` and `main.java.srcDirs = [...]`, when written simply. */
export function gradleSourceSets(script: string): { path: string; kind: "main" | "test" }[] {
  const out: { path: string; kind: "main" | "test" }[] = [];
  const sets = blockOf(script, "sourceSets");
  for (const kind of ["main", "test"] as const) {
    const java = blockOf(blockOf(sets, kind), "java");
    const dirs = [
      ...java.matchAll(/srcDirs?\s*(?:\(|=|\+=)?\s*(?:\[|listOf\(|setOf\()?([^)\]\n]*)/g),
      ...script.matchAll(new RegExp(`${kind}\\.java\\.srcDirs?\\s*(?:\\+?=|\\()\\s*\\[?([^\\]\\n)]*)`, "g")),
    ];
    for (const d of dirs)
      for (const q of (d[1] ?? "").matchAll(/["']([^"']+)["']/g)) out.push({ path: q[1] as string, kind });
  }
  return out;
}

/** The toolchain's language version, else `sourceCompatibility`, else `options.release`. */
export function gradleJavaVersion(script: string, file: string): JavaModule["javaVersion"] {
  const lines = script.split(/\r?\n/);
  const patterns = [
    /languageVersion(?:\.set\(|\s*=\s*)\s*JavaLanguageVersion\.of\(\s*["']?(\d+)/,
    /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_(?:1_)?(\d+)|["']?(?:1\.)?(\d+))/,
    /(?:options\.)?release(?:\.set\(|\s*=\s*)\s*(\d+)/,
  ];
  for (const p of patterns)
    for (let i = 0; i < lines.length; i++) {
      const m = p.exec(lines[i] as string);
      if (m)
        return {
          version: (m[1] ?? m[2]) as string,
          evidence: { at: `${file}:${i + 1}`, source: (lines[i] as string).trim() },
        };
    }
  return undefined;
}

/** Java modules as workspace packages: graph, affected, arch and cards group by module. */
export class JavaWorkspace implements WorkspaceReader {
  constructor(private readonly build: JavaBuildReader) {}

  async packages(): Promise<Result<readonly WorkspacePackage[], MetatorError>> {
    const read = await this.build.read();
    if (read.isErr()) return err(read.error);
    return ok(
      read.value.modules
        // An aggregator (packaging pom) holds no code of its own; it would own every module's files.
        .filter((m) => m.packaging !== "pom" || m.sourceRoots.length > 0)
        .map((m) => ({ name: m.name, dir: m.dir, build: m.build })),
    );
  }
}
