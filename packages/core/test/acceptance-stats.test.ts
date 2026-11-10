import { describe, expect, test } from "bun:test";
import { acceptanceStats } from "../src/domain/telemetry.ts";

const q = (askedAt: string, answer?: { by: string; at: string }) => ({ source: "gate", askedAt, answer });
const a = (at: string, type: string, origin?: string) => ({ at, type, ...(origin ? { origin } : {}) });

describe("acceptanceStats", () => {
  test("the median answer time over people's answers, policies left out; answers from the card counted", () => {
    const s = acceptanceStats(
      [
        {
          questions: [
            q("2026-11-02T10:00:00.000Z", { by: "alice", at: "2026-11-02T10:01:00.000Z" }),
            q("2026-11-02T10:00:00.000Z", { by: "policy:p001", at: "2026-11-02T10:00:00.000Z" }),
            q("2026-11-02T10:00:00.000Z"),
          ],
          activity: [a("2026-11-02T10:01:00.000Z", "answer", "inbox")],
        },
        {
          questions: [
            q("2026-11-02T11:00:00.000Z", { by: "bob", at: "2026-11-02T11:05:00.000Z" }),
            q("2026-11-02T11:00:00.000Z", { by: "bob", at: "2026-11-02T11:03:00.000Z" }),
          ],
          activity: [a("2026-11-02T11:05:00.000Z", "answer"), a("2026-11-02T11:03:00.000Z", "answer")],
        },
      ],
      "2026-11-01T00:00:00.000Z",
    );
    expect(s).toEqual({ answered: 3, medianAnswerMs: 180_000, fromInbox: 1, restarts: 0, nudges: 0 });
  });

  test("an even number of answers takes the middle two; no answer gives no median", () => {
    const two = acceptanceStats(
      [
        {
          questions: [
            q("2026-11-02T10:00:00.000Z", { by: "a", at: "2026-11-02T10:01:00.000Z" }),
            q("2026-11-02T10:00:00.000Z", { by: "a", at: "2026-11-02T10:03:00.000Z" }),
          ],
          activity: [],
        },
      ],
      "2026-11-01T00:00:00.000Z",
    );
    expect(two.medianAnswerMs).toBe(120_000);
    expect(
      acceptanceStats(
        [{ questions: [q("2026-11-02T10:00:00.000Z")], activity: [] }],
        "2026-11-01T00:00:00.000Z",
      ),
    ).not.toHaveProperty("medianAnswerMs");
  });

  test("restarts and nudges are counted since the given time only", () => {
    const s = acceptanceStats(
      [
        {
          questions: [],
          activity: [
            a("2026-11-01T10:00:00.000Z", "restart"),
            a("2026-11-02T10:00:00.000Z", "restart"),
            a("2026-11-02T10:00:00.000Z", "idle"),
            a("2026-11-02T10:00:00.000Z", "idle"),
            a("2026-11-02T10:00:00.000Z", "tool"),
          ],
        },
      ],
      "2026-11-02T00:00:00.000Z",
    );
    expect([s.restarts, s.nudges]).toEqual([1, 2]);
  });
});
