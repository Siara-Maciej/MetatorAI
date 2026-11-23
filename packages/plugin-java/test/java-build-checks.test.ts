import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JavaBuildFiles } from "../src/java-build-reader.ts";

/** What the gates, `setup` and `doctor` take from the build reader (round 22): the top build, its wrapper, the check plugins. */
const roots: string[] = [];
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metator-java-checks-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content);
  return root;
}
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
const read = async (root: string) => (await new JavaBuildFiles(root).read())._unsafeUnwrap();

const pom = (body: string) =>
  `<?xml version="1.0"?>\n<project>\n<modelVersion>4.0.0</modelVersion>\n${body}\n</project>\n`;

describe("the top build and its check plugins", () => {
  test("Maven: the wrapper; plugins of <build><plugins> only, not pluginManagement, reporting or a profile", async () => {
    const root = await repo({
      mvnw: "#!/bin/sh",
      "pom.xml": pom(`<artifactId>shop</artifactId><packaging>pom</packaging>
<modules><module>api</module></modules>
<build>
  <plugins>
    <plugin>
      <artifactId>maven-checkstyle-plugin</artifactId>
    </plugin>
  </plugins>
  <pluginManagement><plugins><plugin><artifactId>maven-pmd-plugin</artifactId></plugin></plugins></pluginManagement>
</build>
<reporting><plugins><plugin><artifactId>spotbugs-maven-plugin</artifactId></plugin></plugins></reporting>
<profiles><profile><id>fmt</id><build><plugins><plugin><artifactId>spotless-maven-plugin</artifactId></plugin></plugins></build></profile></profiles>`),
      "api/pom.xml": pom(
        "<artifactId>api</artifactId><build><plugins><plugin><artifactId>spotbugs-maven-plugin</artifactId></plugin></plugins></build>",
      ),
    });
    const build = await read(root);
    expect(build.builds).toEqual([{ tool: "maven", dir: ".", file: "pom.xml", wrapper: "mvnw" }]);
    expect(build.modules.map((m) => [m.name, m.checks])).toEqual([
      ["shop", [{ tool: "checkstyle", evidence: { at: "pom.xml:9", source: "maven-checkstyle-plugin" } }]],
      ["api", [{ tool: "spotbugs", evidence: { at: "api/pom.xml:4", source: "spotbugs-maven-plugin" } }]],
    ]);
  });

  test("Gradle: plugin ids, a bare core plugin in plugins { }, apply plugin; no wrapper; comments do not count", async () => {
    const root = await repo({
      "settings.gradle.kts": 'include("core")\n',
      "core/build.gradle.kts": `plugins {
    java
    checkstyle
    id("com.diffplug.spotless") version "6.25.0"
}
// id("com.github.spotbugs")
`,
      "build.gradle": "apply plugin: 'pmd'\n",
    });
    const build = await read(root);
    expect(build.builds).toEqual([{ tool: "gradle", dir: ".", file: "settings.gradle.kts", wrapper: null }]);
    expect(build.modules.find((m) => m.name === "core")?.checks).toEqual([
      { tool: "checkstyle", evidence: { at: "core/build.gradle.kts:3", source: "checkstyle" } },
      {
        tool: "spotless",
        evidence: { at: "core/build.gradle.kts:4", source: 'id("com.diffplug.spotless") version "6.25.0"' },
      },
    ]);
  });

  test("a repository kept for Windows only: its wrapper is mvnw.cmd (gradlew.bat)", async () => {
    const maven = await repo({ "pom.xml": pom("<artifactId>a</artifactId>"), "mvnw.cmd": "@echo off" });
    expect((await read(maven)).builds?.[0]?.wrapper).toBe("mvnw.cmd");
    const gradle = await repo({ "build.gradle": "", "gradlew.bat": "@echo off" });
    expect((await read(gradle)).builds?.[0]?.wrapper).toBe("gradlew.bat");
  });

  test("a build below the root (a service beside an app) is a top build of its folder", async () => {
    const root = await repo({
      "backend/pom.xml": pom("<artifactId>backend</artifactId>"),
      "backend/mvnw": "",
    });
    expect((await read(root)).builds).toEqual([
      { tool: "maven", dir: "backend", file: "backend/pom.xml", wrapper: "backend/mvnw" },
    ]);
  });
});
