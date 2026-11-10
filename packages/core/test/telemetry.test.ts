import { describe, expect, test } from "bun:test";
import { type AgentUsage, fleetReport, type Question, type RunFacts, runMetrics } from "@metator/core";

const use = (agent: string, over: Partial<AgentUsage> = {}): AgentUsage => ({
  at: "2026-11-02T10:00:00.000Z",
  stage: "build",
  agent,
  ok: true,
  durationMs: 60_000,
  inputTokens: 1000,
  outputTokens: 200,
  cachedTokens: 500,
  costUsd: 0.12,
  ...over,
});
const q = (over: Partial<Question>): Question => ({
  id: "q001",
  runId: "r",
  stage: "plan-approval",
  source: "gate",
  prompt: "p",
  options: [{ label: "Approve" }],
  multiSelect: false,
  askedAt: "2026-11-02T10:00:00.000Z",
  ...over,
});
const run = (over: Partial<RunFacts>): RunFacts => ({
  runId: "a",
  workflow: "mt-feature",
  status: "done",
  createdAt: "2026-11-02T09:00:00.000Z",
  updatedAt: "2026-11-02T10:30:00.000Z",
  history: [{ event: "PASS" }, { event: "FAIL" }, { event: "PASS" }],
  questions: [],
  usage: [],
  ...over,
});
const now = new Date("2026-11-02T12:00:00.000Z");

describe("telemetry", () => {
  test("one run: wall time to its last change, usage summed, people's waiting without policy answers", () => {
    const m = runMetrics(
      run({
        usage: [use("mt-planner"), use("mt-implementer", { costUsd: 0.3, inputTokens: undefined })],
        questions: [
          q({ answer: { choices: ["Approve"], by: "alice", at: "2026-11-02T10:10:00.000Z" } }),
          q({
            id: "q002",
            answer: { choices: ["Approve"], by: "policy:approve-plan", at: "2026-11-02T10:30:00.000Z" },
          }),
          q({ id: "q003", source: "permission", agent: "mt-implementer" }),
        ],
      }),
      now,
    );
    expect(m).toEqual({
      runId: "a",
      workflow: "mt-feature",
      status: "done",
      wallMs: 5_400_000,
      usage: {
        calls: 2,
        agentMs: 120_000,
        inputTokens: 1000,
        outputTokens: 400,
        cachedTokens: 1000,
        costUsd: 0.42,
      },
      // q001 waited 10 min; q003 is open and waits up to now (2 h); q002 a policy answered.
      questions: { asked: 3, byPolicy: 1, bySource: { gate: 2, permission: 1 }, waitMs: 600_000 + 7_200_000 },
      failures: 1,
    });
    expect(runMetrics(run({ status: "active" }), now).wallMs).toBe(10_800_000); // active: up to now
  });

  test("many runs: totals, and each agent by cost, with its failures and questions", () => {
    const r = fleetReport(
      [
        run({ usage: [use("mt-planner"), use("mt-implementer", { ok: false, costUsd: 0.5 })] }),
        run({
          runId: "b",
          status: "escalated",
          history: [],
          usage: [use("mt-implementer", { costUsd: 0.25 })],
          questions: [
            q({
              source: "agent",
              agent: "mt-implementer",
              answer: { choices: ["Other"], by: "m", at: "2026-11-02T10:01:00.000Z" },
            }),
          ],
        }),
      ],
      now,
    );
    expect(r.totals).toEqual({
      calls: 3,
      agentMs: 180_000,
      inputTokens: 3000,
      outputTokens: 600,
      cachedTokens: 1500,
      costUsd: 0.87,
      runs: 2,
      done: 1,
      questions: 1,
      byPolicy: 0,
      personWaitMs: 60_000,
      failures: 1,
    });
    expect(r.agents.map((a) => [a.agent, a.calls, a.costUsd, a.failed, a.questions])).toEqual([
      ["mt-implementer", 2, 0.75, 1, 1],
      ["mt-planner", 1, 0.12, 0, 0],
    ]);
    expect(fleetReport([], now).totals.runs).toBe(0);
  });
});
