import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { CloseRun, HandoffRun } from "../src/application/run-close.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, GetRunStatus, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import type { RunRecord } from "../src/domain/run-record.ts";
import { RunHandoffDocument, RunSummaryDocument, summarizeRun } from "../src/domain/run-report.ts";
import { readFrontMatter } from "../src/domain/versioned.ts";

const FEATURE = `
kind: Workflow
schemaVersion: 1
id: feature
stages:
  - id: plan
  - id: approval
    hitl: true
  - id: build
loops: {}
`;

async function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/feature.yml": FEATURE });
  const start = new FixedClock(new Date("2026-10-25T09:00:00.000Z"));
  const later = new FixedClock(new Date("2026-10-25T10:30:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const advance = new AdvanceRun(catalog, repo, start);
  const run = (
    await new InitRun(catalog, repo, start).execute({ workflow: "feature", task: "Add discount" })
  )._unsafeUnwrap();
  return {
    fs,
    repo,
    advance,
    runId: run.runId,
    dir: repo.runDir(run.runId),
    handoff: new HandoffRun(new GetRunStatus(catalog, repo), repo, fs, later),
    close: new CloseRun(advance, repo, fs, later),
  };
}

describe("HandoffRun", () => {
  test("writes handoff.md from the run directory: stage, approvals, artifacts, recent log", async () => {
    const w = await world();
    await w.advance.execute({ event: { type: "PASS" } });
    await w.advance.execute({ event: { type: "APPROVE", by: "maciej", choice: "1" } });
    await w.fs.write(`${w.dir}/plan.json`, "{}");
    await w.fs.write(`${w.dir}/findings/logic-core.json`, "{}");
    const r = (await w.handoff.execute({ logLines: 2 }))._unsafeUnwrap();
    expect(r).toEqual({
      runId: w.runId,
      file: `${w.dir}/handoff.md`,
      artifacts: ["findings/logic-core.json", "plan.json"],
    });
    const text = (await w.fs.read(r.file))._unsafeUnwrap();
    expect(
      readFrontMatter(text, r.file)
        .andThen((raw) => RunHandoffDocument.parse(raw, r.file))
        ._unsafeUnwrap(),
    ).toEqual({ runId: w.runId, writtenAt: "2026-10-25T10:30:00.000Z" });
    expect(text).toContain("- Stage: build (active)");
    expect(text).toContain("- Expects: PASS, FAIL, ABORT");
    expect(text).toContain("- approval: maciej (choice 1), 2026-10-25T09:00:00.000Z");
    expect(text).toContain("- plan.json");
    expect(text).toContain(`metator run status --run ${w.runId}`);
    // Only the last two log entries; the creation line is older.
    expect(text).not.toContain("created");
    expect(text).toContain("approval · APPROVE · by maciej · choice 1 → build");
  });

  test("an empty run says so; the default keeps ten log entries", async () => {
    const w = await world();
    const r = (await w.handoff.execute({ runId: w.runId }))._unsafeUnwrap();
    const text = (await w.fs.read(r.file))._unsafeUnwrap();
    expect(text).toContain("## Approvals\n\n- none");
    expect(text).toContain("## Loops used\n\n- none");
    expect(text).toContain("## Artifacts\n\n- none yet");
    expect(text).toContain("created · workflow feature@1 · L0");
  });

  test("an unknown run is an error value", async () => {
    const w = await world();
    expect((await w.handoff.execute({ runId: "20261025-nope" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

describe("CloseRun", () => {
  test("an active run is not closed without --aborted", async () => {
    const w = await world();
    const e = (await w.close.execute({}))._unsafeUnwrapErr();
    expect([e.code, e.message]).toEqual(["USAGE", `run ${w.runId} is still active at stage plan`]);
    expect(await w.fs.exists(`${w.dir}/summary.json`)).toBe(false);
  });

  test("a finished run gets summary.json with the final telemetry", async () => {
    const w = await world();
    await w.advance.execute({ event: { type: "PASS" } });
    await w.advance.execute({ event: { type: "APPROVE", by: "maciej" } });
    await w.advance.execute({ event: { type: "PASS" } });
    await w.fs.write(`${w.dir}/gates.json`, "{}");
    const s = (await w.close.execute({ runId: w.runId }))._unsafeUnwrap();
    expect(s).toMatchObject({
      status: "done",
      durationMs: 90 * 60 * 1000,
      events: { PASS: 2, FAIL: 0, APPROVE: 1, ABORT: 0 },
      artifacts: ["gates.json"],
      file: `${w.dir}/summary.json`,
    });
    const raw = JSON.parse((await w.fs.read(s.file))._unsafeUnwrap());
    expect(RunSummaryDocument.parse(raw, s.file)._unsafeUnwrap().closedAt).toBe("2026-10-25T10:30:00.000Z");
    expect((await w.repo.readLog(w.runId))._unsafeUnwrap().at(-1)).toBe(
      "2026-10-25T10:30:00.000Z · closed · done",
    );
  });

  test("--aborted aborts an active run with the reason, then closes it", async () => {
    const w = await world();
    const s = (await w.close.execute({ abortReason: "scope changed" }))._unsafeUnwrap();
    expect([s.status, s.events.ABORT, s.stage]).toEqual(["aborted", 1, "aborted"]);
    const log = (await w.repo.readLog(w.runId))._unsafeUnwrap();
    expect(log.some((l) => l.includes("ABORT · scope changed"))).toBe(true);
  });

  test("no runs at all is an error value", async () => {
    const fs = new InMemoryFileSystem({});
    const repo = new RunRepository(fs, DEFAULT_PATHS);
    const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
    const clock = new FixedClock(new Date());
    const close = new CloseRun(new AdvanceRun(catalog, repo, clock), repo, fs, clock);
    expect((await close.execute({}))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

describe("summarizeRun", () => {
  test("a clock behind the creation time never gives a negative duration", () => {
    const record = {
      runId: "20261025-feature-x",
      workflow: { id: "feature", revision: 1, source: "f.yml" },
      task: "x",
      autonomy: "L0",
      createdAt: "2026-10-25T10:00:00.000Z",
      updatedAt: "2026-10-25T10:00:00.000Z",
      state: { workflow: "feature", stage: "plan", status: "escalated", context: { loops: {}, history: [] } },
      approvals: {},
    } satisfies RunRecord;
    expect(summarizeRun(record, new Date("2026-10-25T09:00:00.000Z"), ["b", "a"])).toMatchObject({
      durationMs: 0,
      status: "escalated",
      artifacts: ["a", "b"],
    });
  });
});
