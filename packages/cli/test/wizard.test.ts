import { describe, expect, test } from "bun:test";
import { autonomyChoices, firstWorkflow } from "../src/terminal.ts";

describe("the new-run wizard", () => {
  test("it starts at mt-feature when that is installed, else at the first workflow", () => {
    expect(firstWorkflow([{ id: "mt-bugfix" }, { id: "mt-feature" }, { id: "mt-refactor" }])).toBe(
      "mt-feature",
    );
    expect(firstWorkflow([{ id: "demo" }, { id: "other" }])).toBe("demo");
    expect(firstWorkflow([])).toBeUndefined();
  });

  test("it offers the autonomy levels the workflow runs at, each with what it means; all three when it does not say", () => {
    expect(autonomyChoices(["L0", "L1"]).map((c) => c.value)).toEqual(["L0", "L1"]);
    expect(autonomyChoices(["L1", "L0"]).map((c) => c.value)).toEqual(["L0", "L1"]);
    expect(autonomyChoices(["L0"])).toEqual([
      { value: "L0", label: "L0", hint: "every approval waits for you" },
    ]);
    expect(autonomyChoices(undefined).map((c) => c.value)).toEqual(["L0", "L1", "L2"]);
    expect(autonomyChoices(undefined).every((c) => (c.hint ?? "").includes("approval"))).toBe(true);
  });
});
