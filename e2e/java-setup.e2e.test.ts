/**
 * MetatorAI set up in a Java repository (round 22, decision 8), end to end: the real `metator` on
 * the fixtures (`e2e/fixtures/java/`) in temp git repositories. `inspect` says what it is, `setup`
 * writes Maven or Gradle gates, the gates run with the real `mvn` and `gradle` and are green, the
 * quick gate on one changed file builds only its module, and `doctor` checks the JDK and the build
 * tool instead of node_modules. Tests that need a build tool skip, by name and with the reason,
 * when it is not installed; here (JDK 21, Maven 3.9, Gradle 8.14) they run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { metator, stopProcessesUnder } from "./helpers/cli.ts";
import { createJavaRepo, missingBuildTool } from "./helpers/java.ts";
import type { ScratchRepo } from "./helpers/repo.ts";

/** No real AI host starts; Gradle runs without a daemon that would outlive the test. */
const ENV = { METATOR_NO_REAL_HOSTS: "1", GRADLE_OPTS: "-Dorg.gradle.daemon=false" };
const BUILD_MS = 600_000;

interface Check {
  readonly id: string;
  readonly status: string;
  readonly message: string;
  readonly fix?: string;
}
interface Step {
  readonly id: string;
  readonly status: string;
  readonly command?: readonly string[];
  readonly detail?: string;
}

/** A gate's report: the data when it passed, the error's details when it failed (so a red step shows its output). */
const gateReport = (json: Record<string, unknown>) =>
  (json.data ?? (json.error as { details?: unknown } | undefined)?.details) as {
    passed: boolean;
    steps: Step[];
  };

/** A test that needs `tool`: skipped with the reason in its name when the tool is not here. */
function withTool(tool: "mvn" | "gradle") {
  const missing = missingBuildTool(tool);
  if (missing) console.warn(`skipped: ${missing}`);
  return (name: string, fn: () => Promise<void>, ms?: number) =>
    missing ? test.skip(`${name} (skipped: ${missing})`, fn) : test(name, fn, ms);
}

describe("a multi-module Maven repository", () => {
  let repo: ScratchRepo;
  let previewed: readonly string[] = [];
  const mt = (...args: string[]) => metator(args, repo.root, ENV);
  const mvn = withTool("mvn");

  beforeAll(async () => {
    repo = await createJavaRepo("maven");
  });
  afterAll(async () => {
    stopProcessesUnder(repo.root);
    await repo.dispose();
  });

  test("inspect says what it is in one line, and what setup will write", async () => {
    const r = await mt("inspect", ".");
    expect(r.code).toBe(0);
    const data = r.json.data as {
      next: string;
      repository: { stack: { languages: string[]; builds: unknown[]; line: string } };
      writes: { claude: string[] };
    };
    expect(data.next).toBe("setup");
    // The five modules of the default build; the profile's module is not one of them.
    expect(data.repository.stack).toEqual({
      languages: ["Java"],
      builds: [{ tool: "maven", wrapper: false, modules: 5, label: "Maven" }],
      line: "Java · Maven, 5 modules",
    });
    previewed = data.writes.claude;
    expect(previewed).toContain("metator.config.yml");
  });

  test("setup writes Maven gates (compile, test), the quick ones by module, and exactly what inspect said", async () => {
    const r = await mt("setup", "--host", "claude", "--yes");
    expect(r.code).toBe(0);
    const report = r.json.data as { written: string[] };
    // `inspect` previewed this list for the desktop app's "what setup will write": it holds here too.
    expect(report.written).toEqual([...previewed]);
    const config = parse(await Bun.file(join(repo.root, "metator.config.yml")).text());
    expect(config.schemaVersion).toBe(16);
    const steps = (gate: string) =>
      (config.gates[gate] as { id: string; run: unknown; files?: string }[]).map((s) => [
        s.id,
        s.run,
        s.files,
      ]);
    expect(steps("full")).toEqual([
      ["typecheck", { build: "maven", args: ["-q", "-B", "-DskipTests", "compile"] }, undefined],
      ["test", { build: "maven", args: ["-B", "test"] }, undefined],
    ]);
    expect(steps("quick").map(([id, , files]) => [id, files])).toEqual([
      ["typecheck", "modules"],
      ["test", "modules"],
    ]);
    // Nothing assumes npm: no "dependencies not installed" anywhere in what setup says.
    expect(JSON.stringify(r.json)).not.toContain("node_modules");
  });

  test("doctor checks the JDK against the declared release and the build tool, not node_modules", async () => {
    const r = await mt("doctor");
    expect(r.code).toBe(0);
    const checks = (r.json.data as { checks: Check[] }).checks;
    const byId = (id: string) => checks.find((c) => c.id === id);
    expect(byId("dependencies")).toMatchObject({
      status: "ok",
      message: "not a Node project: nothing to install",
    });
    const jdk = byId("jdk");
    if (Bun.which("java"))
      // The highest Java the build declares: the Java 21 module's, not the parent's 17.
      expect(jdk?.message).toMatch(
        /^JDK \d+; the build declares Java 21 \(shop-common\/pom\.xml:\d+ <maven\.compiler\.release>\)$/,
      );
    else expect(jdk).toMatchObject({ status: "warn" });
    expect(byId("build")).toEqual(
      Bun.which("mvn")
        ? { id: "build", status: "ok", message: "Maven runs as mvn from PATH (no mvnw)" }
        : expect.objectContaining({ status: "warn" }),
    );
    expect(byId("build-dependencies")?.status).toMatch(/^(ok|warn)$/);
    expect(JSON.stringify(r.json)).not.toContain("node_modules");
  });

  mvn(
    "the quick gate on one changed file builds only its module (and what it needs), with the real mvn",
    async () => {
      const file = "shop-common/src/main/java/com/example/shop/common/Strings.java";
      const r = await mt("gate", "quick", "--files", file);
      const report = gateReport(r.json);
      expect(report.steps.map((s) => [s.id, s.status, s.command?.slice(1)])).toEqual([
        ["typecheck", "pass", ["-pl", "shop-common", "-am", "-q", "-B", "-DskipTests", "compile"]],
        ["test", "pass", ["-pl", "shop-common", "-am", "-B", "test"]],
      ]);
      expect([r.code, report.passed]).toEqual([0, true]);
      // Only that module was built: the others have no classes yet.
      expect(existsSync(join(repo.root, "shop-common/target/classes"))).toBe(true);
      for (const other of ["shop-domain", "shop-api", "shop-reactive", "legacy-ejb"])
        expect([other, existsSync(join(repo.root, other, "target/classes"))]).toEqual([other, false]);
      // A change no Java build reads (a README) builds nothing.
      const docs = await mt("gate", "quick", "--files", "README.md");
      expect(gateReport(docs.json).steps.map((s) => s.status)).toEqual(["skipped", "skipped"]);
    },
    BUILD_MS,
  );

  mvn(
    "doctor --gates runs the whole quick gate with the real mvn: green",
    async () => {
      const r = await mt("doctor", "--gates");
      expect(r.code).toBe(0);
      const green = (r.json.data as { checks: Check[] }).checks.find((c) => c.id === "green");
      expect(green).toEqual({ id: "green", status: "ok", message: "the quick gate is green (2 step(s))" });
    },
    BUILD_MS,
  );
});

describe("a Gradle repository (Kotlin DSL)", () => {
  let repo: ScratchRepo;
  const mt = (...args: string[]) => metator(args, repo.root, ENV);
  const gradle = withTool("gradle");

  beforeAll(async () => {
    repo = await createJavaRepo("gradle");
  });
  afterAll(async () => {
    stopProcessesUnder(repo.root);
    await repo.dispose();
  });

  test("inspect and setup: Gradle gates, by project in the quick gate", async () => {
    const inspected = await mt("inspect", ".");
    expect((inspected.json.data as { repository: { stack: { line: string } } }).repository.stack.line).toBe(
      "Java · Gradle, Kotlin DSL, 2 modules",
    );
    const r = await mt("setup", "--host", "claude", "--yes");
    expect(r.code).toBe(0);
    const config = parse(await Bun.file(join(repo.root, "metator.config.yml")).text());
    expect(config.gates.full.map((s: { run: unknown }) => s.run)).toEqual([
      { build: "gradle", args: ["compileJava", "compileTestJava", "-q"] },
      { build: "gradle", args: ["test"] },
    ]);
    const doctor = await mt("doctor");
    const jdk = (doctor.json.data as { checks: Check[] }).checks.find((c) => c.id === "jdk");
    if (Bun.which("java"))
      expect(jdk?.message).toMatch(
        /the build declares Java 21 \(inventory-core\/build\.gradle\.kts:\d+ languageVersion = JavaLanguageVersion\.of\(21\)\)$/,
      );
  });

  gradle(
    "the gates run with the real gradle: the quick one on one file runs only its project, the full one is green",
    async () => {
      const quick = await mt(
        "gate",
        "quick",
        "--files",
        "inventory-core/src/main/java/com/example/inventory/core/Stock.java",
      );
      const q = gateReport(quick.json);
      expect(q.steps.map((s) => [s.id, s.status, s.command?.slice(1)])).toEqual([
        ["typecheck", "pass", [":inventory-core:compileJava", ":inventory-core:compileTestJava", "-q"]],
        ["test", "pass", [":inventory-core:test"]],
      ]);
      expect([quick.code, q.passed]).toEqual([0, true]);
      // The app project was not built by the quick gate.
      expect(existsSync(join(repo.root, "inventory-app/build/classes"))).toBe(false);
      const full = await mt("gate", "full");
      const f = gateReport(full.json);
      expect([full.code, f.passed, f.steps.map((s) => s.status)]).toEqual([0, true, ["pass", "pass"]]);
      expect(existsSync(join(repo.root, "inventory-app/build/classes"))).toBe(true);
    },
    BUILD_MS,
  );
});
