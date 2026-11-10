import { describe, expect, test } from "bun:test";
import { briefOf, inboxOf, type Question, type RunActivity } from "@metator/core";

const q = (id: string, askedAt: string, answered = false): Question => ({
  id,
  runId: "r",
  stage: "plan",
  source: "agent",
  prompt: `question ${id}`,
  options: [{ label: "Other" }],
  multiSelect: false,
  askedAt,
  ...(answered ? { answer: { choices: ["Other"], by: "m", at: askedAt } } : {}),
});
const now = new Date("2026-11-02T12:00:00.000Z");

describe("inboxOf", () => {
  test("one queue: decisions a live drive waits on first, then the oldest; answered ones left out", () => {
    const items = inboxOf(
      [
        { runId: "a", task: "A", driving: false, questions: [q("q001", "2026-11-02T09:00:00.000Z")] },
        {
          runId: "b",
          task: "B",
          driving: true,
          questions: [q("q001", "2026-11-02T11:50:00.000Z"), q("q002", "2026-11-02T08:00:00.000Z", true)],
        },
        { runId: "c", task: "C", driving: false, questions: [q("q001", "2026-11-02T10:00:00.000Z")] },
      ],
      now,
    );
    expect(items.map((i) => [i.runId, i.question.id, i.waitedMs])).toEqual([
      ["b", "q001", 600_000],
      ["a", "q001", 10_800_000],
      ["c", "q001", 7_200_000],
    ]);
  });

  test("ties keep a stable order; a question asked after now has waited nothing", () => {
    const same = "2026-11-02T11:00:00.000Z";
    const items = inboxOf(
      [
        { runId: "z", task: "Z", driving: false, questions: [q("q001", same)] },
        {
          runId: "y",
          task: "Y",
          driving: false,
          questions: [q("q001", same), q("q002", "2026-11-03T00:00:00.000Z")],
        },
      ],
      now,
    );
    expect(items.map((i) => `${i.runId}/${i.question.id}:${i.waitedMs}`)).toEqual([
      "y/q001:3600000",
      "z/q001:3600000",
      "y/q002:0",
    ]);
  });
});

const at = (min: number) => `2026-11-02T10:${String(min).padStart(2, "0")}:00.000Z`;
const act = (min: number, type: RunActivity["type"], text: string, stage?: string): RunActivity => ({
  at: at(min),
  type,
  text,
  ...(stage ? { stage } : {}),
});

describe("briefOf", () => {
  test("what happened since the last look: transitions, files written once, answers, questions, errors", () => {
    const activity = [
      act(1, "advance", "PASS", "intake"),
      act(5, "advance", "PASS", "plan"),
      act(6, "tool", 'Edit {"file_path":"/repo/src/a.ts","old_string":"x"}', "build"),
      act(7, "tool", 'Write {"file_path":"/repo/test/a.test.ts","content":"y"}', "build"),
      act(8, "tool", 'Edit {"file_path":"/repo/src/a.ts","old_string":"z"}', "build"),
      act(9, "tool", 'Read {"file_path":"/repo/src/b.ts"}', "build"),
      act(10, "question", "q001: Which rounding?", "build"),
      act(11, "answer", "q001: Other (half up) · maciej", "build"),
      act(12, "advance", "FAIL: 2 tests red", "gates"),
      act(13, "error", "host crashed", "build"),
    ];
    expect(briefOf(activity, at(2))).toEqual({
      since: at(2),
      transitions: ["plan PASS", "gates FAIL: 2 tests red"],
      files: ["/repo/src/a.ts", "/repo/test/a.test.ts"],
      answers: ["q001: Other (half up) · maciej"],
      questions: ["q001: Which rounding?"],
      errors: ["host crashed"],
      tools: 4,
      last: `${at(13)} error: host crashed`,
    });
  });

  test("nothing since the last look: an empty brief without a last event", () => {
    expect(briefOf([act(1, "advance", "PASS", "intake")], at(1))).toEqual({
      since: at(1),
      transitions: [],
      files: [],
      answers: [],
      questions: [],
      errors: [],
      tools: 0,
    });
  });
});
