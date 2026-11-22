import { describe, expect, test } from "bun:test";
import { toEvent } from "../src/commands/run.ts";

describe("toEvent", () => {
  test("an approval without a name is refused, whatever default the command found", () => {
    for (const event of [
      toEvent("approve", {}),
      toEvent("approve", { by: "" }),
      toEvent("approve", { by: "   " }),
    ]) {
      expect(event.isErr() && event.error.code).toBe("USAGE");
    }
  });

  test("an approval with a name records it and the choice", () => {
    expect(toEvent("approve", { by: "maciej" })._unsafeUnwrap()).toEqual({ type: "APPROVE", by: "maciej" });
    expect(toEvent("approve", { by: "maciej", choice: "Approve" })._unsafeUnwrap()).toEqual({
      type: "APPROVE",
      by: "maciej",
      choice: "Approve",
    });
  });
});
