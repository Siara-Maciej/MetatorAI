import { describe, expect, test } from "bun:test";
import { BuildReport, DEFAULT_PATHS, ok, RunRepository } from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const record = (id: string, createdAt: string) =>
  ({
    runId: id,
    workflow: { id: "mt-feature", revision: 1, source: "x" },
    task: id,
    autonomy: "L0",
    createdAt,
    updatedAt: createdAt,
    state: { workflow: "mt-feature", stage: "intake", status: "active", context: { loops: {}, history: [] } },
    approvals: {},
  }) as never;

describe("BuildReport", () => {
  test("every run's facts, or only the runs started since a time", async () => {
    const fs = new InMemoryFileSystem();
    const runs = new RunRepository(fs, DEFAULT_PATHS);
    await runs.save(record("20261101-mt-feature-old", "2026-11-01T09:00:00.000Z"));
    await runs.save(record("20261102-mt-feature-new", "2026-11-02T09:00:00.000Z"));
    const report = new BuildReport(
      runs,
      {
        questions: async () => ok([]),
        usage: async () => ok([]),
      },
      new FixedClock(new Date("2026-11-02T12:00:00.000Z")),
    );
    const all = (await report.execute())._unsafeUnwrap();
    expect(all.runs.map((r) => r.runId).sort()).toEqual([
      "20261101-mt-feature-old",
      "20261102-mt-feature-new",
    ]);
    const since = (await report.execute("2026-11-02T00:00:00.000Z"))._unsafeUnwrap();
    expect(since.runs.map((r) => r.runId)).toEqual(["20261102-mt-feature-new"]);
    expect(since.totals.runs).toBe(1);
  });
});
