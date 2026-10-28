import { describe, expect, test } from "bun:test";
import {
  FakeBackgroundProcess,
  FakeContainerRuntime,
  FakeDataIsolator,
  FakeHealthProbe,
  FakeTreeCopier,
  FixedClock,
  InMemoryFileSystem,
} from "@metator/testing";
import {
  DiscoverEnvironment,
  EnvironmentCatalog,
  EnvironmentServices,
  InitEnvironment,
} from "../src/application/environments.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { WorktreeRegistry } from "../src/application/worktrees.ts";
import {
  assignPorts,
  type Environment,
  EnvironmentDocument,
  healthTarget,
  lintEnvironment,
  serviceEnv,
  startOrder,
} from "../src/domain/environment.ts";
import { proposeEnvironment } from "../src/domain/environment-discovery.ts";
import { ok } from "../src/domain/result.ts";
import { parseYamlDocument } from "../src/domain/versioned.ts";
import type { ProcessResult, ResolvedCommand } from "../src/ports/index.ts";

const env = (services: Record<string, unknown>, profiles: Record<string, string[]> = {}): Environment =>
  EnvironmentDocument.parse(
    { kind: "Environment", schemaVersion: 1, services, profiles },
    "e",
  )._unsafeUnwrap();

const SHOP = {
  db: {
    source: { compose: { file: "compose.yml", service: "db" } },
    scope: "shared",
    ports: { pg: 5432 },
    health: { tcp: "pg" },
  },
  api: {
    source: { script: "bun run dev" },
    needs: ["db"],
    ports: { http: 3000, debug: 9229 },
    health: { http: "/health" },
    env: { DATABASE_URL: "postgres://localhost:{port:db.pg}/shop" },
  },
  web: { source: { script: "bun run web" }, needs: ["api"], ports: { http: 5173 } },
  docs: { source: { script: "bun run docs" }, scope: "on-demand" },
};

describe("environment domain", () => {
  test("lint: unknown needs, missing health port, shared needing worktree, cycles, unknown profile service", () => {
    const problems = lintEnvironment(
      env(
        {
          a: { source: { script: "a" }, needs: ["b", "ghost"], health: { tcp: "nope" } },
          b: { source: { script: "b" }, needs: ["a"] },
          s: { source: { script: "s" }, scope: "shared", needs: ["a"] },
        },
        { p: ["zz"] },
      ),
    ).map((p) => p.message);
    expect(problems).toEqual([
      "needs unknown service ghost",
      "health checks port nope, which it does not declare",
      "a shared service can need only shared services",
      "profile p names unknown service zz",
      "services need each other in a cycle: a, b",
    ]);
    expect(lintEnvironment(env(SHOP))).toEqual([]);
  });

  test("start order: what is needed first; on-demand only when asked; wanted pulls in its needs", () => {
    const e = env(SHOP);
    expect(startOrder(e)).toEqual(["db", "api", "web"]);
    expect(startOrder(e, ["api"])).toEqual(["db", "api"]);
    expect(startOrder(e, ["docs"])).toEqual(["docs"]);
  });

  test("ports: worktree services take the block in order, shared keep theirs; a small block fails", () => {
    const e = env(SHOP);
    expect(assignPorts(e)).toEqual({
      db: { pg: 5432 },
      api: { http: 3000, debug: 9229 },
      web: { http: 5173 },
      docs: {},
    });
    expect(assignPorts(e, { from: 41000, count: 20 })).toEqual({
      db: { pg: 5432 },
      api: { http: 41000, debug: 41001 },
      web: { http: 41002 },
      docs: {},
    });
    expect(assignPorts(e, { from: 41000, count: 2 })).toBeUndefined();
  });

  test("a service's environment: every port, its own PORT and filled placeholders", () => {
    const e = env(SHOP);
    const vars = serviceEnv(e, assignPorts(e, { from: 41000, count: 20 }) as never, "api");
    expect(vars).toMatchObject({
      PORT: "41000",
      METATOR_PORT_DB_PG: "5432",
      METATOR_PORT_API_HTTP: "41000",
      METATOR_PORT_WEB_HTTP: "41002",
      DATABASE_URL: "postgres://localhost:5432/shop",
    });
  });

  test("health targets: a port name or number for TCP, a path on the first port or a URL for HTTP", () => {
    const e = env({
      ...SHOP,
      x: { source: { script: "x" }, health: { tcp: 7000 } },
      y: { source: { script: "y" }, health: { http: "http://localhost:1/ready" } },
    });
    const ports = assignPorts(e) as never;
    expect([
      healthTarget(e, ports, "db"),
      healthTarget(e, ports, "api"),
      healthTarget(e, ports, "x"),
    ]).toEqual([
      { tcp: { host: "127.0.0.1", port: 5432 } },
      { http: "http://127.0.0.1:3000/health" },
      { tcp: { host: "127.0.0.1", port: 7000 } },
    ]);
    expect([healthTarget(e, ports, "y"), healthTarget(e, ports, "web")]).toEqual([
      { http: "http://localhost:1/ready" },
      undefined,
    ]);
  });
});

describe("proposeEnvironment", () => {
  test("compose: infrastructure images are shared, built services per worktree, depends_on becomes needs", () => {
    const p = proposeEnvironment({
      compose: [
        {
          file: "docker-compose.yml",
          doc: {
            services: {
              db: { image: "postgres:16", ports: ["5432:5432"] },
              cache: { image: "redis:7-alpine", ports: [{ published: 6379, target: 6379 }] },
              api: {
                build: ".",
                ports: ["127.0.0.1:3000:3000"],
                depends_on: { db: { condition: "service_healthy" }, cache: {} },
              },
              mq: { image: "bitnami/rabbitmq:3" },
              search: { image: "elasticsearch:8", build: "./search" },
            },
          },
        },
      ],
      scripts: [],
      runScript: "bun run",
    });
    const s = p.environment?.services ?? {};
    expect(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [v.scope, v.ports, v.needs]]))).toEqual({
      db: ["shared", { p5432: 5432 }, []],
      cache: ["shared", { p6379: 6379 }, []],
      api: ["worktree", { p3000: 3000 }, ["db", "cache"]],
      mq: ["shared", {}, []],
      // An infrastructure image built from the repository is the team's own code: per worktree.
      search: ["worktree", {}, []],
    });
    expect(p.warnings).toEqual([
      "mq: no health check; env up cannot tell when it is ready",
      "search: no health check; env up cannot tell when it is ready",
    ]);
  });

  test("start scripts with their port, a Procfile; a Makefile target only when nothing else is found", () => {
    const p = proposeEnvironment({
      compose: [],
      scripts: [{ dir: "apps/web", name: "dev", script: "dev", body: "vite --port 5173" }],
      runScript: "pnpm run",
      procfile: "worker: node worker.js\n\n# comment\n",
      makefile: "dev:\n\tgo run .\n",
    });
    expect(p.environment?.services).toMatchObject({
      web: {
        source: { script: "pnpm run dev", cwd: "apps/web" },
        ports: { http: 5173 },
        health: { http: "/" },
      },
      worker: { source: { script: "node worker.js" } },
    });
    expect(Object.keys(p.environment?.services ?? {})).not.toContain("make-dev");
    const make = proposeEnvironment({
      compose: [],
      scripts: [],
      runScript: "npm run",
      makefile: "run:\n\tgo run .\n",
    });
    expect(Object.keys(make.environment?.services ?? {})).toEqual(["make-run"]);
    const none = proposeEnvironment({ compose: [], scripts: [], runScript: "npm run" });
    expect([none.environment, none.warnings.length]).toEqual([null, 1]);
  });
});

const ENV_YAML = `kind: Environment
schemaVersion: 1
services:
  db:
    source: { compose: { file: compose.yml, service: db } }
    scope: shared
    ports: { pg: 5432 }
    health: { tcp: pg }
  api:
    source: { script: "bun run dev", cwd: apps/api }
    needs: [db]
    ports: { http: 3000 }
    health: { http: /health }
  docs:
    source: { script: "bun run docs" }
    scope: on-demand
profiles:
  backend: [api]
`;

/** Steps run instantly; `slow` maps a step command to the time it takes on the clock. */
class StepRunner {
  readonly calls: ResolvedCommand[] = [];
  constructor(
    private readonly clock: FixedClock,
    private readonly slow: Readonly<Record<string, number>> = {},
    private readonly failing: ReadonlySet<string> = new Set(),
  ) {}
  async run(command: ResolvedCommand): Promise<ProcessResult> {
    this.calls.push(command);
    const script = command.argv[2] ?? "";
    this.clock.advance(this.slow[script] ?? 0);
    const exitCode = this.failing.has(script) ? 1 : 0;
    return { exitCode, stdout: "", stderr: exitCode ? "boom\n" : "", durationMs: 0 };
  }
}

async function world(
  opts: {
    down?: (t: unknown) => boolean;
    yaml?: string;
    files?: Record<string, string>;
    slow?: Record<string, number>;
    failing?: string[];
  } = {},
) {
  const fs = new InMemoryFileSystem({ "metator/environment.yml": opts.yaml ?? ENV_YAML, ...opts.files });
  const registry = new WorktreeRegistry(fs, DEFAULT_PATHS);
  await registry.save([
    {
      id: "feat",
      path: ".metator/wt/feat",
      branch: "metator/feat",
      base: "HEAD",
      ports: { from: 41000, count: 20 },
      createdAt: "2026-10-27T10:00:00.000Z",
    },
  ]);
  const clock = new FixedClock(new Date("2026-10-27T10:00:00.000Z"));
  const processes = new FakeBackgroundProcess();
  const containers = new FakeContainerRuntime();
  const health = new FakeHealthProbe(opts.down as never);
  const steps = new StepRunner(clock, opts.slow, new Set(opts.failing));
  const isolator = new FakeDataIsolator();
  const copier = new FakeTreeCopier();
  const services = new EnvironmentServices(
    new EnvironmentCatalog(fs, DEFAULT_PATHS),
    registry,
    { processes, containers, health, steps, isolator, copier },
    fs,
    clock,
    DEFAULT_PATHS,
    { root: "/repo", logDir: "/tmp" },
  );
  return { fs, processes, containers, health, steps, isolator, copier, clock, services };
}

describe("EnvironmentServices", () => {
  test("up in a worktree: shared db once (one compose project per repository and place), api on the block in the worktree", async () => {
    const w = await world();
    const r = (await w.services.up({ worktree: "feat" }))._unsafeUnwrap();
    expect(r.map((s) => [s.service, s.place, s.status, s.ports])).toEqual([
      ["db", "shared", "started", { pg: 5432 }],
      ["api", "feat", "started", { http: 41000 }],
    ]);
    expect(w.containers.calls[0]).toMatchObject({
      op: "up",
      service: { project: "metator-repo-81f9fa-shared", cwd: "/repo", service: "db" },
    });
    expect(w.processes.started[0]).toMatchObject({
      argv: ["sh", "-c", "bun run dev"],
      cwd: "/repo/.metator/wt/feat/apps/api",
      logFile: "/tmp/metator-env-feat-api.log",
      env: {
        PORT: "41000",
        METATOR_PORT_DB_PG: "5432",
        METATOR_WORKTREE: "feat",
        METATOR_PORT_BASE: "41000",
      },
    });
    expect(w.health.checked).toEqual([
      { tcp: { host: "127.0.0.1", port: 5432 } },
      { http: "http://127.0.0.1:41000/health" },
    ]);
    // Again: everything is already running.
    const again = (await w.services.up({ worktree: "feat" }))._unsafeUnwrap();
    expect(again.map((s) => s.status)).toEqual(["running", "running"]);
    expect(w.processes.started.length).toBe(1);
  });

  test("a service that never becomes ready is an error with its log; profiles and names select services", async () => {
    const w = await world({ down: (t) => "http" in (t as object) });
    w.processes.logs.set("/tmp/metator-env-main-api.log", "listening… no\nError: EADDRINUSE");
    const failed = (await w.services.up({}))._unsafeUnwrapErr();
    expect([failed.message, (failed.details as { log: string }).log]).toEqual([
      "api did not become ready within 120000 ms",
      "listening… no\nError: EADDRINUSE",
    ]);
    const w2 = await world();
    expect((await w2.services.up({ profile: "backend" }))._unsafeUnwrap().map((s) => s.service)).toEqual([
      "db",
      "api",
    ]);
    expect((await w2.services.up({ services: ["docs"] }))._unsafeUnwrap().map((s) => s.service)).toEqual([
      "docs",
    ]);
    expect((await w2.services.up({ profile: "nope" }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect((await w2.services.up({ services: ["ghost"] }))._unsafeUnwrapErr().message).toBe(
      "unknown service(s): ghost",
    );
  });

  test("down stops the place's services; shared ones stay unless asked, since other worktrees use them", async () => {
    const w = await world();
    await w.services.up({ worktree: "feat" });
    expect((await w.services.down({ worktree: "feat" }))._unsafeUnwrap()).toEqual(["api"]);
    expect(
      (await w.services.status({ worktree: "feat" }))._unsafeUnwrap().map((s) => [s.service, s.status]),
    ).toEqual([
      ["db", "running"],
      ["api", "not running"],
      ["docs", "not running"],
    ]);
    expect((await w.services.down({ worktree: "feat", shared: true }))._unsafeUnwrap()).toEqual(["db"]);
    expect(w.containers.calls.at(-1)).toMatchObject({
      op: "stop",
      service: { project: "metator-repo-81f9fa-shared" },
    });
  });

  test("logs of a process and of a container; an unknown service or a stopped one", async () => {
    const w = await world();
    await w.services.up({});
    w.processes.logs.set("/tmp/metator-env-main-api.log", "a\nb\nc");
    expect((await w.services.logs({ service: "api", lines: 2 }))._unsafeUnwrap()).toBe("b\nc");
    expect((await w.services.logs({ service: "db", lines: 5 }))._unsafeUnwrap()).toBe("logs of db");
    expect((await w.services.logs({ service: "zz", lines: 5 }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect((await w.services.logs({ service: "docs", lines: 5 }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("no environment file is NOT_FOUND with the next step; an unknown worktree too", async () => {
    const fs = new InMemoryFileSystem();
    const s = new EnvironmentServices(
      new EnvironmentCatalog(fs, DEFAULT_PATHS),
      new WorktreeRegistry(fs, DEFAULT_PATHS),
      {
        processes: new FakeBackgroundProcess(),
        containers: new FakeContainerRuntime(),
        health: new FakeHealthProbe(),
        steps: new StepRunner(new FixedClock()),
        isolator: new FakeDataIsolator(),
        copier: new FakeTreeCopier(),
      },
      fs,
      new FixedClock(),
      DEFAULT_PATHS,
      { root: "/r", logDir: "/tmp" },
    );
    expect((await s.up({}))._unsafeUnwrapErr().hint).toContain("metator env discover");
    const w = await world();
    expect((await w.services.up({ worktree: "nope" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

describe("DiscoverEnvironment and InitEnvironment", () => {
  const discover = (files: Record<string, string>) =>
    new DiscoverEnvironment(
      new InMemoryFileSystem(files),
      { detect: async () => ok({ name: "pnpm", lockfiles: ["pnpm-lock.yaml"] }) },
      { packages: async () => ok([{ name: "@shop/web", dir: "apps/web" }]) },
    );

  test("reads compose files and start scripts of the workspace; a root that fans out is not a service", async () => {
    const d = discover({
      "compose.yml": "services:\n  db:\n    image: postgres:16\n",
      "package.json": JSON.stringify({ scripts: { dev: "pnpm -r dev" } }),
      "apps/web/package.json": JSON.stringify({ scripts: { dev: "vite --port 5173" } }),
    });
    const p = (await d.execute())._unsafeUnwrap();
    expect(Object.keys(p.environment?.services ?? {})).toEqual(["db", "web"]);
    expect(p.environment?.services.web?.source).toEqual({ script: "pnpm run dev", cwd: "apps/web" });
  });

  test("init writes a versioned file that reads back, and never overwrites", async () => {
    const fs = new InMemoryFileSystem({
      "compose.yml": "services:\n  db:\n    image: redis:7\n    ports: ['6379:6379']\n",
    });
    const d = new DiscoverEnvironment(
      fs,
      { detect: async () => ok(undefined) },
      { packages: async () => ok([]) },
    );
    const init = new InitEnvironment(d, fs, DEFAULT_PATHS);
    expect((await init.execute({ dryRun: false }))._unsafeUnwrap().written).toBe("metator/environment.yml");
    const text = (await fs.read("metator/environment.yml"))._unsafeUnwrap();
    const back = parseYamlDocument(text, "e").andThen((raw) => EnvironmentDocument.parse(raw, "e"));
    expect(back._unsafeUnwrap().services.db?.scope).toBe("shared");
    expect((await init.execute({ dryRun: false }))._unsafeUnwrapErr().code).toBe("USAGE");
    const empty = new InitEnvironment(
      new DiscoverEnvironment(
        new InMemoryFileSystem(),
        { detect: async () => ok(undefined) },
        { packages: async () => ok([]) },
      ),
      new InMemoryFileSystem(),
      DEFAULT_PATHS,
    );
    expect((await empty.execute({ dryRun: true }))._unsafeUnwrapErr().message).toBe(
      "nothing to start was found",
    );
  });
});
