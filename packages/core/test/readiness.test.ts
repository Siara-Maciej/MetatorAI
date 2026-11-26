import { describe, expect, test } from "bun:test";
import {
  CheckReadiness,
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  emptyGateHint,
  err,
  MetatorError,
  ok,
  RUN_READINESS,
  readinessWarnings,
  startRefusal,
} from "@metator/core";
import { FakeVcs } from "@metator/testing";

const present = (...paths: string[]) => ({ exists: async (p: string) => paths.includes(p) });
const catalog = (...ids: string[]) => ({
  scan: async () => ({ workflows: ids.map((id) => ({ spec: { id } })), problems: [] }) as never,
});
const gated = {
  ...DEFAULT_CONFIG,
  gates: { quick: [], full: [{ id: "rules", run: "rules check" }] },
} as never;

const present_ = present;

describe("CheckReadiness", () => {
  test("a set-up repository with its dependencies, gates and a remote is ready without warnings", async () => {
    const r = await new CheckReadiness(
      present("metator/install.lock.json", "package.json"),
      DEFAULT_PATHS,
      { config: gated, source: "metator.config.yml" },
      catalog("mt-feature", "mt-bugfix"),
      new FakeVcs([], [], "git@example.com:a/b.git"),
      async () => true,
    ).execute();
    const v = r._unsafeUnwrap();
    expect(v.ready).toBe(true);
    expect(v.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "config:ok",
      "canon:ok",
      "workflows:ok",
      "gates:ok",
      "dependencies:ok",
      "environment:ok",
      "mcp:ok",
      "isolation:warn",
      "remote:ok",
    ]);
    // Isolation is doctor's to say: a run does not repeat it at every start.
    expect(RUN_READINESS).not.toContain("isolation");
    expect(readinessWarnings(v, RUN_READINESS)).toEqual([]);
    expect(readinessWarnings(v)).toEqual([expect.stringContaining("without a sandbox")]);
  });

  test("a run whose record cannot be read is a warning that names the file and the way out (R2)", async () => {
    const r = await new CheckReadiness(
      present("metator/install.lock.json", "package.json"),
      DEFAULT_PATHS,
      { config: gated, source: "metator.config.yml" },
      catalog("mt-feature"),
      new FakeVcs([], [], "git@example.com:a/b.git"),
      async () => true,
      undefined,
      undefined,
      undefined,
      {
        loadAll: async () => ({
          runs: [],
          unreadable: [{ runId: "r1", file: ".metator/runs/r1/state.json", message: "not valid JSON" }],
        }),
      },
    ).execute();
    const v = r._unsafeUnwrap();
    expect(v.ready).toBe(true);
    expect(readinessWarnings(v)).toEqual([
      "isolation: agents' host sessions run without a sandbox: a script or a dependency they start can read every file you can (fix: metator config set sandbox.enabled true --scope repo)",
      "runs: run r1 cannot be read and is left out of the overviews (not valid JSON) (fix: restore .metator/runs/r1/state.json (from git or a backup), or delete the run's directory)",
    ]);
  });

  test("MCP servers (T1): named when configured; a command missing from the PATH is a warning with the fix", async () => {
    const ready = (servers: Record<string, { command?: string; url?: string }>, present: string[]) =>
      new CheckReadiness(
        present_("metator/install.lock.json", "package.json"),
        DEFAULT_PATHS,
        { config: gated, source: "metator.config.yml" },
        catalog("mt-feature"),
        new FakeVcs([], [], "git@example.com:a/b.git"),
        async () => true,
        undefined,
        undefined,
        {
          servers: async () =>
            ok(Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, { args: [], env: {}, ...v }]))),
          hasCommand: async (bin) => present.includes(bin),
        },
      ).execute();
    const mcp = async (...a: Parameters<typeof ready>) =>
      (await ready(...a))._unsafeUnwrap().checks.find((c) => c.id === "mcp");
    expect(
      await mcp({ github: { command: "gh-mcp" }, jira: { url: "https://j" } }, ["gh-mcp"]),
    ).toMatchObject({
      status: "ok",
      message: "MCP servers configured: github, jira",
    });
    expect(await mcp({ github: { command: "gh-mcp" } }, [])).toMatchObject({
      status: "warn",
      message: "MCP server command(s) not found: github (gh-mcp); the agents start without them",
    });
  });

  test("what a run will not do: no dependencies (with the lockfile's install), no gates, no remote", async () => {
    const r = await new CheckReadiness(
      present("package.json", "pnpm-lock.yaml"),
      DEFAULT_PATHS,
      { config: DEFAULT_CONFIG },
      catalog("mt-feature"),
      new FakeVcs([]),
      async () => false,
    ).execute();
    const v = r._unsafeUnwrap();
    expect(v.ready).toBe(true); // warnings only: a run starts, and does less
    expect(readinessWarnings(v)).toEqual([
      "config: no metator.config: MetatorAI's defaults apply (no gates, every host) (fix: metator init)",
      "canon: the agents and skills are not installed by MetatorAI here (fix: metator setup)",
      "gates: no gates configured: a run's gates stage checks nothing (fix: metator init (it proposes gates from the repository's scripts))",
      "dependencies: dependencies are not installed: in a run, tests, the type checker and linters cannot run, so gates check only rules (fix: pnpm install)",
      "isolation: agents' host sessions run without a sandbox: a script or a dependency they start can read every file you can (fix: metator config set sandbox.enabled true --scope repo)",
      "remote: no git remote: a run's publish stage cannot push its branch (fix: git remote add origin <url>)",
    ]);
  });

  test("a run carries only what it will not do: gates, dependencies, remote", async () => {
    const v = (
      await new CheckReadiness(
        present("package.json"),
        DEFAULT_PATHS,
        { config: DEFAULT_CONFIG },
        catalog("w"),
        new FakeVcs([]),
        async () => false,
      ).execute()
    )._unsafeUnwrap();
    expect(readinessWarnings(v, RUN_READINESS).map((w) => w.split(":")[0])).toEqual([
      "gates",
      "dependencies",
      "remote",
    ]);
  });

  test("no workflow fails: nothing a run could follow; a project without a lockfile installs with npm", async () => {
    const v = (
      await new CheckReadiness(
        present("package.json"),
        DEFAULT_PATHS,
        { config: DEFAULT_CONFIG },
        catalog(),
        new FakeVcs("not-a-repo"),
        async () => false,
      ).execute()
    )._unsafeUnwrap();
    expect(v.ready).toBe(false);
    expect(v.checks.find((c) => c.id === "workflows")?.status).toBe("fail");
    expect(v.checks.find((c) => c.id === "dependencies")?.fix).toBe("npm install");
    expect(v.checks.find((c) => c.id === "remote")?.status).toBe("warn");
  });

  test("no gates with a config: the fix names the key to edit, never init (it refuses an existing config)", async () => {
    const v = (
      await new CheckReadiness(
        present_(),
        DEFAULT_PATHS,
        { config: DEFAULT_CONFIG, source: "metator.config.yml" },
        catalog("mt-feature"),
        new FakeVcs([]),
        async () => false,
      ).execute()
    )._unsafeUnwrap();
    const fix = v.checks.find((c) => c.id === "gates")?.fix ?? "";
    expect(fix).toContain("`gates.full:` in metator.config.yml");
    expect(fix).toContain("- { id: test, run: { script: test } }");
    expect(fix).not.toContain("metator init");
    expect(emptyGateHint("quick", undefined)).toContain("metator init");
  });

  test("a repository with no commit is not ready: a run's worktree needs one", async () => {
    const vcs = (commits: boolean) => ({
      remoteUrl: async () => ok("git@example.com:a/b.git"),
      hasCommits: async () => ok(commits),
    });
    const check = (commits: boolean) =>
      new CheckReadiness(
        present_("metator/install.lock.json"),
        DEFAULT_PATHS,
        { config: gated, source: "metator.config.yml" },
        catalog("mt-feature"),
        vcs(commits),
        async () => true,
      ).execute();
    const v = (await check(false))._unsafeUnwrap();
    expect(v.ready).toBe(false);
    expect(v.checks.find((c) => c.id === "commits")).toEqual({
      id: "commits",
      status: "fail",
      message: "the repository has no commit yet: a run's worktree and its diff need one",
      fix: "git commit --allow-empty -m init",
    });
    const fine = (await check(true))._unsafeUnwrap();
    expect([fine.ready, fine.checks.some((c) => c.id === "commits")]).toEqual([true, false]);
  });

  test("a worktree: its own package.json and node_modules, its own services; the fix is worktree setup", async () => {
    const wt = ".metator/wt/20261102-mt-feature-a";
    const entry = { id: "20261102-mt-feature-a", path: wt };
    const check = new CheckReadiness(
      present("package.json", `${wt}/package.json`),
      DEFAULT_PATHS,
      { config: DEFAULT_CONFIG },
      catalog("w"),
      new FakeVcs([]),
      async (p) => p === "node_modules",
      {
        get: async (id) =>
          id === entry.id ? ok(entry as never) : err(MetatorError.notFound(`worktree ${id}`)),
      },
      {
        status: async (input) =>
          ok([
            {
              service: "api",
              scope: "worktree",
              place: "a",
              status: input.worktree ? "not running" : "running",
              ports: {},
            },
            { service: "db", scope: "shared", place: "shared", status: "running", ports: {} },
          ] as never),
      },
    );
    const here = (await check.execute())._unsafeUnwrap();
    expect([here.place, here.checks.find((c) => c.id === "dependencies")?.status]).toEqual([".", "ok"]);
    expect(here.checks.find((c) => c.id === "environment")?.message).toBe("services running: 2 of 2");
    const there = (await check.execute({ worktree: entry.id }))._unsafeUnwrap();
    expect(there.place).toBe(wt);
    expect(there.checks.find((c) => c.id === "dependencies")).toMatchObject({
      status: "warn",
      fix: "metator worktree setup --worktree <id>",
    });
    expect(there.checks.find((c) => c.id === "environment")).toEqual({
      id: "environment",
      status: "warn",
      message: "services running: 1 of 2: a run cannot reach the application",
      fix: `metator env up --worktree ${entry.id}`,
    });
    expect((await check.execute({ worktree: "nope" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("a repository that is not a Node project has nothing to install", async () => {
    const v = (
      await new CheckReadiness(
        present(),
        DEFAULT_PATHS,
        { config: DEFAULT_CONFIG },
        catalog("w"),
        new FakeVcs([]),
        async () => false,
      ).execute()
    )._unsafeUnwrap();
    expect(v.checks.find((c) => c.id === "dependencies")).toEqual({
      id: "dependencies",
      status: "ok",
      message: "not a Node project: nothing to install",
    });
  });

  const here = (
    extra: ConstructorParameters<typeof CheckReadiness>[10],
    vcs: ConstructorParameters<typeof CheckReadiness>[4] = new FakeVcs([], [], "git@example.com:a/b.git"),
    files: Record<string, string> = {},
    worktree?: string,
  ) =>
    new CheckReadiness(
      {
        exists: async (p: string) => p === "metator/install.lock.json" || p in files,
        read: async (p: string) => (p in files ? ok(files[p] as string) : err(MetatorError.notFound(p))),
      },
      DEFAULT_PATHS,
      { config: gated, source: "metator.config.yml" },
      catalog("mt-feature"),
      vcs,
      async () => false,
      { get: async () => ok({ path: ".metator/wt/a" }) as never },
      undefined,
      undefined,
      undefined,
      extra,
    ).execute(worktree ? { worktree } : {});

  test("a directory git does not know is not ready, with the commands that make it one (F3)", async () => {
    const v = (
      await here(
        {},
        {
          remoteUrl: async () => err(MetatorError.notFound("git repository")),
          hasCommits: async () => err(MetatorError.notFound("git repository")),
        },
      )
    )._unsafeUnwrap();
    expect(v.ready).toBe(false);
    expect(v.checks.find((c) => c.id === "git")).toEqual({
      id: "git",
      status: "fail",
      message: "not a git repository: a run's change, its review and its worktree need git",
      fix: "git init && git commit --allow-empty -m init",
    });
    const refusal = startRefusal(v, { worktree: false });
    expect([refusal?.code, refusal?.hint]).toEqual([
      "CHECK_FAILED",
      "Run `git init && git commit --allow-empty -m init`, then start the run again.",
    ]);
    // Another failure of git (not "no repository") is not this check's to judge.
    const odd = (
      await here(
        {},
        {
          remoteUrl: async () => ok(undefined),
          hasCommits: async () => err(new MetatorError("COMMAND_FAILED", "git timed out")),
        },
      )
    )._unsafeUnwrap();
    expect(odd.checks.some((c) => c.id === "git")).toBe(false);
  });

  test("AI hosts: ok while one can start (the one that cannot is named), not ready when none can (F3)", async () => {
    const host = async (...hosts: { id: string; problem?: string }[]) =>
      (await here({ hosts: () => hosts }))._unsafeUnwrap();
    const all = await host({ id: "claude" }, { id: "copilot" });
    expect(all.checks.find((c) => c.id === "host")).toEqual({
      id: "host",
      status: "ok",
      message: "AI hosts that can drive a run: claude, copilot",
    });
    const one = await host({ id: "claude" }, { id: "copilot", problem: "`copilot` is not installed" });
    expect([one.ready, one.checks.find((c) => c.id === "host")]).toEqual([
      true,
      {
        id: "host",
        status: "ok",
        message: "AI hosts that can drive a run: claude; cannot start: copilot (`copilot` is not installed)",
      },
    ]);
    const none = await host({ id: "copilot", problem: "`copilot` is not installed" });
    expect([none.ready, none.checks.find((c) => c.id === "host")?.status]).toEqual([false, "fail"]);
    // No host failure refuses a run by itself: a session in the host can carry it.
    expect(startRefusal(none, { worktree: true })).toBeUndefined();
    expect((await host()).checks.some((c) => c.id === "host")).toBe(false);
  });

  test("uncommitted changes to tracked files are said, and refuse a worktree run unless allowed (F3)", async () => {
    const dirty = (await here({ modified: async () => ["a.ts", "b.ts", "c.ts", "d.ts"] }))._unsafeUnwrap();
    const tree = dirty.checks.find((c) => c.id === "tree");
    expect([dirty.ready, tree?.status, tree?.fix]).toEqual([
      true,
      "warn",
      "git commit -am <message>, or git stash",
    ]);
    expect(tree?.message).toStartWith("4 tracked file(s) have uncommitted changes (a.ts, b.ts, c.ts, …)");
    expect(readinessWarnings(dirty, RUN_READINESS).some((w) => w.startsWith("tree: "))).toBe(true);
    expect(startRefusal(dirty, { worktree: false })).toBeUndefined();
    expect(startRefusal(dirty, { worktree: true, allowDirty: true })).toBeUndefined();
    const refusal = startRefusal(dirty, { worktree: true });
    expect([refusal?.code, refusal?.details]).toEqual(["CHECK_FAILED", { check: "tree" }]);
    expect(refusal?.message).toStartWith("the run would start without your changes: 4 tracked file(s)");
    // A clean tree, or git that cannot say, adds no check; a worktree's own changes are the run's.
    for (const modified of [async () => [], async () => undefined])
      expect((await here({ modified }))._unsafeUnwrap().checks.some((c) => c.id === "tree")).toBe(false);
    const inWorktree = (await here({ modified: async () => ["a.ts"] }, undefined, {}, "a"))._unsafeUnwrap();
    expect(inWorktree.checks.some((c) => c.id === "tree")).toBe(false);
  });

  test("a package.json that lists nothing to install misses nothing without node_modules (F5)", async () => {
    const deps = async (manifest: string) =>
      (await here({}, undefined, { "package.json": manifest }))
        ._unsafeUnwrap()
        .checks.find((c) => c.id === "dependencies");
    expect(await deps('{"name":"x","scripts":{"test":"node t.js"}}')).toEqual({
      id: "dependencies",
      status: "ok",
      message: "package.json lists no dependencies: nothing to install",
    });
    expect((await deps('{"dependencies":{"a":"1"}}'))?.status).toBe("warn");
    expect((await deps('{"workspaces":["p/*"]}'))?.status).toBe("warn");
  });
});

describe("CheckReadiness: the host conformance suite's kept runs (ADR-0098)", () => {
  const withSeen = (seen: Parameters<typeof conformanceSeenStub>[0]) =>
    new CheckReadiness(
      present("metator/install.lock.json", "package.json"),
      DEFAULT_PATHS,
      { config: gated, source: "metator.config.yml" },
      catalog("mt-feature"),
      new FakeVcs([], [], "git@example.com:a/b.git"),
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      { conformance: conformanceSeenStub(seen) },
    ).execute();
  const conformanceSeenStub =
    (seen: readonly { host: string; passed?: { cliVersion: string; at: string }; installed?: string }[]) =>
    async () =>
      seen;

  test("a line per host that has a run kept: the version and day it last passed; an older version installed is a warning only", async () => {
    const v = (
      await withSeen([
        {
          host: "claude",
          passed: { cliVersion: "2.1.0", at: "2026-11-22T10:00:00.000Z" },
          installed: "2.1.0",
        },
        {
          host: "copilot",
          passed: { cliVersion: "1.0.114", at: "2026-11-21T10:00:00.000Z" },
          installed: "1.0.99",
        },
      ])
    )._unsafeUnwrap();
    expect(v.checks.filter((c) => c.id === "conformance")).toEqual([
      { id: "conformance", status: "ok", message: "last passed with claude 2.1.0 on 2026-11-22" },
      {
        id: "conformance",
        status: "warn",
        message: "last passed with copilot 1.0.114 on 2026-11-21; copilot 1.0.99 installed here is older",
        fix: "metator host conformance --host copilot",
      },
    ]);
    expect(v.ready).toBe(true);
  });

  test("no run kept: no line at all", async () => {
    expect((await withSeen([]))._unsafeUnwrap().checks.some((c) => c.id === "conformance")).toBe(false);
  });
});

describe("CheckReadiness in a Java repository (round 22)", () => {
  const maven = {
    tool: "maven" as const,
    file: "pom.xml",
    wrapper: null,
    checks: [],
    java: { version: 17, evidence: "pom.xml:5 <maven.compiler.release>" },
  };
  const doctor = (
    here: ConstructorParameters<typeof CheckReadiness>[10],
    onPath: readonly string[] = [],
    files: readonly string[] = ["metator/install.lock.json"],
  ) =>
    new CheckReadiness(
      present(...files),
      DEFAULT_PATHS,
      { config: gated, source: "metator.config.yml" },
      catalog("mt-feature"),
      new FakeVcs([], [], "git@example.com:a/b.git"),
      async () => false,
      undefined,
      undefined,
      { servers: async () => ok({}), hasCommand: async (bin) => onPath.includes(bin) },
      undefined,
      here,
    )
      .execute()
      .then((r) =>
        r
          ._unsafeUnwrap()
          .checks.filter((c) => ["jdk", "build", "build-dependencies", "dependencies"].includes(c.id)),
      );

  test("a JDK new enough, Maven on PATH, its cache here: all ok, and nothing about node_modules", async () => {
    const checks = await doctor(
      {
        builds: async () => [maven],
        java: async () => 'openjdk version "21.0.5" 2024-10-15',
        buildCache: async () => true,
      },
      ["mvn"],
    );
    expect(checks).toEqual([
      { id: "dependencies", status: "ok", message: "not a Node project: nothing to install" },
      {
        id: "jdk",
        status: "ok",
        message: "JDK 21; the build declares Java 17 (pom.xml:5 <maven.compiler.release>)",
      },
      { id: "build", status: "ok", message: "Maven runs as mvn from PATH (no mvnw)" },
      {
        id: "build-dependencies",
        status: "ok",
        message:
          "Maven's local cache is here (~/.m2/repository); whether every dependency resolves shows when the build runs",
      },
    ]);
  });

  test("no JDK, no Maven and no wrapper, nothing downloaded: warnings with their fixes, never a failure", async () => {
    const checks = await doctor({
      builds: async () => [maven],
      java: async () => undefined,
      buildCache: async () => false,
    });
    expect(checks.map((c) => [c.id, c.status, c.fix])).toEqual([
      ["dependencies", "ok", undefined],
      ["jdk", "warn", "install a JDK 17 or newer and put `java` on PATH (or set JAVA_HOME)"],
      [
        "build",
        "warn",
        "install Maven (https://maven.apache.org/download.cgi), or add the wrapper: mvn wrapper:wrapper",
      ],
      ["build-dependencies", "warn", "metator doctor --gates"],
    ]);
  });

  test("an old JDK is said with the declared version's evidence; the Gradle wrapper needs no gradle on PATH", async () => {
    const checks = await doctor(
      {
        builds: async () => [{ ...maven, tool: "gradle", file: "build.gradle.kts", wrapper: "gradlew" }],
        java: async () => 'java version "1.8.0_392"',
        buildCache: async () => true,
      },
      [],
      ["metator/install.lock.json", "gradlew"],
    );
    expect(checks.find((c) => c.id === "jdk")?.message).toBe(
      "JDK 8 is older than the Java 17 the build declares (pom.xml:5 <maven.compiler.release>): the gates would fail to compile",
    );
    expect(checks.find((c) => c.id === "build")?.message).toBe("Gradle runs through gradlew");
  });

  test("on Windows the wrapper is mvnw.cmd: the shell script alone does not run there, and the tool is mvn", async () => {
    const windows = (files: string[], onPath: string[] = []) =>
      doctor(
        {
          builds: async () => [{ ...maven, wrapper: "mvnw" }],
          java: async () => 'openjdk version "21.0.5"',
          buildCache: async () => true,
          platform: () => "win32",
        },
        onPath,
        ["metator/install.lock.json", ...files],
      ).then((c) => c.find((x) => x.id === "build"));
    expect((await windows(["mvnw", "mvnw.cmd"]))?.message).toBe("Maven runs through mvnw.cmd");
    expect(await windows(["mvnw"], ["mvn"])).toEqual({
      id: "build",
      status: "ok",
      message: "Maven runs as mvn from PATH (no mvnw.cmd)",
    });
    expect(await windows(["mvnw"])).toMatchObject({
      status: "warn",
      message: "neither mvnw.cmd nor mvn is here: the gates cannot build the Java code",
    });
  });

  test("a repository without a Java build gets no Java checks", async () => {
    const checks = await doctor(
      { builds: async () => [], java: async () => undefined },
      [],
      ["metator/install.lock.json", "package.json"],
    );
    expect(checks.map((c) => c.id)).toEqual(["dependencies"]);
  });
});

describe("CheckReadiness: the command scripts call MetatorAI by (hosts.metatorCommand)", () => {
  const stages = (...owners: string[]) => ({ stages: owners.map((owner, i) => ({ id: `s${i}`, owner })) });
  const doctor = (metatorCommand: string, onPath: string[], workflows: Record<string, unknown>[]) =>
    new CheckReadiness(
      present("metator/install.lock.json", "package.json"),
      DEFAULT_PATHS,
      {
        config: { ...DEFAULT_CONFIG, hosts: { ...DEFAULT_CONFIG.hosts, metatorCommand } } as never,
        source: "metator.config.yml",
      },
      { scan: async () => ({ workflows: workflows.map((spec) => ({ spec })), problems: [] }) as never },
      new FakeVcs([], [], "git@example.com:a/b.git"),
      async () => true,
      undefined,
      undefined,
      { servers: async () => ok({}), hasCommand: async (bin) => onPath.includes(bin) },
    )
      .execute()
      .then((r) => r._unsafeUnwrap());

  test("a script stage that calls metator, which is not on the PATH: not ready, with the fix", async () => {
    const r = await doctor("metator", [], [{ id: "mt-feature", ...stages("script:metator index build") }]);
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.id === "metator")).toEqual({
      id: "metator",
      status: "fail",
      message:
        "`metator` (hosts.metatorCommand) is not on the PATH: the script stages of mt-feature that call MetatorAI cannot start",
      fix: 'put metator on the PATH, or set hosts.metatorCommand in metator.config.yml to how this repository runs MetatorAI (e.g. "npx metator" or "bun run metator")',
    });
  });

  test("a gate script and a parallel worker count; the first word of the command is what must be found", async () => {
    const gated = [
      { id: "w", stages: [{ id: "g", gate: { script: "metator gate quick" } }] },
      { id: "v", stages: [{ id: "p", parallel: ["mt-reviewer", "script:metator rules check"] }] },
    ];
    const missing = await doctor("bun run metator", ["metator"], gated);
    expect([missing.ready, missing.checks.find((c) => c.id === "metator")?.message]).toEqual([
      false,
      "`bun` (hosts.metatorCommand) is not on the PATH: the script stages of w, v that call MetatorAI cannot start",
    ]);
    const found = await doctor("bun run metator", ["bun"], gated);
    expect([found.ready, found.checks.some((c) => c.id === "metator")]).toEqual([true, false]);
  });

  test("no workflow script calls metator: only a warning (agents' hooks and commands still call it)", async () => {
    const r = await doctor("metator", [], [{ id: "w", ...stages("mt-implementer", "script:bun test") }]);
    expect([r.ready, r.checks.find((c) => c.id === "metator")?.status]).toEqual([true, "warn"]);
  });
});
