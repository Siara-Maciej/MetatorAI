import { describe, expect, test } from "bun:test";
import type { RunActivity } from "@metator/core";
import { formatActivity, person } from "../src/live.ts";

const at = "2026-10-27T10:00:00.000Z";
const e = (entry: Omit<RunActivity, "at">): RunActivity => ({ at, ...entry });

describe("live view", () => {
  test("one line per entry: stages stand out, agents and tools indent, transitions show their result", () => {
    expect(
      [
        e({ type: "stage", stage: "build", text: "Tests RED then GREEN" }),
        e({ type: "agent", stage: "build", agent: "mt-implementer", text: "mt-implementer started" }),
        e({ type: "text", stage: "build", agent: "mt-implementer", text: "\nAdding the test first\nmore" }),
        e({ type: "tool", stage: "build", agent: "mt-implementer", text: "Edit src/a.ts" }),
        e({ type: "advance", stage: "build", text: "PASS" }),
        e({ type: "advance", stage: "gates", text: "FAIL: lint" }),
        e({ type: "answer", stage: "approval", text: "q001: Approve · alice" }),
        e({ type: "error", text: "boom" }),
        e({ type: "drive", text: "driving with claude" }),
      ].map(formatActivity),
    ).toEqual([
      "▸ build · Tests RED then GREEN",
      "  mt-implementer started",
      "  mt-implementer: Adding the test first",
      "    Edit src/a.ts",
      "  ✓ PASS",
      "  ✗ FAIL: lint",
      "  ↳ q001: Approve · alice",
      "  ! boom",
      "· driving with claude",
    ]);
  });

  test("questions are asked in place, not printed", () => {
    expect(formatActivity(e({ type: "question", stage: "approval", text: "q001: approve?" }))).toBeNull();
  });

  test("who answers: METATOR_USER, else the login name", () => {
    expect([person({ METATOR_USER: "alice", USER: "root" }), person({ USER: "bob" }), person({})]).toEqual([
      "alice",
      "bob",
      "you",
    ]);
  });
});
