import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { WorkOverview } from "../src/application/overview.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { escalatedOf, inboxOf } from "../src/domain/inbox.ts";
import {
  attentionOf,
  byAttention,
  countAttention,
  stageProgress,
  stoppedAt,
} from "../src/domain/overview.ts";
import { err, ok } from "../src/domain/result.ts";

const STAGES = [{ id: "intake" }, { id: "plan" }, { id: "plan-approval", hitl: true }, { id: "build" }];

describe("overview domain", () => {
  test("stages before the current one are done; the current one works or waits; the rest are next", () => {
    expect(stageProgress(STAGES, "plan", "active", 0).map((s) => s.state)).toEqual([
      "done",
      "current",
      "next",
      "next",
    ]);
    expect(stageProgress(STAGES, "plan", "active", 1).map((s) => s.state)).toEqual([
      "done",
      "waiting",
      "next",
      "next",
    ]);
    expect(stageProgress(STAGES, "plan-approval", "active", 0).map((s) => [s.state, s.hitl])).toEqual([
      ["done", false],
      ["done", false],
      ["waiting", true],
      ["next", false],
    ]);
    expect(stageProgress(STAGES, "build", "done", 0).every((s) => s.state === "done")).toBe(true);
    expect(stageProgress(STAGES, "plan", "escalated", 0)[1]?.state).toBe("stopped");
    expect(stageProgress(STAGES, "gone", "active", 0).map((s) => s.state)).toEqual([
      "next",
      "next",
      "next",
      "next",
    ]);
  });

  test("an escalated or aborted run is at the stage its history ends with, not at its end state", () => {
    const history = [{ stage: "intake" }, { stage: "plan" }];
    expect(stoppedAt("escalated", "escalated", history)).toBe("plan");
    expect(stoppedAt("aborted", "aborted", history)).toBe("plan");
    expect(stoppedAt("escalated", "escalated", [])).toBe("escalated");
    expect(stoppedAt("build", "active", history)).toBe("build");
    expect(stoppedAt("done", "done", history)).toBe("done");
  });

  test("who must act: a question or an undriven gate means you; then the drive; finished runs say how", () => {
    expect(attentionOf("active", 1, true, false)).toBe("you");
    expect(attentionOf("active", 0, false, true)).toBe("you");
    expect(attentionOf("active", 0, true, true)).toBe("driving");
    expect(attentionOf("active", 0, false, false)).toBe("stopped");
    expect(attentionOf("escalated", 2, true, true)).toBe("escalated");
    const runs = [
      { id: "a", attention: "done" as const, updatedAt: "2026-10-28T12:00:00Z" },
      { id: "b", attention: "stopped" as const, updatedAt: "2026-10-28T09:00:00Z" },
      { id: "c", attention: "you" as const, updatedAt: "2026-10-28T08:00:00Z" },
      { id: "d", attention: "you" as const, updatedAt: "2026-10-28T11:00:00Z" },
      { id: "e", attention: "driving" as const, updatedAt: "2026-10-28T07:00:00Z" },
    ];
    expect(byAttention(runs).map((r) => r.id)).toEqual(["d", "c", "e", "b", "a"]);
    expect(countAttention(runs)).toEqual({ you: 2, driving: 1, stopped: 1, escalated: 0, finished: 1 });
    // An escalated run waits for a person: it is not finished (F1).
    const mixed = [...runs, { attention: "escalated" as const }, { attention: "aborted" as const }];
    expect(countAttention(mixed)).toMatchObject({ escalated: 1, finished: 2 });
  });
});

async function world() {
  const fs = new InMemoryFileSystem();
  const runs = new RunRepository(fs, DEFAULT_PATHS);
  const record = (runId: string, stage: string, status: string, extra: object = {}) => ({
    runId,
    workflow: { id: "mt-feature", revision: 2, source: "x" },
    task: `task of ${runId}`,
    autonomy: "L0" as const,
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:30:00.000Z",
    state: { workflow: "mt-feature", stage, status, context: { loops: {}, history: [] } },
    approvals: {},
    ...extra,
  });
  await runs.save(record("20261028-mt-feature-a", "plan-approval", "active", { host: "claude" }) as never);
  await runs.save(
    record("20261028-mt-feature-b", "build", "active", {
      worktree: { id: "b", path: ".metator/wt/b", branch: "metator/b" },
      parent: "20261028-mt-feature-c",
    }) as never,
  );
  await runs.save(
    record("20261028-mt-feature-c", "build", "done", { children: ["20261028-mt-feature-b"] }) as never,
  );
  const overview = new WorkOverview(
    runs,
    { get: async () => ok({ spec: { stages: STAGES } }) as never },
    {
      questions: async (id) =>
        ok(
          id.endsWith("-a")
            ? [
                {
                  id: "q001",
                  runId: id,
                  stage: "plan",
                  source: "agent",
                  prompt: "Answered already",
                  options: [{ label: "A" }],
                  multiSelect: false,
                  askedAt: "2026-10-28T10:10:00.000Z",
                  answer: { choices: ["A"], by: "m", at: "2026-10-28T10:11:00.000Z" },
                },
              ]
            : id.endsWith("-b")
              ? [
                  {
                    id: "q001",
                    runId: id,
                    stage: "build",
                    source: "agent",
                    prompt: "Which?",
                    options: [{ label: "A" }],
                    multiSelect: false,
                    askedAt: "2026-10-28T10:20:00.000Z",
                  },
                ]
              : [],
        ) as never,
      activity: async (id) =>
        ok(
          id.endsWith("-a")
            ? [{ at: "2026-10-28T10:29:00.000Z", type: "stage", stage: "plan-approval", text: "waits" }]
            : [],
        ) as never,
    },
    {
      status: async (id) =>
        ok(
          id.endsWith("-b")
            ? { pid: 1, host: "copilot", startedAt: "x", alive: true }
            : id.endsWith("-a")
              ? { pid: 2, host: "claude", startedAt: "x", alive: false }
              : null,
        ),
    },
    { get: async () => ok({ ports: { from: 41000, count: 20 } }) as never },
    {
      status: async () =>
        ok([
          { service: "api", status: "running", ports: { http: 41000 }, scope: "worktree", place: "b" },
        ]) as never,
    },
    {
      list: async () =>
        ok([
          {
            id: "20261028-why",
            title: "Why?",
            host: "claude",
            turns: [{}, {}],
            updatedAt: "2026-10-28T11:00:00.000Z",
          },
        ]) as never,
    },
    new FixedClock(new Date("2026-10-28T11:00:00.000Z")),
  );
  return { overview, runs, fs };
}

describe("WorkOverview", () => {
  test("an escalated run shows the stages it passed and the one it stopped at, and is counted", async () => {
    const { overview, runs } = await world();
    await runs.save({
      runId: "20261028-mt-feature-d",
      workflow: { id: "mt-feature", revision: 2, source: "x" },
      task: "d",
      autonomy: "L0",
      createdAt: "2026-10-28T10:00:00.000Z",
      updatedAt: "2026-10-28T10:30:00.000Z",
      state: {
        workflow: "mt-feature",
        stage: "escalated",
        status: "escalated",
        context: {
          loops: {},
          history: [
            { stage: "intake", event: "PASS" },
            { stage: "plan", event: "FAIL", detail: "no plan.json" },
          ],
        },
      },
      approvals: {},
    } as never);
    const o = (await overview.execute())._unsafeUnwrap();
    const d = o.runs.find((r) => r.runId.endsWith("-d"));
    expect([d?.stage, d?.attention, d?.reason]).toEqual(["plan", "escalated", "no plan.json"]);
    expect(d?.stages.map((s) => s.state)).toEqual(["done", "stopped", "next", "next"]);
    expect([o.counts.escalated, o.counts.finished]).toEqual([1, 1]);
    // What the inbox shows of it: the stage, the reason, how long, the two commands out.
    expect(escalatedOf(o.runs, new Date("2026-10-28T11:00:00.000Z"))).toEqual([
      {
        runId: "20261028-mt-feature-d",
        task: "d",
        stage: "plan",
        reason: "no plan.json",
        waitedMs: 1_800_000,
        next: [
          "metator run resume --run 20261028-mt-feature-d --by <name> --drive",
          "metator run close --run 20261028-mt-feature-d --aborted --reason <why>",
        ],
      },
    ]);
  });

  test("a run that ended asks nothing: its open question is neither listed nor counted (R3)", async () => {
    const { overview, runs } = await world();
    const b = (await runs.load("20261028-mt-feature-b"))._unsafeUnwrap();
    await runs.save({ ...b, state: { ...b.state, stage: "aborted", status: "aborted" } });
    const o = (await overview.execute())._unsafeUnwrap();
    const run = o.runs.find((r) => r.runId.endsWith("-b"));
    expect([run?.attention, run?.questions.length, o.counts.questions]).toEqual(["aborted", 0, 0]);
    expect(inboxOf(o.runs, new Date("2026-10-28T11:00:00.000Z"))).toEqual([]);
  });

  test("every run: stages, who acts, open questions, host, last activity, worktree and services", async () => {
    const o = (await (await world()).overview.execute())._unsafeUnwrap();
    expect(o.runs.map((r) => [r.runId.slice(-1), r.attention, r.host, r.questions.length])).toEqual([
      ["b", "you", "copilot", 1],
      ["a", "you", "claude", 0],
      ["c", "done", undefined, 0],
    ]);
    // a's drive left its file behind and its process is gone: it died; b's is alive; c is done.
    expect(o.runs.map((r) => r.died)).toEqual([false, true, false]);
    // Linked runs: a step names its parent, a parent its steps; the rest say nothing.
    expect(o.runs.map((r) => [r.parent, r.children])).toEqual([
      ["20261028-mt-feature-c", undefined],
      [undefined, undefined],
      [undefined, ["20261028-mt-feature-b"]],
    ]);
    const a = o.runs[1];
    expect(a?.stages.map((s) => s.state)).toEqual(["done", "done", "waiting", "next"]);
    expect([a?.last?.text, a?.elapsedMs, a?.services]).toEqual(["waits", 3_600_000, []]);
    const b = o.runs[0];
    expect([b?.worktree?.ports, b?.services.map((s) => s.status)]).toEqual([
      { from: 41000, count: 20 },
      ["running"],
    ]);
    expect(o.runs[2]?.elapsedMs).toBe(1_800_000); // finished: up to its last change
    expect(o.counts).toEqual({
      you: 2,
      driving: 0,
      stopped: 0,
      escalated: 0,
      finished: 1,
      questions: 1,
      services: 1,
    });
    expect(o.conversations).toEqual([
      { id: "20261028-why", title: "Why?", host: "claude", turns: 2, updatedAt: "2026-10-28T11:00:00.000Z" },
    ]);
  });

  test("a run whose record cannot be read is left out and named; the others are all there (R2)", async () => {
    const w = await world();
    await w.fs.write(w.runs.stateFile("20261028-mt-feature-b"), '{"kind":"RunRecord","schemaVer');
    const o = (await w.overview.execute())._unsafeUnwrap();
    expect(o.runs.map((r) => r.runId).sort()).toEqual(["20261028-mt-feature-a", "20261028-mt-feature-c"]);
    expect(o.unreadable.map((u) => [u.runId, u.file])).toEqual([
      ["20261028-mt-feature-b", ".metator/runs/20261028-mt-feature-b/state.json"],
    ]);
    expect(o.unreadable[0]?.message).toContain("not valid JSON");
  });

  test("a run whose workflow is gone still shows its stage; a broken conversation list is an error", async () => {
    const w = await world();
    const broken = new WorkOverview(
      w.runs,
      { get: async () => err(MetatorError.notFound("workflow")) },
      { questions: async () => ok([]), activity: async () => ok([]) },
      { status: async () => ok(null) },
      { get: async () => err(MetatorError.notFound("worktree")) },
      { status: async () => err(MetatorError.notFound("environment")) },
      { list: async () => err(new MetatorError("INVALID_ARTIFACT", "bad conversation")) },
      new FixedClock(),
    );
    expect((await broken.execute())._unsafeUnwrapErr().message).toBe("bad conversation");
  });
});
