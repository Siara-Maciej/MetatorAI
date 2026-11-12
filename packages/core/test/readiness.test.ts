import { describe, expect, test } from "bun:test";
import {
  CheckReadiness,
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  err,
  MetatorError,
  ok,
  RUN_READINESS,
  readinessWarnings,
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
      "remote:ok",
    ]);
    expect(readinessWarnings(v)).toEqual([]);
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
});
