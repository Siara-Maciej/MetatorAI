/**
 * A Java repository's build as `setup`, the gates and `doctor` need it (round 22, decision 8):
 * which build tool, whether its wrapper is there, the check plugins it configures and the Java
 * version it declares, each with its evidence (`file:line`). Pure: the facts come from the Java
 * build reader (`JavaBuildReader`, the same one `metator java modules` reads); this turns them
 * into gate commands and checks.
 */
import type { JavaBuild, JavaCheckTool, JavaModule } from "./java-build.ts";

export const JVM_BUILD_TOOLS = ["maven", "gradle"] as const;
export type JvmBuildTool = (typeof JVM_BUILD_TOOLS)[number];

export const JVM_CHECK_TOOLS = [
  "checkstyle",
  "pmd",
  "spotbugs",
  "spotless",
] as const satisfies readonly JavaCheckTool[];
export type JvmCheckTool = JavaCheckTool;

export interface JvmBuild {
  readonly tool: JvmBuildTool;
  /** The build file at the root that says which tool: `pom.xml`, `settings.gradle.kts`, `build.gradle`. */
  readonly file: string;
  /** The wrapper at the root (`mvnw`, `gradlew`), preferred to the tool on PATH; null without one. */
  readonly wrapper: string | null;
  /** The check plugins the build configures, each with where. */
  readonly checks: readonly { readonly tool: JvmCheckTool; readonly evidence: string }[];
  /** The highest Java version the build declares (release, source, toolchain), or null. */
  readonly java: { readonly version: number; readonly evidence: string } | null;
}

/** The wrapper scripts a build ships: the shell script, and the one Windows runs. */
const WRAPPERS: Readonly<Record<JvmBuildTool, { readonly posix: string; readonly windows: string }>> = {
  maven: { posix: "mvnw", windows: "mvnw.cmd" },
  gradle: { posix: "gradlew", windows: "gradlew.bat" },
};

/** Whether a platform (`process.platform`'s word, given by the runtime) is Windows. */
export const isWindows = (platform: string): boolean => platform === "win32";

/** A Java version as its number: `1.8`, `1_8` and `8` are 8; `17` is 17. Undefined when it is no version. */
export function javaVersionNumber(text: string): number | undefined {
  const m = /^\s*(\d+)(?:[._](\d+))?/.exec(text);
  if (!m) return undefined;
  const first = Number(m[1]);
  const n = first === 1 && m[2] !== undefined ? Number(m[2]) : first;
  return n >= 1 && n <= 99 ? n : undefined;
}

/** The major version `java -version` (or `java --version`) prints; undefined when it says none. */
export function jdkMajor(output: string): number | undefined {
  const m = /version "([^"]+)"/.exec(output) ?? /^(?:openjdk|java)\s+(\d[\w.]*)/m.exec(output);
  return m ? javaVersionNumber(m[1] as string) : undefined;
}

type Found = { readonly version: number; readonly evidence: string };

/** A module's declared Java version as a number with its evidence (`pom.xml:14 <maven.compiler.release>`). */
function declared(m: JavaModule): Found | null {
  const v = m.javaVersion;
  const version = v ? javaVersionNumber(v.version) : undefined;
  if (!v || version === undefined) return null;
  const what = /^<[^>]+>/.exec(v.evidence.source)?.[0] ?? v.evidence.source;
  return { version, evidence: `${v.evidence.at} ${what}` };
}

/**
 * The Java builds at a repository's root, from what the Java build reader read: the tool, the
 * file that makes it one, its wrapper, the check plugins of the modules the default build has
 * (a profile's are left out) and the highest Java version they declare. A build found below the
 * root (a Java service beside an app) has no gates at the root: it is left out.
 */
export function jvmBuildsOf(build: JavaBuild): JvmBuild[] {
  return (build.builds ?? [])
    .filter((b) => b.dir === ".")
    .map((b) => {
      const modules = build.modules.filter((m) => m.build === b.tool && m.profile === undefined);
      const checks = new Map<JvmCheckTool, string>();
      for (const m of modules)
        for (const c of m.checks ?? [])
          if (!checks.has(c.tool)) checks.set(c.tool, `${c.evidence.at} ${c.evidence.source}`);
      let java: Found | null = null;
      for (const m of modules) {
        const d = declared(m);
        if (d && (!java || d.version > java.version)) java = d;
      }
      return {
        tool: b.tool,
        file: b.file,
        wrapper: b.wrapper,
        checks: JVM_CHECK_TOOLS.filter((t) => checks.has(t)).map((t) => ({
          tool: t,
          evidence: checks.get(t) as string,
        })),
        java,
      };
    });
}

/**
 * The modules a person counts in a build: those the default build has (no profile's) that hold
 * code (an aggregator POM does not); at least 1.
 */
export function moduleCount(build: JavaBuild, tool: JvmBuildTool): number {
  const counted = build.modules.filter(
    (m) => m.build === tool && m.profile === undefined && (m.packaging !== "pom" || m.sourceRoots.length > 0),
  );
  return Math.max(1, counted.length);
}

/** The files whose change a Java build's gate checks: sources, resources and build scripts. */
export const JVM_FILES = [
  "**/*.java",
  "**/*.kt",
  "**/pom.xml",
  "**/*.gradle",
  "**/*.gradle.kts",
  "**/src/*/resources/**",
];

/** What a gate step of a Java build runs: the goals (Maven) or tasks (Gradle) with their flags. */
export interface JvmGateStep {
  readonly id: "typecheck" | "test" | "lint" | "format";
  readonly args: readonly string[];
  readonly evidence: readonly string[];
  readonly reason: string;
}

/**
 * The gate steps for a Java build: compile (the type check), test, the configured linters and,
 * with Spotless, the format check. Each only checks: nothing here rewrites a file.
 */
export function jvmGateSteps(build: JvmBuild): JvmGateStep[] {
  const has = (t: JvmCheckTool) => build.checks.some((c) => c.tool === t);
  const evidence = (tools: readonly JvmCheckTool[]) =>
    build.checks.filter((c) => tools.includes(c.tool)).map((c) => c.evidence);
  const linters = (["checkstyle", "pmd", "spotbugs"] as const).filter(has);
  const maven = build.tool === "maven";
  const steps: JvmGateStep[] = [
    {
      id: "typecheck",
      args: maven ? ["-q", "-B", "-DskipTests", "compile"] : ["compileJava", "compileTestJava", "-q"],
      evidence: [build.file],
      reason: `${maven ? "Maven" : "Gradle"} build: compiling is the Java type check`,
    },
    {
      id: "test",
      args: maven ? ["-B", "test"] : ["test"],
      evidence: [build.file],
      reason: `${maven ? "Maven" : "Gradle"} build: its tests`,
    },
  ];
  if (linters.length > 0) {
    const goals = maven
      ? // SpotBugs reads compiled classes: the same invocation compiles first.
        [...(has("spotbugs") ? ["compile"] : []), ...linters.map((t) => `${t}:check`)]
      : linters.flatMap((t) => [`${t}Main`, `${t}Test`]);
    steps.push({
      id: "lint",
      args: maven ? ["-q", "-B", ...goals] : [...goals, "-q"],
      evidence: evidence(linters),
      reason: `the build configures ${linters.join(", ")}`,
    });
  }
  if (has("spotless"))
    steps.push({
      id: "format",
      args: maven ? ["-q", "-B", "spotless:check"] : ["spotlessCheck", "-q"],
      evidence: evidence(["spotless"]),
      reason: "the build configures Spotless: its check (never apply) is the format check",
    });
  return steps;
}

/**
 * A build's arguments narrowed to modules (`moduleOf`: Maven's folders, Gradle's project paths;
 * "." is the root, which is the whole build): Maven builds the listed modules and what they need
 * (`-pl a,b -am`); Gradle runs each task in each module's project (`:a:test`,
 * `:libs:core:test`). With the root among them, or no module, nothing is narrowed.
 */
export function narrowToModules(
  tool: JvmBuildTool,
  args: readonly string[],
  modules: readonly string[],
): string[] {
  const dirs = [...new Set(modules)].sort();
  if (dirs.length === 0 || dirs.includes(".")) return [...args];
  if (tool === "maven") return ["-pl", dirs.join(","), "-am", ...args];
  const projects = dirs.map((d) => `:${d.split("/").join(":")}`);
  return args.flatMap((a) => (a.startsWith("-") ? [a] : projects.map((p) => `${p}:${a}`)));
}

/**
 * The module a file belongs to, as the build names it: the deepest module of the default build
 * whose folder holds it (Maven: its folder, for `-pl`; Gradle: its project path), or "." (the
 * whole build) when none but the root does.
 */
export function moduleOf(tool: JvmBuildTool, file: string, build: JavaBuild): string {
  const holding = build.modules
    .filter(
      (m) => m.build === tool && m.profile === undefined && m.dir !== "." && file.startsWith(`${m.dir}/`),
    )
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!holding) return ".";
  return tool === "maven" ? holding.dir : holding.name;
}

/**
 * What runs a build on `platform`: its wrapper at the root when there is one (`mvnw` and
 * `gradlew`; `mvnw.cmd` and `gradlew.bat` on Windows), else the tool from PATH (`mvn`, `gradle`,
 * which Windows finds as `mvn.cmd` and `gradle.bat` itself). A config names only `build: maven`,
 * so one file works for colleagues on Windows and on Linux.
 */
export function buildProgram(tool: JvmBuildTool, wrapper: boolean, platform = ""): string {
  return wrapper ? wrapperOf(tool, platform) : tool === "maven" ? "mvn" : "gradle";
}

/** The wrapper file that runs on `platform`, repo-relative at the root. */
export const wrapperOf = (tool: JvmBuildTool, platform = ""): string =>
  isWindows(platform) ? WRAPPERS[tool].windows : WRAPPERS[tool].posix;

/** Every wrapper file of a tool (the shell script and Windows' one): what a person may type. */
export const wrappersOf = (tool: JvmBuildTool): readonly string[] => [
  WRAPPERS[tool].posix,
  WRAPPERS[tool].windows,
];

/** What a JDK of `major` means for a build that declares `declared`, in one sentence and a status. */
export function jdkVerdict(
  major: number | undefined,
  declared: JvmBuild["java"],
): { readonly status: "ok" | "warn"; readonly message: string; readonly fix?: string } {
  if (major === undefined)
    return {
      status: "warn",
      message:
        "no JDK found (`java -version` did not answer): the gates cannot compile or test the Java code; reading it (`metator java`) still works",
      fix: `install a JDK${declared ? ` ${declared.version} or newer` : ""} and put \`java\` on PATH (or set JAVA_HOME)`,
    };
  if (declared && major < declared.version)
    return {
      status: "warn",
      message: `JDK ${major} is older than the Java ${declared.version} the build declares (${declared.evidence}): the gates would fail to compile`,
      fix: `install JDK ${declared.version} or newer and put it first on PATH (or set JAVA_HOME)`,
    };
  return {
    status: "ok",
    message: declared
      ? `JDK ${major}; the build declares Java ${declared.version} (${declared.evidence})`
      : `JDK ${major}; the build declares no Java version`,
  };
}

/** One line for a person: "Maven (wrapper)", "Gradle, Kotlin DSL". */
export function buildLabel(build: Pick<JvmBuild, "tool" | "file" | "wrapper">): string {
  const name = build.tool === "maven" ? "Maven" : "Gradle";
  const dsl = build.tool === "gradle" && build.file.endsWith(".kts") ? ", Kotlin DSL" : "";
  return `${name}${dsl}${build.wrapper ? " (wrapper)" : ""}`;
}
