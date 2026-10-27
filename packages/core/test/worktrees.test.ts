import { describe, expect, test } from "bun:test";
import { FakePortProbe, FakeWorktreeManager, FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import {
  CreateWorktree,
  ListWorktrees,
  PruneWorktrees,
  RemoveWorktree,
  WorktreeRegistry,
} from "../src/application/worktrees.ts";
import { RunRecordDocument } from "../src/domain/run-record.ts";
import {
  candidateBlocks,
  portVariables,
  pruneCandidates,
  type WorktreeEntry,
} from "../src/domain/worktree.ts";

const entry = (id: string, over: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  id,
  path: `.metator/wt/${id}`,
  branch: `metator/${id}`,
  base: "HEAD",
  ports: { from: 41000, count: 20 },
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("worktree domain", () => {
  test("candidate blocks skip leased ones, in order, aligned to the block size", () => {
    const blocks = [
      ...candidateBlocks(
        [
          { from: 41000, count: 20 },
          { from: 41045, count: 5 },
        ],
        20,
      ),
    ].slice(0, 3);
    expect(blocks).toEqual([
      { from: 41020, count: 20 },
      { from: 41060, count: 20 },
      { from: 41080, count: 20 },
    ]);
  });

  test("a range ends: no block crosses its upper bound", () => {
    expect([...candidateBlocks([], 20, { from: 41000, to: 41039 })]).toEqual([
      { from: 41000, count: 20 },
      { from: 41020, count: 20 },
    ]);
    expect([...candidateBlocks([], 20, { from: 41000, to: 41018 })]).toEqual([]);
  });

  test("the port variables name the worktree and its block", () => {
    expect(portVariables(entry("a", { ports: { from: 42000, count: 10 } }))).toEqual({
      METATOR_WORKTREE: "a",
      METATOR_PORT_BASE: "42000",
      METATOR_PORT_COUNT: "10",
    });
  });

  test("prune takes worktrees of finished or vanished runs that are old enough", () => {
    const now = new Date("2026-10-10T00:00:00.000Z");
    const found = pruneCandidates({
      entries: [
        entry("done-old", { run: "r1" }),
        entry("active-old", { run: "r2" }),
        entry("gone-old", { run: "r3" }),
        entry("done-new", { run: "r4", createdAt: "2026-10-09T00:00:00.000Z" }),
        entry("no-run"),
      ],
      runStatus: new Map([
        ["r1", "done"],
        ["r2", "active"],
        ["r4", "done"],
      ]),
      now,
      olderThanDays: 7,
    });
    expect(found.map((e) => e.id)).toEqual(["done-old", "gone-old"]);
  });
});

function world(busy: number[] = []) {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/mt-tiny.yml":
      "kind: Workflow\nschemaVersion: 1\nid: mt-tiny\nstages:\n  - id: build\n",
  });
  const git = new FakeWorktreeManager();
  const clock = new FixedClock(new Date("2026-10-27T10:00:00.000Z"));
  const registry = new WorktreeRegistry(fs, DEFAULT_PATHS);
  const runs = new RunRepository(fs, DEFAULT_PATHS);
  const create = new CreateWorktree(registry, git, new FakePortProbe(new Set(busy)), clock, DEFAULT_PATHS);
  const remove = new RemoveWorktree(registry, git);
  return { fs, git, clock, registry, runs, create, remove };
}

describe("worktree use cases", () => {
  test("new: a branch from the base, a free block of ports and its variables", async () => {
    const w = world([41000]); // one busy port spoils the whole first block
    const e = (await w.create.execute({ id: "feat-a", base: "main" }))._unsafeUnwrap();
    expect([e.path, e.branch, e.base, e.ports]).toEqual([
      ".metator/wt/feat-a",
      "metator/feat-a",
      "main",
      { from: 41020, count: 20 },
    ]);
    expect(w.git.worktrees.get(".metator/wt/feat-a")).toEqual({ branch: "metator/feat-a", base: "main" });
    const second = (await w.create.execute({ id: "feat-b", ports: 5 }))._unsafeUnwrap();
    // Blocks align to their size: 41000-41004 holds the busy port, 41005-41009 is free.
    expect(second.ports).toEqual({ from: 41005, count: 5 });
  });

  test("new refuses a taken or invalid id and writes nothing", async () => {
    const w = world();
    await w.create.execute({ id: "a" });
    expect((await w.create.execute({ id: "a" }))._unsafeUnwrapErr().message).toBe(
      "worktree a already exists",
    );
    expect((await w.create.execute({ id: "Bad Id" }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect(w.git.worktrees.size).toBe(1);
  });

  test("no free block is an error with a hint, not a throw", async () => {
    const busy = Array.from({ length: 8000 }, (_, i) => 41000 + i);
    const r = await world(busy).create.execute({ id: "a" });
    expect(r._unsafeUnwrapErr().hint).toContain("worktree prune");
  });

  test("rm frees the ports; uncommitted work needs force", async () => {
    const w = world();
    await w.create.execute({ id: "a" });
    w.git.dirty.add(".metator/wt/a");
    expect((await w.remove.execute({ id: "a", force: false }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect((await w.remove.execute({ id: "a", force: true })).isOk()).toBe(true);
    expect((await w.registry.all())._unsafeUnwrap()).toEqual([]);
    expect((await w.create.execute({ id: "b" }))._unsafeUnwrap().ports.from).toBe(41000);
    expect((await w.remove.execute({ id: "zzz", force: false }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("run init --worktree: the run works in its own worktree; list shows the run's status", async () => {
    const w = world();
    const catalog = new WorkflowCatalog(w.fs, DEFAULT_PATHS);
    const run = (
      await new InitRun(catalog, w.runs, w.clock, w.create).execute({
        workflow: "mt-tiny",
        task: "Add discount",
        worktree: { base: "main" },
      })
    )._unsafeUnwrap();
    expect(run.worktree).toEqual({
      id: run.runId,
      path: `.metator/wt/${run.runId}`,
      branch: `metator/${run.runId}`,
    });
    expect((await w.runs.load(run.runId))._unsafeUnwrap().worktree?.id).toBe(run.runId);
    const list = (await new ListWorktrees(w.registry, w.git, w.runs).execute())._unsafeUnwrap();
    expect(list.map((e) => [e.id, e.run, e.runStatus, e.dirty])).toEqual([
      [run.runId, run.runId, "active", false],
    ]);
  });

  test("prune removes clean worktrees of finished runs and keeps dirty ones", async () => {
    const w = world();
    await w.create.execute({ id: "clean", run: "20261001-mt-tiny-a" });
    await w.create.execute({ id: "dirty", run: "20261001-mt-tiny-b" });
    w.git.dirty.add(".metator/wt/dirty");
    const later = new FixedClock(new Date("2026-11-30T00:00:00.000Z"));
    const prune = (dryRun: boolean) =>
      new PruneWorktrees(w.registry, w.remove, w.git, w.runs, later).execute({ olderThanDays: 7, dryRun });
    expect((await prune(true))._unsafeUnwrap()).toEqual({ removed: ["clean"], keptDirty: ["dirty"] });
    expect((await w.registry.all())._unsafeUnwrap().length).toBe(2);
    await prune(false);
    expect((await w.registry.all())._unsafeUnwrap().map((e) => e.id)).toEqual(["dirty"]);
  });
});

describe("RunRecord v3", () => {
  test("a v2 record reads as v3 unchanged; v1 still migrates through v2", () => {
    const base = {
      runId: "20261001-mt-tiny-a",
      workflow: { id: "mt-tiny", revision: 1, source: "x.yml" },
      task: "t",
      autonomy: "L0",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      state: {
        workflow: "mt-tiny",
        stage: "build",
        status: "active",
        context: { loops: {}, history: [{ stage: "plan", event: "APPROVE", detail: "alice" }] },
      },
    };
    const v2 = RunRecordDocument.parse({ kind: "RunRecord", schemaVersion: 2, ...base, approvals: {} }, "s");
    expect([v2._unsafeUnwrap().worktree, RunRecordDocument.current]).toEqual([undefined, 3]);
    const v1 = RunRecordDocument.parse({ kind: "RunRecord", schemaVersion: 1, ...base }, "s")._unsafeUnwrap();
    expect(v1.approvals.plan?.by).toBe("alice");
  });
});
