import { describe, expect, test } from "bun:test";
import { repositoryStack, stackLine } from "../src/domain/inspection.ts";
import type { JavaBuild, JavaModule } from "../src/domain/java-build.ts";
import {
  buildLabel,
  buildProgram,
  isWindows,
  javaVersionNumber,
  jdkMajor,
  jdkVerdict,
  jvmBuildsOf,
  jvmGateSteps,
  moduleCount,
  moduleOf,
  narrowToModules,
  wrapperOf,
} from "../src/domain/jvm-build.ts";

/** A module as the Java build reader gives it (only what these rules read). */
const mod = (name: string, dir: string, more: Partial<JavaModule> = {}): JavaModule => ({
  name,
  dir,
  build: "maven",
  buildFile: dir === "." ? "pom.xml" : `${dir}/pom.xml`,
  packaging: "jar",
  sourceRoots: [{ path: `${dir}/src/main/java`, kind: "main", declared: false }],
  modules: [],
  dependencies: [],
  ...more,
});

/** The fixture's shape: a parent aggregator, modules, one only in a profile. */
const SHOP: JavaBuild = {
  tools: ["maven"],
  builds: [{ tool: "maven", dir: ".", file: "pom.xml", wrapper: "mvnw" }],
  modules: [
    mod("shop-parent", ".", {
      packaging: "pom",
      sourceRoots: [],
      javaVersion: {
        version: "17",
        evidence: { at: "pom.xml:14", source: "<maven.compiler.release>17</maven.compiler.release>" },
      },
      checks: [{ tool: "checkstyle", evidence: { at: "pom.xml:40", source: "maven-checkstyle-plugin" } }],
    }),
    mod("shop-common", "shop-common", {
      javaVersion: {
        version: "21",
        evidence: {
          at: "shop-common/pom.xml:15",
          source: "<maven.compiler.release>21</maven.compiler.release>",
        },
      },
    }),
    mod("shop-api", "shop-api", {
      checks: [
        { tool: "spotbugs", evidence: { at: "shop-api/pom.xml:30", source: "spotbugs-maven-plugin" } },
      ],
    }),
    mod("shop-api-web", "shop-api/web"),
    mod("shop-experimental", "shop-experimental", {
      profile: "experimental",
      javaVersion: {
        version: "25",
        evidence: { at: "shop-experimental/pom.xml:9", source: "<release>25</release>" },
      },
      checks: [{ tool: "pmd", evidence: { at: "shop-experimental/pom.xml:20", source: "maven-pmd-plugin" } }],
    }),
  ],
  notes: [],
};

describe("jvmBuildsOf: the build at the root, from what the Java build reader read", () => {
  test("its wrapper, the check plugins and the highest Java of the default build; a profile's module counts for neither", () => {
    expect(jvmBuildsOf(SHOP)).toEqual([
      {
        tool: "maven",
        file: "pom.xml",
        wrapper: "mvnw",
        checks: [
          { tool: "checkstyle", evidence: "pom.xml:40 maven-checkstyle-plugin" },
          { tool: "spotbugs", evidence: "shop-api/pom.xml:30 spotbugs-maven-plugin" },
        ],
        java: { version: 21, evidence: "shop-common/pom.xml:15 <maven.compiler.release>" },
      },
    ]);
  });

  test("a build below the root has no gates at the root; no build: none", () => {
    const below: JavaBuild = {
      ...SHOP,
      builds: [{ tool: "maven", dir: "backend", file: "backend/pom.xml", wrapper: null }],
    };
    expect(jvmBuildsOf(below)).toEqual([]);
    expect(jvmBuildsOf({ tools: [], modules: [], notes: [] })).toEqual([]);
  });

  test("a Gradle toolchain's line is its evidence; a version that is no number is none", () => {
    const gradle: JavaBuild = {
      tools: ["gradle"],
      builds: [{ tool: "gradle", dir: ".", file: "settings.gradle.kts", wrapper: null }],
      modules: [
        mod("core", "core", {
          build: "gradle",
          javaVersion: {
            version: "21",
            evidence: {
              at: "core/build.gradle.kts:7",
              source: "languageVersion = JavaLanguageVersion.of(21)",
            },
          },
        }),
        mod("app", "app", {
          build: "gradle",
          javaVersion: {
            version: `\${javaVersion}`,
            evidence: { at: "app/build.gradle.kts:3", source: "x" },
          },
        }),
      ],
      notes: [],
    };
    expect(jvmBuildsOf(gradle)[0]?.java).toEqual({
      version: 21,
      evidence: "core/build.gradle.kts:7 languageVersion = JavaLanguageVersion.of(21)",
    });
  });
});

describe("Java versions", () => {
  test("numbers: 1.8 and 1_8 are 8; anything else is undefined", () => {
    expect([javaVersionNumber("1.8"), javaVersionNumber("1_8"), javaVersionNumber("17")]).toEqual([8, 8, 17]);
    expect(javaVersionNumber(`\${java.version}`)).toBeUndefined();
  });

  test("the JDK's own words: old and new `java -version`, `java --version`", () => {
    expect(jdkMajor('java version "1.8.0_392"\nJava(TM) SE Runtime')).toBe(8);
    expect(jdkMajor('openjdk version "21.0.5" 2024-10-15\nOpenJDK Runtime Environment')).toBe(21);
    expect(jdkMajor("openjdk 17.0.2 2022-01-18")).toBe(17);
    expect(jdkMajor("command not found")).toBeUndefined();
  });

  test("the verdict: no JDK, older than declared, new enough", () => {
    const declared = { version: 17, evidence: "pom.xml:5 <maven.compiler.release>" };
    expect(jdkVerdict(undefined, declared)).toMatchObject({
      status: "warn",
      fix: expect.stringContaining("17"),
    });
    expect(jdkVerdict(11, declared)).toMatchObject({
      status: "warn",
      message: expect.stringContaining("JDK 11 is older than the Java 17"),
    });
    expect(jdkVerdict(17, declared).status).toBe("ok");
    expect(jdkVerdict(21, null)).toEqual({
      status: "ok",
      message: "JDK 21; the build declares no Java version",
    });
  });
});

describe("jvmGateSteps", () => {
  const base = { file: "pom.xml", wrapper: null, java: null } as const;
  test("Maven without check plugins: compile and test only", () => {
    expect(jvmGateSteps({ ...base, tool: "maven", checks: [] }).map((s) => [s.id, s.args.join(" ")])).toEqual(
      [
        ["typecheck", "-q -B -DskipTests compile"],
        ["test", "-B test"],
      ],
    );
  });

  test("Maven: SpotBugs compiles first; Spotless is the format check, never apply", () => {
    const steps = jvmGateSteps({
      ...base,
      tool: "maven",
      checks: [
        { tool: "checkstyle", evidence: "pom.xml:3" },
        { tool: "spotbugs", evidence: "pom.xml:9" },
        { tool: "spotless", evidence: "pom.xml:12" },
      ],
    });
    expect(steps.slice(2).map((s) => [s.id, s.args.join(" "), s.evidence])).toEqual([
      ["lint", "-q -B compile checkstyle:check spotbugs:check", ["pom.xml:3", "pom.xml:9"]],
      ["format", "-q -B spotless:check", ["pom.xml:12"]],
    ]);
  });

  test("Gradle: the tasks of each plugin, for main and test", () => {
    const steps = jvmGateSteps({
      ...base,
      tool: "gradle",
      file: "build.gradle.kts",
      checks: [
        { tool: "pmd", evidence: "b:1" },
        { tool: "spotless", evidence: "b:2" },
      ],
    });
    expect(steps.map((s) => s.args.join(" "))).toEqual([
      "compileJava compileTestJava -q",
      "test",
      "pmdMain pmdTest -q",
      "spotlessCheck -q",
    ]);
  });
});

describe("modules", () => {
  test("Maven builds the modules and what they need; Gradle runs each task in each project", () => {
    expect(narrowToModules("maven", ["-B", "test"], ["shop-domain", "shop-api", "shop-api"])).toEqual([
      "-pl",
      "shop-api,shop-domain",
      "-am",
      "-B",
      "test",
    ]);
    expect(narrowToModules("gradle", ["compileJava", "compileTestJava", "-q"], ["libs/core", "app"])).toEqual(
      [
        ":app:compileJava",
        ":libs:core:compileJava",
        ":app:compileTestJava",
        ":libs:core:compileTestJava",
        "-q",
      ],
    );
  });

  test("the root among the modules, or none: the whole build", () => {
    expect(narrowToModules("maven", ["-B", "test"], [".", "shop-api"])).toEqual(["-B", "test"]);
    expect(narrowToModules("gradle", ["test"], [])).toEqual(["test"]);
  });

  test("a file's module: the deepest of the default build that holds it, by folder (Maven) or project path (Gradle)", () => {
    expect(moduleOf("maven", "shop-api/web/src/main/java/A.java", SHOP)).toBe("shop-api/web");
    expect(moduleOf("maven", "shop-api/src/main/java/A.java", SHOP)).toBe("shop-api");
    // A profile's module is not in the default build: its change is the whole build's.
    expect(moduleOf("maven", "shop-experimental/src/main/java/B.java", SHOP)).toBe(".");
    expect(moduleOf("maven", "pom.xml", SHOP)).toBe(".");
    const gradle: JavaBuild = {
      tools: ["gradle"],
      modules: [mod("libs:core", "modules/core", { build: "gradle" })],
      notes: [],
    };
    expect(moduleOf("gradle", "modules/core/src/A.java", gradle)).toBe("libs:core");
    expect(narrowToModules("gradle", ["test"], ["libs:core"])).toEqual([":libs:core:test"]);
  });

  test("the modules a person counts: the default build's that hold code; at least one", () => {
    expect(moduleCount(SHOP, "maven")).toBe(3);
    expect(moduleCount({ tools: [], modules: [], notes: [] }, "gradle")).toBe(1);
  });
});

describe("what runs a build, by platform", () => {
  test("the wrapper is mvnw and gradlew, on Windows mvnw.cmd and gradlew.bat; the tool is mvn and gradle on both", () => {
    expect([wrapperOf("maven", "linux"), wrapperOf("gradle", "darwin")]).toEqual(["mvnw", "gradlew"]);
    expect([wrapperOf("maven", "win32"), wrapperOf("gradle", "win32")]).toEqual(["mvnw.cmd", "gradlew.bat"]);
    expect([buildProgram("maven", false, "win32"), buildProgram("gradle", false, "linux")]).toEqual([
      "mvn",
      "gradle",
    ]);
    expect(buildProgram("gradle", true, "win32")).toBe("gradlew.bat");
    expect([isWindows("win32"), isWindows("linux")]).toEqual([true, false]);
  });
});

describe("the stack in one line", () => {
  test("Java with its modules, TypeScript beside it", () => {
    const files: Record<string, string> = { "package.json": "{}", "tsconfig.json": "{}" };
    const stack = repositoryStack((f) => files[f], SHOP);
    expect(stack.line).toBe("Java, TypeScript · Maven (wrapper), 3 modules");
    expect(stack.builds).toEqual([{ tool: "maven", wrapper: true, modules: 3, label: "Maven (wrapper)" }]);
  });

  test("nothing found: an empty line; Gradle's label names the Kotlin DSL", () => {
    expect(repositoryStack(() => undefined, undefined)).toEqual({ languages: [], builds: [], line: "" });
    expect(stackLine({ languages: ["JavaScript"], builds: [] })).toBe("JavaScript");
    expect(buildLabel({ tool: "gradle", file: "settings.gradle.kts", wrapper: null })).toBe(
      "Gradle, Kotlin DSL",
    );
  });
});
