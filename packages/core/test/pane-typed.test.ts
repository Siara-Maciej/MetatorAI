import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { PaneTyped } from "../src/application/pane-typed.ts";

describe("PaneTyped: what MetatorAI itself typed into a pane, so a host's hook that reports it is not taken for the person", () => {
  const world = () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-11-21T10:00:00.000Z"));
    return { fs, clock, typed: new PaneTyped(fs, clock) };
  };

  test("a line is known by its pane and its words, however the host spaces it; never by another pane", async () => {
    const w = world();
    await w.typed.record(
      "w2:p3",
      "[metator] From the person, through the main chat: Use half-even",
      "metator",
    );
    await w.typed.record("w2:p3", "half-even", "answer");
    expect(await w.typed.by("w2:p3", "[metator] From the person, through the main chat: Use half-even")).toBe(
      "metator",
    );
    // A host hands the prompt over with its own spacing, a line break, a control character.
    expect(
      await w.typed.by("w2:p3", "  [metator] From the person,  through the main chat:\nUse half-even \x1b"),
    ).toBe("metator");
    expect(await w.typed.by("w2:p3", "half-even")).toBe("answer");
    expect(await w.typed.by("w2:p3", "half-up")).toBeUndefined();
    expect(await w.typed.by("w2:p4", "half-even")).toBeUndefined();
    expect(await w.typed.by("w2:p3", "")).toBeUndefined();
    // Kept as hashes with their time, in a versioned document: the words themselves are not stored.
    const doc = JSON.parse((await w.fs.read(".metator/typed/w2-p3.json"))._unsafeUnwrap());
    expect(doc).toMatchObject({ kind: "PaneTyped", schemaVersion: 1 });
    expect(doc.lines).toHaveLength(2);
    expect(JSON.stringify(doc)).not.toContain("half-even");
    expect(doc.lines[0]).toEqual({ hash: doc.lines[0].hash, at: "2026-11-21T10:00:00.000Z", by: "metator" });
  });

  test("only for a while, and only the last lines: what the person types later with the same words is theirs", async () => {
    const w = world();
    await w.typed.record("w1:p1", "go on", "metator");
    w.clock.advance(29 * 60_000);
    expect(await w.typed.by("w1:p1", "go on")).toBe("metator");
    w.clock.advance(2 * 60_000);
    expect(await w.typed.by("w1:p1", "go on")).toBeUndefined();
    for (let i = 0; i < 45; i++) await w.typed.record("w1:p1", `line ${i}`, "metator");
    expect([await w.typed.by("w1:p1", "line 0"), await w.typed.by("w1:p1", "line 44")]).toEqual([
      undefined,
      "metator",
    ]);
  });
});
