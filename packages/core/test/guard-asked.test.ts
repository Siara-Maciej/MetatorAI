import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { GuardAsked } from "../src/application/guard-asked.ts";

describe("GuardAsked: why the guard asked about a pane's command, for the card the host's prompt becomes", () => {
  const world = () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-11-22T00:06:50.000Z"));
    return { fs, clock, asked: new GuardAsked(fs, clock) };
  };
  const COMMIT =
    'git add src/server.ts && git commit -m "Log sku (debug)\n\nCo-Authored-By: Claude <noreply@anthropic.com>"';
  const WHY = "this commit holds debug changes: src/server.ts. Commit only when the person says so.";

  test("the reason is found by the pane and the command, however the screen spaces it; never by another pane or command", async () => {
    const w = world();
    (await w.asked.record("w1:p1", COMMIT, "ask", WHY))._unsafeUnwrap();
    expect(await w.asked.reasonFor("w1:p1", COMMIT)).toEqual({ decision: "ask", reason: WHY });
    // The command as read from the screen: its lines joined by other whitespace.
    expect(
      await w.asked.reasonFor(
        "w1:p1",
        'git add src/server.ts && git commit -m "Log sku (debug)\n Co-Authored-By: Claude <noreply@anthropic.com>"',
      ),
    ).toEqual({ decision: "ask", reason: WHY });
    expect(await w.asked.reasonFor("w1:p2", COMMIT)).toBeUndefined();
    expect(await w.asked.reasonFor("w1:p1", "git push")).toBeUndefined();
    expect(await w.asked.reasonFor("w1:p1", "")).toBeUndefined();
    // A versioned document; the command itself is kept as a hash only.
    const doc = JSON.parse((await w.fs.read(".metator/guard-asked/w1-p1.json"))._unsafeUnwrap());
    expect(doc).toMatchObject({ kind: "GuardAsked", schemaVersion: 1 });
    expect(JSON.stringify(doc)).not.toContain("git commit");
    expect(doc.asked[0]).toEqual({
      hash: doc.asked[0].hash,
      at: "2026-11-22T00:06:50.000Z",
      decision: "ask",
      reason: WHY,
    });
  });

  test("the last decision about a command counts; it is kept for a while, and only the last ones", async () => {
    const w = world();
    await w.asked.record("w1:p1", COMMIT, "ask", "first");
    await w.asked.record("w1:p1", COMMIT, "deny", "second");
    expect(await w.asked.reasonFor("w1:p1", COMMIT)).toEqual({ decision: "deny", reason: "second" });
    w.clock.advance(11 * 60_000);
    expect(await w.asked.reasonFor("w1:p1", COMMIT)).toBeUndefined();
    for (let i = 0; i < 25; i++) await w.asked.record("w1:p1", `cmd ${i}`, "ask", `why ${i}`);
    expect(await w.asked.reasonFor("w1:p1", "cmd 0")).toBeUndefined();
    expect(await w.asked.reasonFor("w1:p1", "cmd 24")).toEqual({ decision: "ask", reason: "why 24" });
    const doc = JSON.parse((await w.fs.read(".metator/guard-asked/w1-p1.json"))._unsafeUnwrap());
    expect(doc.asked).toHaveLength(20);
  });
});
