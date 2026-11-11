import { describe, expect, test } from "bun:test";
import { isRunBookkeeping } from "../src/domain/run-record.ts";

describe("a run's own files", () => {
  test("the record, log, summary, handoff, the drive's lock and journals, questions and messages are bookkeeping", () => {
    for (const file of [
      "state.json",
      "log.md",
      "summary.json",
      "handoff.md",
      "driver.json",
      "seen.json",
      "activity.jsonl",
      "usage.jsonl",
      "questions/q001.json",
      "messages/m001.json",
    ])
      expect([file, isRunBookkeeping(file)]).toEqual([file, true]);
  });

  test("what a stage left is an artifact, in the run directory or below it", () => {
    for (const file of ["task.md", "plan.json", "gates.md", "findings/logic.json", "results/mt-scout.json"])
      expect([file, isRunBookkeeping(file)]).toEqual([file, false]);
  });
});
