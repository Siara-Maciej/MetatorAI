import { describe, expect, test } from "bun:test";
import {
  FakeBackgroundProcess,
  FakeContainerRuntime,
  FakeDataIsolator,
  FakeHealthProbe,
  FakePortProbe,
  FakeTreeCopier,
  FakeWorktreeManager,
  FixedClock,
  InMemoryFileSystem,
} from "@metator/testing";
import { AnalyzeEnvironment } from "../src/application/environment-analysis.ts";
import { EnvironmentCatalog, EnvironmentServices } from "../src/application/environments.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { WarmPool } from "../src/application/pool.ts";
import {
  CreateWorktree,
  ProvideWorktree,
  RemoveWorktree,
  WorktreeRegistry,
} from "../src/application/worktrees.ts";
import { EnvProfileDocument } from "../src/domain/environment-profile.ts";
import type { ProcessResult, ResolvedCommand } from "../src/ports/index.ts";

const YAML = `kind: Environment
schemaVersion: 2
services:
  db:
    source: { script: pg }
    scope: shared
    ports: { pg: 5432 }
    health: { tcp: pg }
    init: [{ name: seed, run: seed.sh }]
    isolate: { postgres: { template: shop_seed, database: shop } }
  api:
    source: { script: serve }
    needs: [db]
    ports: { http: 3000 }
    prepare: [{ name: install, run: install.sh }]
`;

class StepRunner {
  constructor(
    private readonly clock: FixedClock,
    private readonly slow: Readonly<Record<string, number>>,
  ) {}
  async run(command: ResolvedCommand): Promise<ProcessResult> {
    this.clock.advance(this.slow[command.argv[2] ?? ""] ?? 0);
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  }
}

function world(slow: Record<string, number> = { "seed.sh": 6000, "install.sh": 400 }) {
  const fs = new InMemoryFileSystem({ "metator/environment.yml": YAML });
  const clock = new FixedClock(new Date("2026-10-27T10:00:00.000Z"));
  const registry = new WorktreeRegistry(fs, DEFAULT_PATHS);
  const git = new FakeWorktreeManager();
  const create = new CreateWorktree(registry, git, new FakePortProbe(), clock, DEFAULT_PATHS);
  const remove = new RemoveWorktree(registry, git);
  const processes = new FakeBackgroundProcess();
  const isolator = new FakeDataIsolator();
  const catalog = new EnvironmentCatalog(fs, DEFAULT_PATHS);
  const services = new EnvironmentServices(
    catalog,
    registry,
    {
      processes,
      containers: new FakeContainerRuntime(),
      health: new FakeHealthProbe(),
      steps: new StepRunner(clock, slow),
      isolator,
      copier: new FakeTreeCopier(),
    },
    fs,
    clock,
    DEFAULT_PATHS,
    { root: "/repo", logDir: "/tmp" },
  );
  const pool = new WarmPool(registry, create, remove, services);
  const provide = new ProvideWorktree(registry, git, create);
  const analyze = new AnalyzeEnvironment(
    catalog,
    registry,
    create,
    remove,
    services,
    fs,
    clock,
    DEFAULT_PATHS,
  );
  return { fs, registry, git, processes, isolator, services, pool, provide, analyze };
}

describe("warm pool", () => {
  test("fill starts free worktrees up to the size; a run takes one on its own branch; fill tops up", async () => {
    const w = world();
    const filled = (await w.pool.fill(2))._unsafeUnwrap();
    expect([filled.free.map((e) => e.id), filled.started.map((s) => s.id)]).toEqual([
      ["pool-1", "pool-2"],
      ["pool-1", "pool-2"],
    ]);
    expect(filled.started[0]?.services.map((s) => s.service)).toEqual(["db", "api"]);
    expect(filled.started[1]?.services.map((s) => [s.service, s.status])).toEqual([
      ["db", "running"],
      ["api", "started"],
    ]);
    const taken = (await w.provide.execute({ id: "run-1", run: "run-1", base: "main" }))._unsafeUnwrap();
    expect([taken.id, taken.branch, taken.base, taken.run]).toEqual([
      "pool-1",
      "metator/run-1",
      "main",
      "run-1",
    ]);
    expect(w.git.worktrees.get(".metator/wt/pool-1")).toEqual({ branch: "metator/run-1", base: "main" });
    const topped = (await w.pool.fill(2))._unsafeUnwrap();
    expect([topped.free.map((e) => e.id), topped.taken.map((e) => [e.id, e.run])]).toEqual([
      ["pool-2", "pool-3"],
      [["pool-1", "run-1"]],
    ]);
    expect((await w.pool.fill(1))._unsafeUnwrap().started).toEqual([]);
  });

  test("without a free one, or for a worktree without a run, a new worktree is created", async () => {
    const w = world();
    const own = (await w.provide.execute({ id: "run-1", run: "run-1" }))._unsafeUnwrap();
    expect([own.id, own.branch]).toEqual(["run-1", "metator/run-1"]);
    await w.pool.fill(1);
    const plain = (await w.provide.execute({ id: "manual" }))._unsafeUnwrap();
    expect(plain.id).toBe("manual");
  });

  test("drain stops, drops and removes only the free worktrees", async () => {
    const w = world();
    await w.pool.fill(2);
    await w.provide.execute({ id: "run-1", run: "run-1" });
    const drained = (await w.pool.drain())._unsafeUnwrap();
    expect([drained.removed, drained.free, drained.taken.map((e) => e.id)]).toEqual([
      ["pool-2"],
      [],
      ["pool-1"],
    ]);
    expect(w.isolator.calls).toContain("drop wt_pool_2");
    expect([...w.git.worktrees.keys()]).toEqual([".metator/wt/pool-1"]);
    expect((await w.pool.list())._unsafeUnwrap().taken.map((e) => e.id)).toEqual(["pool-1"]);
  });
});

describe("env analyze", () => {
  test("measures a cold and a warm start, writes the profile and cleans up after itself", async () => {
    const w = world();
    const p = (await w.analyze.execute({ cold: false }))._unsafeUnwrap();
    expect([p.cold.ms, p.warm.ms, p.speedup, p.sharedWarm]).toEqual([6400, 400, 16, false]);
    expect(p.cold.services.db?.phases.map((x) => x.name)).toEqual(["start", "template", "seed"]);
    expect(p.warm.services.db?.status).toBe("running");
    expect(p.criticalPath).toEqual(["db", "api"]);
    const saved = EnvProfileDocument.parse(
      JSON.parse((await w.fs.read(DEFAULT_PATHS.envProfile))._unsafeUnwrap()),
      "p",
    );
    expect(saved._unsafeUnwrap().speedup).toBe(16);
    // Both worktrees and their databases are gone; the shared db it started is stopped again.
    expect((await w.registry.all())._unsafeUnwrap()).toEqual([]);
    expect(w.isolator.calls.filter((c) => c.startsWith("drop"))).toEqual([
      "drop wt_analyze_cold",
      "drop wt_analyze_warm",
    ]);
    expect(w.processes.alive.size).toBe(0);
  });

  test("shared services that ran before keep running and are reported; --cold restarts them first", async () => {
    const w = world();
    await w.services.up({ services: ["db"] });
    const warm = (await w.analyze.execute({ cold: false }))._unsafeUnwrap();
    expect([warm.sharedWarm, warm.recommendations.map((r) => r.id)]).toEqual([true, ["cold-measure"]]);
    expect(w.processes.alive.size).toBe(1);
    const cold = (await w.analyze.execute({ cold: true }))._unsafeUnwrap();
    expect([cold.sharedWarm, cold.cold.services.db?.status, w.processes.alive.size]).toEqual([
      false,
      "measured",
      1,
    ]);
  });

  test("leftovers of an interrupted analysis are removed first; a failing start still cleans up", async () => {
    const w = world();
    await new CreateWorktree(w.registry, w.git, new FakePortProbe(), new FixedClock(), DEFAULT_PATHS).execute(
      {
        id: "analyze-cold",
      },
    );
    expect((await w.analyze.execute({ cold: false })).isOk()).toBe(true);
    const broken = world();
    await broken.fs.write(
      "metator/environment.yml",
      YAML.replace("source: { script: serve }", "source: { script: serve }\n    health: { tcp: 1 }"),
    );
    const failing = new AnalyzeEnvironment(
      new EnvironmentCatalog(broken.fs, DEFAULT_PATHS),
      broken.registry,
      {
        execute: async () =>
          (await import("../src/domain/result.ts")).err(
            new (await import("../src/domain/errors.ts")).MetatorError(
              "NOT_FOUND",
              "no free block of 20 ports",
            ),
          ),
      },
      new RemoveWorktree(broken.registry, broken.git),
      broken.services,
      broken.fs,
      new FixedClock(),
      DEFAULT_PATHS,
    );
    expect((await failing.execute({ cold: false }))._unsafeUnwrapErr().message).toBe(
      "no free block of 20 ports",
    );
    expect((await broken.registry.all())._unsafeUnwrap()).toEqual([]);
  });
});
