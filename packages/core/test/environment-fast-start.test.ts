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
import { EnvironmentCatalog, EnvironmentServices } from "../src/application/environments.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { WorktreeRegistry } from "../src/application/worktrees.ts";
import {
  affectedServices,
  criticalPath,
  type Environment,
  EnvironmentDocument,
  lintEnvironment,
  placeData,
  serviceEnv,
} from "../src/domain/environment.ts";
import { buildProfile, EnvProfileDocument, type MeasuredStart } from "../src/domain/environment-profile.ts";
import type { ProcessResult, ResolvedCommand } from "../src/ports/index.ts";

const env = (services: Record<string, unknown>): Environment =>
  EnvironmentDocument.parse({ kind: "Environment", schemaVersion: 2, services }, "e")._unsafeUnwrap();

const SHOP = {
  db: {
    source: { script: "pg" },
    scope: "shared",
    ports: { pg: 5432 },
    health: { tcp: "pg" },
    init: [{ name: "seed", run: "seed.sh" }],
    isolate: { postgres: { template: "shop_seed", database: "shop" } },
  },
  cache: { source: { script: "redis" }, scope: "shared", ports: { r: 6379 }, isolate: { prefix: true } },
  api: {
    source: { script: "serve" },
    needs: ["db", "cache"],
    ports: { http: 3000 },
    paths: ["apps/api", "packages/shared"],
    prepare: [{ name: "install", run: "install.sh" }],
    init: [{ name: "migrate", run: "migrate.sh" }],
    warm: { reuse: ["node_modules"] },
    env: { DATABASE_URL: "postgres://127.0.0.1:{port:db.pg}/{db:db}", KEYS: "{prefix:cache}orders" },
  },
  web: { source: { script: "web" }, needs: ["api"], ports: { http: 5173 }, paths: ["apps/web"] },
  docs: { source: { script: "docs" }, scope: "on-demand", paths: ["docs"] },
};

describe("Environment v2", () => {
  test("a v1 file reads as v2 without paths, steps, isolation or reuse", () => {
    const v1 = EnvironmentDocument.parse(
      { kind: "Environment", schemaVersion: 1, services: { app: { source: { script: "x" } } } },
      "e",
    )._unsafeUnwrap();
    expect(v1.services.app).toMatchObject({ paths: [], prepare: [], init: [] });
    expect(v1.services.app?.isolate).toBeUndefined();
    expect(EnvironmentDocument.current).toBe(2);
  });

  test("lint: isolation only on shared, Postgres needs a port and two names, reuse not on shared, unique steps", () => {
    const problems = lintEnvironment(
      env({
        a: { source: { script: "x" }, isolate: { prefix: true } },
        b: {
          source: { script: "x" },
          scope: "shared",
          isolate: { postgres: { template: "t", database: "t" } },
        },
        c: { source: { script: "x" }, scope: "shared", warm: { reuse: ["node_modules"] } },
        d: {
          source: { script: "x" },
          prepare: [{ name: "go", run: "1" }],
          init: [{ name: "go", run: "2" }],
        },
        e: {
          source: { script: "x" },
          scope: "shared",
          ports: { pg: 1 },
          isolate: { postgres: { template: "t", database: "d", port: "nope" } },
        },
      }),
    );
    expect(problems.map((p) => `${p.service}: ${p.message}`)).toEqual([
      "a: only a shared service isolates data per worktree",
      "b: Postgres isolation needs a declared port to connect to",
      "b: the template and the checkout's database must differ",
      "c: a shared service runs once; it has nothing to reuse",
      "d: step names repeat: go",
      "e: Postgres isolation needs a declared port to connect to",
    ]);
    expect(lintEnvironment(env(SHOP))).toEqual([]);
  });

  test("database names are safe identifiers; a bad one is refused when the file is read", () => {
    const bad = EnvironmentDocument.parse(
      {
        kind: "Environment",
        schemaVersion: 2,
        services: {
          db: { source: { script: "x" }, isolate: { postgres: { template: "x; drop", database: "d" } } },
        },
      },
      "e",
    );
    expect(bad._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });

  test("each place has its data: the checkout its database, a worktree its clone and prefix", () => {
    const e = env(SHOP);
    const db = e.services.db as Environment["services"][string];
    const cache = e.services.cache as Environment["services"][string];
    expect([
      placeData(db, "main"),
      placeData(db, "fix-rounding"),
      placeData(cache, "main"),
      placeData(cache, "a-b"),
    ]).toEqual([
      { database: "shop" },
      { database: "wt_fix_rounding" },
      { prefix: "" },
      { prefix: "wt_a_b_" },
    ]);
    expect(placeData(db, "x".repeat(80)).database).toHaveLength(63);
    expect(placeData(e.services.web as never, "a")).toEqual({});
    const vars = serviceEnv(e, { db: { pg: 5432 }, api: { http: 41000 } }, "api", "feat");
    expect([vars.DATABASE_URL, vars.KEYS]).toEqual(["postgres://127.0.0.1:5432/wt_feat", "wt_feat_orders"]);
    expect(serviceEnv(e, { db: { pg: 5432 } }, "api").KEYS).toBe("orders");
  });

  test("affected services: paths that hold a changed file; without paths a worktree service always counts", () => {
    const e = env({ ...SHOP, all: { source: { script: "x" } } });
    expect(affectedServices(e, ["apps/web/main.ts"])).toEqual(["web", "all"]);
    expect(affectedServices(e, ["packages/shared/money.ts", "docs/a.md"])).toEqual(["api", "docs", "all"]);
    expect(affectedServices(e, ["apps/api"])).toEqual(["api", "all"]);
    expect(affectedServices(e, ["apps/apiary/x.ts"])).toEqual(["all"]);
    expect(affectedServices(e, [])).toEqual([]);
    expect(affectedServices(env({ a: { source: { script: "x" }, paths: ["./"] } }), ["z.ts"])).toEqual(["a"]);
  });

  test("the critical path is the slowest chain of needs", () => {
    const e = env(SHOP);
    expect(criticalPath(e, { db: 6000, cache: 100, api: 900, web: 300 })).toEqual(["db", "api", "web"]);
    expect(criticalPath(e, { db: 10, cache: 9000, api: 900 })).toEqual(["cache", "api"]);
    expect(criticalPath(e, {})).toEqual([]);
  });
});

const measured = (
  worktree: string,
  services: Record<string, { scope?: string; status?: string; phases?: [string, number][]; ms: number }>,
): MeasuredStart => ({
  worktree,
  ms: Object.values(services).reduce((n, s) => n + (s.status === "running" ? 0 : s.ms), 0),
  services: Object.fromEntries(
    Object.entries(services).map(([id, s]) => [
      id,
      {
        scope: (s.scope ?? "worktree") as "worktree",
        status: (s.status ?? "measured") as "measured",
        phases: (s.phases ?? []).map(([name, ms]) => ({ name, ms })),
        ms: s.ms,
      },
    ]),
  ),
});

describe("buildProfile", () => {
  test("speedup, critical path and evidence-backed recommendations, biggest gain first", () => {
    const e = env({
      db: { source: { script: "pg" }, scope: "shared", ports: { pg: 1 } },
      api: {
        source: { script: "a" },
        needs: ["db"],
        prepare: [{ name: "install", run: "i" }],
        init: [{ name: "seed", run: "s" }],
      },
      worker: { source: { script: "w" } },
      mailer: { source: { script: "m" } },
    });
    const cold = measured("analyze-cold", {
      db: { scope: "shared", ms: 3000, phases: [["start", 3000]] },
      api: {
        ms: 9000,
        phases: [
          ["install", 4000],
          ["start", 1000],
          ["seed", 4000],
        ],
      },
      worker: { ms: 1500 },
      mailer: { ms: 700 },
    });
    const warm = measured("analyze-warm", {
      db: { scope: "shared", status: "running", ms: 0 },
      api: {
        ms: 9000,
        phases: [
          ["install", 4000],
          ["start", 1000],
          ["seed", 4000],
        ],
      },
      worker: { ms: 1500 },
      mailer: { ms: 700 },
    });
    const p = buildProfile(e, cold, warm, new Date("2026-10-27T10:00:00.000Z"));
    expect([p.speedup, p.sharedWarm, p.criticalPath]).toEqual([1.3, false, ["db", "api"]]);
    expect(p.recommendations.map((r) => [r.id, r.service, r.gainMs])).toEqual([
      ["warm-pool", undefined, 11200],
      ["reuse-build", "api", 4000],
      ["template-database", "api", 4000],
      ["partial-start", undefined, 2200],
    ]);
    expect(p.recommendations[2]?.evidence).toBe(
      "api: seed took 4.0 s in every new worktree; cloning a template takes seconds",
    );
    expect(EnvProfileDocument.parse(EnvProfileDocument.stamp(p), "p").isOk()).toBe(true);
  });

  test("nothing slow, nothing to recommend; already running shared services ask for a cold measurement", () => {
    const e = env({
      db: { source: { script: "pg" }, scope: "shared" },
      api: { source: { script: "a" }, needs: ["db"] },
    });
    const fast = measured("w", { db: { scope: "shared", ms: 100 }, api: { ms: 200 } });
    expect(buildProfile(e, fast, fast, new Date()).recommendations).toEqual([]);
    const cold = measured("c", { db: { scope: "shared", status: "running", ms: 0 }, api: { ms: 200 } });
    const p = buildProfile(e, cold, measured("w", { api: { ms: 0 } }), new Date());
    expect([p.sharedWarm, p.speedup, p.recommendations.map((r) => [r.id, r.apply])]).toEqual([
      true,
      0,
      [["cold-measure", "metator env analyze --cold"]],
    ]);
  });

  test("reuse is not recommended where it is set; a slow step under the limit counts for nothing", () => {
    const e = env({
      api: {
        source: { script: "a" },
        prepare: [{ name: "install", run: "i" }],
        warm: { reuse: ["node_modules"] },
      },
      web: { source: { script: "w" }, prepare: [{ name: "build", run: "b" }] },
    });
    const m = measured("w", {
      api: { ms: 5000, phases: [["install", 5000]] },
      web: { ms: 999, phases: [["build", 999]] },
    });
    expect(buildProfile(e, m, m, new Date()).recommendations).toEqual([]);
  });
});

/** Steps take the time `slow` gives them on the clock; scripts in `failing` exit 1. */
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
    return { exitCode, stdout: "", stderr: exitCode ? "relation missing\n" : "", durationMs: 0 };
  }
}

const YAML = `kind: Environment
schemaVersion: 2
services:
  db:
    source: { script: pg }
    scope: shared
    ports: { pg: 5432 }
    init: [{ name: seed, run: seed.sh }]
    isolate: { postgres: { template: shop_seed, database: shop } }
  api:
    source: { script: serve }
    needs: [db]
    ports: { http: 3000 }
    paths: [apps/api]
    prepare: [{ name: install, run: install.sh }]
    init: [{ name: migrate, run: migrate.sh }]
    warm: { reuse: [node_modules, apps/api/dist] }
    env: { DATABASE_URL: "postgres://127.0.0.1:{port:db.pg}/{db:db}" }
  web:
    source: { script: web }
    needs: [api]
    paths: [apps/web]
`;

async function world(
  opts: {
    files?: Record<string, string>;
    dirs?: string[];
    slow?: Record<string, number>;
    failing?: string[];
  } = {},
) {
  const fs = new InMemoryFileSystem({
    "metator/environment.yml": YAML,
    "bun.lock": "lock-1",
    ".metator/wt/feat/bun.lock": "lock-1",
    ...opts.files,
  });
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
  const tools = {
    processes: new FakeBackgroundProcess(),
    containers: new FakeContainerRuntime(),
    health: new FakeHealthProbe(),
    steps: new StepRunner(clock, opts.slow, new Set(opts.failing)),
    isolator: new FakeDataIsolator(),
    copier: new FakeTreeCopier(new Set(["/repo/node_modules", ...(opts.dirs ?? [])])),
  };
  const services = new EnvironmentServices(
    new EnvironmentCatalog(fs, DEFAULT_PATHS),
    registry,
    tools,
    fs,
    clock,
    DEFAULT_PATHS,
    { root: "/repo", logDir: "/tmp" },
  );
  return { fs, clock, services, ...tools };
}

describe("EnvironmentServices: fast start (F8.7)", () => {
  test("every phase is timed; the shared db seeds its template once; the worktree gets its clone", async () => {
    const w = await world({ slow: { "seed.sh": 6000, "install.sh": 2000, "migrate.sh": 300 } });
    const r = (await w.services.up({ worktree: "feat" }))._unsafeUnwrap();
    expect(r.map((s) => [s.service, s.phases?.map((p) => `${p.name} ${p.ms}`)])).toEqual([
      ["db", ["start 0", "template 0", "seed 6000"]],
      ["api", ["isolate 0", "reuse 0", "install 2000", "start 0", "migrate 300"]],
      ["web", ["start 0"]],
    ]);
    expect(r.map((s) => s.ms)).toEqual([6000, 2300, 0]);
    expect(w.isolator.calls).toEqual(["create shop_seed", "create wt_feat from shop_seed"]);
    const seed = w.steps.calls.find((c) => c.argv[2] === "seed.sh");
    expect([seed?.cwd, seed?.env?.METATOR_DATABASE]).toEqual(["/repo", "shop_seed"]);
    const migrate = w.steps.calls.find((c) => c.argv[2] === "migrate.sh");
    expect([migrate?.cwd, migrate?.env?.DATABASE_URL, migrate?.env?.METATOR_DATABASE]).toEqual([
      "/repo/.metator/wt/feat",
      "postgres://127.0.0.1:5432/wt_feat",
      undefined,
    ]);
    // A second start in the same place reuses everything and seeds nothing.
    const again = (await w.services.up({ worktree: "feat" }))._unsafeUnwrap();
    expect(again.map((s) => s.status)).toEqual(["running", "running", "running"]);
    expect(w.steps.calls.filter((c) => c.argv[2] === "seed.sh")).toHaveLength(1);
  });

  test("the checkout uses its own database, cloned from the template too", async () => {
    const w = await world();
    await w.services.up({ services: ["api"] });
    expect(w.isolator.calls).toEqual(["create shop_seed", "create shop from shop_seed"]);
    expect(w.copier.copies).toEqual([]); // nothing to reuse into the checkout itself
  });

  test("build reuse: copied from the checkout when the lockfiles match, never over what is there", async () => {
    const w = await world({ dirs: ["/repo/apps/api/dist"] });
    await w.services.up({ worktree: "feat", services: ["api"] });
    expect(w.copier.copies).toEqual([
      { from: "/repo/node_modules", to: "/repo/.metator/wt/feat/node_modules" },
      { from: "/repo/apps/api/dist", to: "/repo/.metator/wt/feat/apps/api/dist" },
    ]);
    const changed = await world({ files: { ".metator/wt/feat/bun.lock": "lock-2" } });
    await changed.services.up({ worktree: "feat", services: ["api"] });
    expect(changed.copier.copies).toEqual([]);
    const present = await world({ dirs: ["/repo/.metator/wt/feat/node_modules"] });
    await present.services.up({ worktree: "feat", services: ["api"] });
    expect(present.copier.copies).toEqual([]);
  });

  test("a failing step stops the start with its output; what started before is reported", async () => {
    const w = await world({ failing: ["migrate.sh"] });
    const e = (await w.services.up({ worktree: "feat" }))._unsafeUnwrapErr();
    expect([e.code, e.message, e.hint]).toEqual([
      "COMMAND_FAILED",
      "api: step migrate exited with 1",
      "Run it yourself: migrate.sh",
    ]);
    const details = e.details as { output: string; started: { service: string }[] };
    expect([details.output.trim(), details.started.map((s) => s.service)]).toEqual([
      "relation missing",
      ["db"],
    ]);
    const install = await world({ failing: ["install.sh"] });
    expect((await install.services.up({ worktree: "feat" }))._unsafeUnwrapErr().message).toBe(
      "api: step install exited with 1",
    );
    const seed = await world({ failing: ["seed.sh"] });
    expect((await seed.services.up({ worktree: "feat" }))._unsafeUnwrapErr().message).toBe(
      "db: step seed exited with 1",
    );
  });

  test("--affected starts only what a change touches and what that needs; no change starts nothing", async () => {
    const w = await world();
    const r = (
      await w.services.up({ worktree: "feat", affected: ["apps/api/src/order.ts"] })
    )._unsafeUnwrap();
    expect(r.map((s) => s.service)).toEqual(["db", "api"]);
    const none = await world();
    expect((await none.services.up({ worktree: "feat", affected: ["README.md"] }))._unsafeUnwrap()).toEqual(
      [],
    );
    expect(none.processes.started).toEqual([]);
  });

  test("dropData drops the worktree's databases while the shared Postgres runs; nothing otherwise", async () => {
    const w = await world();
    expect((await w.services.dropData({ worktree: "feat" }))._unsafeUnwrap()).toEqual([]);
    await w.services.up({ worktree: "feat" });
    expect((await w.services.dropData({ worktree: "feat" }))._unsafeUnwrap()).toEqual(["wt_feat"]);
    expect((await w.services.dropData({ worktree: "feat" }))._unsafeUnwrap()).toEqual([]);
    expect(w.isolator.server({ host: "", port: 5432, user: "" }).has("shop_seed")).toBe(true);
  });

  test("an isolation error stops the start", async () => {
    const w = await world();
    w.isolator.server({ host: "", port: 5432, user: "" }).set("shop_seed", []);
    // The template exists, but the clone fails: the fake refuses a template it does not know.
    const broken = new FakeDataIsolator();
    broken.createDatabase = async () =>
      (await import("../src/domain/result.ts")).err(
        new (await import("../src/domain/errors.ts")).MetatorError("COMMAND_FAILED", "too many connections"),
      );
    const s = new EnvironmentServices(
      new EnvironmentCatalog(w.fs, DEFAULT_PATHS),
      new WorktreeRegistry(w.fs, DEFAULT_PATHS),
      { ...w, isolator: broken },
      w.fs,
      w.clock,
      DEFAULT_PATHS,
      { root: "/repo", logDir: "/tmp" },
    );
    expect((await s.up({ worktree: "feat" }))._unsafeUnwrapErr().message).toBe("too many connections");
  });
});
