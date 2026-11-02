import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  err,
  MetatorError,
  ok,
  RunRepository,
  type SendMessageInput,
  WorktreeConflicts,
  WorktreeRegistry,
} from "@metator/core";
import { InMemoryFileSystem } from "@metator/testing";

const record = (id: string, createdAt: string, worktree?: string, status = "active") =>
  ({
    runId: id,
    workflow: { id: "mt-feature", revision: 1, source: "x" },
    task: id,
    autonomy: "L0",
    createdAt,
    updatedAt: createdAt,
    state: { workflow: "mt-feature", stage: "build", status, context: { loops: {}, history: [] } },
    approvals: {},
    ...(worktree
      ? { worktree: { id: worktree, path: `.metator/wt/${worktree}`, branch: `metator/${worktree}` } }
      : {}),
  }) as never;
const entry = (id: string) => ({
  id,
  path: `.metator/wt/${id}`,
  branch: `metator/${id}`,
  base: "HEAD",
  run: id,
  ports: { from: 41000, count: 20 },
  createdAt: "2026-11-02T10:00:00.000Z",
});

async function world(changed: Record<string, readonly string[]>) {
  const fs = new InMemoryFileSystem();
  const runs = new RunRepository(fs, DEFAULT_PATHS);
  const registry = new WorktreeRegistry(fs, DEFAULT_PATHS);
  await runs.save(record("20261102-mt-feature-b", "2026-11-02T11:00:00.000Z", "20261102-mt-feature-b"));
  await runs.save(record("20261102-mt-feature-a", "2026-11-02T10:00:00.000Z", "20261102-mt-feature-a"));
  await runs.save(record("20261102-mt-feature-c", "2026-11-02T12:00:00.000Z", "20261102-mt-feature-c"));
  await runs.save(
    record("20261102-mt-feature-done", "2026-11-02T09:00:00.000Z", "20261102-mt-feature-done", "done"),
  );
  await runs.save(record("20261102-mt-feature-here", "2026-11-02T09:30:00.000Z"));
  await registry.save(["a", "b", "c", "done"].map((x) => entry(`20261102-mt-feature-${x}`)));
  const sent: SendMessageInput[] = [];
  const conflicts = new WorktreeConflicts(
    runs,
    registry,
    async (e) => {
      const files = changed[e.id];
      return files ? ok(files) : err(new MetatorError("COMMAND_FAILED", `no git in ${e.path}`));
    },
    {
      send: async (input) => {
        sent.push(input);
        return ok({ id: `m00${sent.length}` } as never);
      },
    },
  );
  return { conflicts, sent };
}

describe("WorktreeConflicts", () => {
  test("pairs of active worktree runs that changed the same file; the earlier run merges first", async () => {
    const w = await world({
      "20261102-mt-feature-a": ["src/invoice.ts", "src/a.ts"],
      "20261102-mt-feature-b": ["src/web.ts", "src/invoice.ts"],
      "20261102-mt-feature-c": ["src/web.ts"],
      "20261102-mt-feature-done": ["src/invoice.ts"],
    });
    const r = (await w.conflicts.execute())._unsafeUnwrap();
    expect(r.changes.map((c) => [c.runId, c.files])).toEqual([
      ["20261102-mt-feature-a", ["src/a.ts", "src/invoice.ts"]],
      ["20261102-mt-feature-b", ["src/invoice.ts", "src/web.ts"]],
      ["20261102-mt-feature-c", ["src/web.ts"]],
    ]);
    expect(r.conflicts).toEqual([
      {
        runs: ["20261102-mt-feature-a", "20261102-mt-feature-b"],
        files: ["src/invoice.ts"],
        mergeFirst: "20261102-mt-feature-a",
      },
      {
        runs: ["20261102-mt-feature-b", "20261102-mt-feature-c"],
        files: ["src/web.ts"],
        mergeFirst: "20261102-mt-feature-b",
      },
    ]);
    expect([r.notified, w.sent]).toEqual([[], []]);
  });

  test("--notify tells both runs of each conflict, as a shared-file message each way", async () => {
    const w = await world({
      "20261102-mt-feature-a": ["src/invoice.ts"],
      "20261102-mt-feature-b": ["src/invoice.ts"],
      "20261102-mt-feature-c": [],
    });
    const r = (await w.conflicts.execute({ notify: { by: "alice" } }))._unsafeUnwrap();
    expect(r.notified).toEqual(["m001→20261102-mt-feature-a", "m002→20261102-mt-feature-b"]);
    expect(w.sent.map((s) => [s.from, s.to, s.topic, s.refs, s.by])).toEqual([
      ["20261102-mt-feature-b", "20261102-mt-feature-a", "shared-file", ["src/invoice.ts"], "alice"],
      ["20261102-mt-feature-a", "20261102-mt-feature-b", "shared-file", ["src/invoice.ts"], "alice"],
    ]);
    expect(w.sent[0]?.text).toBe(
      "both runs changed src/invoice.ts; merge 20261102-mt-feature-a first, the other rebases on it",
    );
  });

  test("a worktree whose changes cannot be read is an error, not a silent gap", async () => {
    const w = await world({ "20261102-mt-feature-a": [], "20261102-mt-feature-b": [] });
    expect((await w.conflicts.execute())._unsafeUnwrapErr().message).toContain("no git in");
  });
});
