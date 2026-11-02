import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  err,
  MetatorError,
  ok,
  RunRepository,
  SetupWorktree,
  WorktreeRegistry,
} from "@metator/core";
import { FakeTreeCopier, InMemoryFileSystem, ScriptedProcessRunner } from "@metator/testing";

const ROOT = "/repo";
const WT = ".metator/wt/20261102-mt-feature-a";

function world(opts: {
  files?: Record<string, string>;
  dirs?: string[];
  workspaces?: string[];
  install?: { exitCode: number; stderr?: string };
  envUp?: "none" | "ok" | "fails";
}) {
  const fs = new InMemoryFileSystem(opts.files ?? {});
  const dirs = new Set((opts.dirs ?? []).map((d) => `${ROOT}/${d}`));
  const copier = new FakeTreeCopier(dirs);
  const runner = new ScriptedProcessRunner(
    opts.install
      ? [{ argvPrefix: ["bun"], result: opts.install }]
      : [{ argvPrefix: ["bun"], result: { exitCode: 0 } }],
  );
  const registry = new WorktreeRegistry(fs, DEFAULT_PATHS);
  const runs = new RunRepository(fs, DEFAULT_PATHS);
  const ups: unknown[] = [];
  const setup = new SetupWorktree(
    fs,
    registry,
    runs,
    { installCommand: async (cwd) => ok({ argv: ["bun", "install", "--frozen-lockfile"], cwd }) },
    runner,
    copier,
    {
      up: async (input) => {
        ups.push(input);
        if (opts.envUp === "fails") return err(new MetatorError("COMMAND_FAILED", "api never got ready"));
        if (opts.envUp === "ok")
          return ok([
            { service: "api", scope: "worktree", place: "a", status: "started" as const, ports: {} },
          ]);
        return err(MetatorError.notFound("environment"));
      },
    },
    {
      root: ROOT,
      isDirectory: async (p) => dirs.has(`${ROOT}/${p}`),
      workspaces: async () => opts.workspaces ?? [],
      now: () => 1000,
    },
  );
  return { fs, copier, runner, registry, runs, setup, ups };
}

const entry = {
  id: "20261102-mt-feature-a",
  path: WT,
  branch: "metator/20261102-mt-feature-a",
  base: "HEAD",
  run: "20261102-mt-feature-a",
  ports: { from: 41000, count: 20 },
  createdAt: "2026-11-02T10:00:00.000Z",
};

describe("SetupWorktree", () => {
  test("the main checkout's node_modules are copied when every lockfile is the same, workspaces included", async () => {
    const w = world({
      files: {
        "package.json": "{}",
        "bun.lock": "L",
        [`${WT}/package.json`]: "{}",
        [`${WT}/bun.lock`]: "L",
      },
      dirs: ["node_modules", "packages/core/node_modules"],
      workspaces: ["packages/core", "packages/cli"],
    });
    await w.registry.save([entry]);
    const r = (await w.setup.execute({ worktree: entry.id }))._unsafeUnwrap();
    expect(r).toEqual({
      worktree: entry.id,
      path: WT,
      dependencies: "reused",
      detail: "node_modules, packages/core/node_modules",
      ms: 0,
    });
    expect(w.copier.copies.map((c) => c.to)).toEqual([
      `${ROOT}/${WT}/node_modules`,
      `${ROOT}/${WT}/packages/core/node_modules`,
    ]);
    expect(w.runner.calls).toEqual([]);
  });

  test("a different lockfile, or no node_modules to copy, means an install in the worktree", async () => {
    const changed = world({
      files: {
        "package.json": "{}",
        "bun.lock": "L",
        [`${WT}/package.json`]: "{}",
        [`${WT}/bun.lock`]: "L2",
      },
      dirs: ["node_modules"],
    });
    await changed.registry.save([entry]);
    const r = (await changed.setup.execute({ worktree: entry.id }))._unsafeUnwrap();
    expect([r.dependencies, r.detail]).toEqual(["installed", "bun install --frozen-lockfile"]);
    expect(changed.runner.calls[0]?.cwd).toBe(`${ROOT}/${WT}`);
    expect(changed.copier.copies).toEqual([]);

    const cold = world({ files: { "package.json": "{}", [`${WT}/package.json`]: "{}" } });
    await cold.registry.save([entry]);
    expect((await cold.setup.execute({ worktree: entry.id }))._unsafeUnwrap().dependencies).toBe("installed");
  });

  test("a failed install says the command and where; nothing to do without package.json or with node_modules", async () => {
    const failing = world({
      files: { "package.json": "{}", [`${WT}/package.json`]: "{}" },
      install: { exitCode: 1, stderr: "registry down" },
    });
    await failing.registry.save([entry]);
    const e = (await failing.setup.execute({ worktree: entry.id }))._unsafeUnwrapErr();
    expect(e.message).toBe(`bun install --frozen-lockfile exited with 1 in ${WT}`);
    expect((e.details as { output: string }).output).toContain("registry down");

    const plain = world({ files: { "README.md": "" } });
    await plain.registry.save([entry]);
    expect((await plain.setup.execute({ worktree: entry.id }))._unsafeUnwrap().dependencies).toBe("none");
    const present = world({ files: { [`${WT}/package.json`]: "{}" }, dirs: [`${WT}/node_modules`] });
    await present.registry.save([entry]);
    expect((await present.setup.execute({ worktree: entry.id }))._unsafeUnwrap().dependencies).toBe(
      "present",
    );
  });

  test("the run names the worktree; a run in the checkout has nothing to set up; --up starts the services", async () => {
    const w = world({ files: { "README.md": "" }, envUp: "ok" });
    await w.registry.save([entry]);
    await w.runs.save({
      runId: entry.id,
      workflow: { id: "mt-feature", revision: 1, source: "x" },
      task: "a",
      autonomy: "L0",
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T10:00:00.000Z",
      state: {
        workflow: "mt-feature",
        stage: "intake",
        status: "active",
        context: { loops: {}, history: [] },
      },
      approvals: {},
      worktree: { id: entry.id, path: WT, branch: entry.branch },
    } as never);
    const r = (await w.setup.execute({ run: entry.id, up: true }))._unsafeUnwrap();
    expect([r.worktree, r.services?.map((s) => s.status)]).toEqual([entry.id, ["started"]]);
    expect(w.ups).toEqual([{ services: [], worktree: entry.id }]);

    await w.runs.save({
      runId: "20261102-mt-feature-b",
      workflow: { id: "mt-feature", revision: 1, source: "x" },
      task: "b",
      autonomy: "L0",
      createdAt: "2026-11-02T11:00:00.000Z",
      updatedAt: "2026-11-02T11:00:00.000Z",
      state: {
        workflow: "mt-feature",
        stage: "intake",
        status: "active",
        context: { loops: {}, history: [] },
      },
      approvals: {},
    } as never);
    const e = (await w.setup.execute({ run: "20261102-mt-feature-b" }))._unsafeUnwrapErr();
    expect(e.message).toContain("works in your checkout, not in a worktree");
  });

  test("without an environment file --up starts nothing and is no failure; a start that fails is", async () => {
    const none = world({ files: { "README.md": "" }, envUp: "none" });
    await none.registry.save([entry]);
    expect(
      (await none.setup.execute({ worktree: entry.id, up: true }))._unsafeUnwrap().services,
    ).toBeUndefined();
    const bad = world({ files: { "README.md": "" }, envUp: "fails" });
    await bad.registry.save([entry]);
    expect((await bad.setup.execute({ worktree: entry.id, up: true }))._unsafeUnwrapErr().message).toBe(
      "api never got ready",
    );
  });
});
