import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDirs,
  gradleDependencies,
  gradleJavaVersion,
  gradleSourceSets,
  JavaBuildFiles,
  JavaWorkspace,
} from "../src/java-build-reader.ts";

const roots: string[] = [];
async function repo(files: Record<string, string>, dirs: readonly string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metator-java-build-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content);
  for (const d of dirs) await mkdir(join(root, d), { recursive: true });
  return root;
}
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const pom = (body: string) =>
  `<?xml version="1.0"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n<modelVersion>4.0.0</modelVersion>\n${body}\n</project>\n`;

describe("Maven", () => {
  test("modules recursively, the parent in the build, placeholders along the chain, profiles marked", async () => {
    const root = await repo(
      {
        "pom.xml":
          pom(`<groupId>g</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging>
<properties><spring.version>6.1.0</spring.version><maven.compiler.release>17</maven.compiler.release></properties>
<modules><module>api</module><module>libs</module></modules>
<dependencyManagement><dependencies><dependency><groupId>org.x</groupId><artifactId>managed</artifactId><version>\${spring.version}</version></dependency></dependencies></dependencyManagement>
<profiles><profile><id>extra</id><modules><module>extra</module></modules></profile></profiles>`),
        "api/pom.xml":
          pom(`<parent><groupId>g</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
<artifactId>api</artifactId>
<properties><maven.compiler.release>21</maven.compiler.release></properties>
<dependencies>
  <dependency><groupId>g</groupId><artifactId>core</artifactId><version>\${project.version}</version></dependency>
  <dependency><groupId>org.springframework</groupId><artifactId>spring-web</artifactId><version>\${spring.version}</version><scope>provided</scope></dependency>
  <dependency><groupId>org.x</groupId><artifactId>managed</artifactId></dependency>
  <dependency><groupId>org.y</groupId><artifactId>unknown</artifactId><version>\${not.defined}</version><scope>test</scope></dependency>
</dependencies>
<build><sourceDirectory>src/java</sourceDirectory></build>`),
        "libs/pom.xml":
          pom(`<parent><groupId>g</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
<artifactId>libs</artifactId><packaging>pom</packaging><modules><module>core</module></modules>`),
        "libs/core/pom.xml":
          pom(`<parent><groupId>g</groupId><artifactId>libs</artifactId><version>1.0</version></parent>
<artifactId>core</artifactId>`),
        "extra/pom.xml": pom(
          `<parent><groupId>g</groupId><artifactId>parent</artifactId><version>1.0</version></parent><artifactId>extra</artifactId>`,
        ),
      },
      [
        "api/src/java",
        "api/src/test/java",
        "libs/core/src/main/java",
        "libs/core/target/generated-sources/annotations",
      ],
    );
    const build = (await new JavaBuildFiles(root).read())._unsafeUnwrap();
    expect(build.tools).toEqual(["maven"]);
    expect(build.modules.map((m) => [m.name, m.dir, m.packaging, m.parent ?? "", m.profile ?? ""])).toEqual([
      ["parent", ".", "pom", "", ""],
      ["api", "api", "jar", "parent", ""],
      ["libs", "libs", "pom", "parent", ""],
      ["core", "libs/core", "jar", "libs", ""],
      ["extra", "extra", "jar", "parent", "extra"],
    ]);
    const api = build.modules[1];
    expect(api?.dependencies.map(({ line: _l, ...d }) => d)).toEqual([
      { group: "g", artifact: "core", version: "1.0", scope: "compile", module: "core" },
      { group: "org.springframework", artifact: "spring-web", version: "6.1.0", scope: "provided" },
      { group: "org.x", artifact: "managed", version: "6.1.0", scope: "compile" },
      // Unknown properties are kept as written, so a reader sees what is not known.
      { group: "org.y", artifact: "unknown", version: "\u0024{not.defined}", scope: "test" },
    ]);
    expect(api?.sourceRoots).toEqual([
      { path: "api/src/java", kind: "main", declared: true },
      { path: "api/src/test/java", kind: "test", declared: false },
    ]);
    expect(api?.javaVersion?.version).toBe("21");
    expect(api?.javaVersion?.evidence.at).toBe("api/pom.xml:6");
    // Inherited from the parent, with the parent's file as evidence.
    const core = build.modules[3];
    expect(core?.javaVersion).toEqual({
      version: "17",
      evidence: { at: "pom.xml:5", source: "<maven.compiler.release>17</maven.compiler.release>" },
    });
    expect(core?.sourceRoots).toContainEqual({
      path: "libs/core/target/generated-sources/annotations",
      kind: "generated",
      declared: false,
    });
    expect(build.modules[0]?.modules).toEqual(["api", "libs"]);
  });

  test("a POM that is not XML is a note, not a failure; the rest is read", async () => {
    const root = await repo({
      "pom.xml": pom(
        `<groupId>g</groupId><artifactId>p</artifactId><version>1</version><modules><module>ok</module><module>bad</module></modules>`,
      ),
      "ok/pom.xml": pom(`<artifactId>ok</artifactId>`),
      "bad/pom.xml": "<project><unclosed></project>",
    });
    const build = (await new JavaBuildFiles(root).read())._unsafeUnwrap();
    expect(build.modules.map((m) => m.name)).toEqual(["p", "ok"]);
    expect(build.notes[0]).toContain("bad/pom.xml");
  });

  test("the compiler plugin's <release> and Spring Boot's java.version count too", async () => {
    const root = await repo({
      "pom.xml": pom(`<artifactId>a</artifactId><properties><java.version>11</java.version></properties>
<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>8</release></configuration></plugin></plugins></build>`),
    });
    expect((await new JavaBuildFiles(root).read())._unsafeUnwrap().modules[0]?.javaVersion?.version).toBe(
      "8",
    );
  });

  test("no build at the root: builds one or two folders down are read (a service beside a web app)", async () => {
    const root = await repo({
      "package.json": "{}",
      "services/billing/pom.xml": pom("<artifactId>billing</artifactId>"),
      "node_modules/x/pom.xml": pom("<artifactId>never</artifactId>"),
    });
    expect(buildDirs(root)).toEqual(["services/billing"]);
    const build = (await new JavaBuildFiles(root).read())._unsafeUnwrap();
    expect(build.modules.map((m) => [m.name, m.dir])).toEqual([["billing", "services/billing"]]);
  });

  test("no Java build at all: no tools, no modules", async () => {
    const root = await repo({ "package.json": "{}" });
    expect((await new JavaBuildFiles(root).read())._unsafeUnwrap()).toEqual({
      tools: [],
      builds: [],
      modules: [],
      notes: [],
    });
  });
});

describe("Gradle", () => {
  test("settings includes (Kotlin DSL), dependencies by configuration, project dependencies, toolchain", async () => {
    const root = await repo(
      {
        "settings.gradle.kts": 'rootProject.name = "inv"\ninclude("core", "app")\ninclude(":libs:util")\n',
        "build.gradle.kts": "subprojects { repositories { mavenCentral() } }\n",
        "core/build.gradle.kts": `plugins { \`java-library\` }
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}
dependencies {
    api("com.google.guava:guava:33.0.0-jre")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    // implementation("commented:out:1")
}
`,
        "app/build.gradle": `apply plugin: 'application'
sourceCompatibility = JavaVersion.VERSION_17
dependencies {
    implementation project(':core')
    implementation group: 'org.slf4j', name: 'slf4j-api', version: "\${slf4jVersion}"
    runtimeOnly 'org.postgresql:postgresql'
}
sourceSets {
    main {
        java {
            srcDirs = ['src/main/java', 'src/gen/java']
        }
    }
}
`,
        "gradle.properties": "slf4jVersion=2.0.13\n",
      },
      ["core/src/main/java", "app/src/main/java", "app/src/gen/java", "libs/util/src/main/java"],
    );
    const build = (await new JavaBuildFiles(root).read())._unsafeUnwrap();
    expect(build.tools).toEqual(["gradle"]);
    expect(build.modules.map((m) => [m.name, m.dir, m.parent])).toEqual([
      ["core", "core", "inv"],
      ["app", "app", "inv"],
      ["libs:util", "libs/util", "inv"],
    ]);
    const [core, app] = build.modules;
    expect(core?.javaVersion).toEqual({
      version: "21",
      evidence: { at: "core/build.gradle.kts:4", source: "languageVersion = JavaLanguageVersion.of(21)" },
    });
    expect(core?.dependencies.map(({ line: _l, ...d }) => d)).toEqual([
      { group: "com.google.guava", artifact: "guava", version: "33.0.0-jre", scope: "api" },
      {
        group: "org.junit.jupiter",
        artifact: "junit-jupiter",
        version: "5.10.2",
        scope: "testImplementation",
      },
    ]);
    expect(app?.javaVersion?.version).toBe("17");
    expect(app?.dependencies.map(({ line: _l, ...d }) => d)).toEqual([
      { group: "", artifact: "core", scope: "implementation", module: "core" },
      { group: "org.slf4j", artifact: "slf4j-api", version: "2.0.13", scope: "implementation" },
      { group: "org.postgresql", artifact: "postgresql", scope: "runtimeOnly" },
    ]);
    expect(app?.sourceRoots.filter((r) => r.declared).map((r) => r.path)).toEqual([
      "app/src/main/java",
      "app/src/gen/java",
    ]);
    // The root project builds no Java of its own: not a module.
    expect(build.modules.some((m) => m.dir === ".")).toBe(false);
  });

  test("a single-project build is the root module", async () => {
    const root = await repo({ "build.gradle": "plugins { id 'java' }\n" }, ["src/main/java"]);
    const build = (await new JavaBuildFiles(root).read())._unsafeUnwrap();
    expect(build.modules.map((m) => [m.dir, m.sourceRoots.map((r) => r.path)])).toEqual([
      [".", ["src/main/java"]],
    ]);
  });

  test("helpers read what is written simply", () => {
    expect(gradleSourceSets('sourceSets { test { java { srcDir("src/it/java") } } }')).toEqual([
      { path: "src/it/java", kind: "test" },
    ]);
    expect(
      gradleJavaVersion("tasks.withType<JavaCompile> { options.release = 11 }", "b.gradle.kts")?.version,
    ).toBe("11");
    expect(gradleJavaVersion("nothing here", "b")).toBeUndefined();
    expect(gradleDependencies("dependencies {\n implementation(libs.foo)\n}")).toEqual([]);
  });
});

describe("JavaWorkspace", () => {
  test("modules are workspace packages; an aggregator with no sources is not", async () => {
    const root = await repo(
      {
        "pom.xml": pom(
          "<groupId>g</groupId><artifactId>p</artifactId><version>1</version><packaging>pom</packaging><modules><module>a</module></modules>",
        ),
        "a/pom.xml": pom("<artifactId>a</artifactId>"),
      },
      ["a/src/main/java"],
    );
    const packages = (await new JavaWorkspace(new JavaBuildFiles(root)).packages())._unsafeUnwrap();
    expect(packages).toEqual([{ name: "a", dir: "a", build: "maven" }]);
  });
});
