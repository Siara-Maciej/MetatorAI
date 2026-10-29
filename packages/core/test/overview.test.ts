import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { WorkOverview } from "../src/application/overview.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { attentionOf, byAttention, countAttention, stageProgress } from "../src/domain/overview.ts";
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
    expect(countAttention(runs)).toEqual({ you: 2, driving: 1, stopped: 1, finished: 1 });
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
    }) as never,
  );
  await runs.save(record("20261028-mt-feature-c", "build", "done") as never);
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
        ok(id.endsWith("-b") ? { pid: 1, host: "copilot", startedAt: "x", alive: true } : null),
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
  return { overview, runs };
}

describe("WorkOverview", () => {
  test("every run: stages, who acts, open questions, host, last activity, worktree and services", async () => {
    const o = (await (await world()).overview.execute())._unsafeUnwrap();
    expect(o.runs.map((r) => [r.runId.slice(-1), r.attention, r.host, r.questions.length])).toEqual([
      ["b", "you", "copilot", 1],
      ["a", "you", "claude", 0],
      ["c", "done", undefined, 0],
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
    expect(o.counts).toEqual({ you: 2, driving: 0, stopped: 0, finished: 1, questions: 1, services: 1 });
    expect(o.conversations).toEqual([
      { id: "20261028-why", title: "Why?", host: "claude", turns: 2, updatedAt: "2026-10-28T11:00:00.000Z" },
    ]);
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
