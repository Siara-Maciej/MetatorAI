import { describe, expect, test } from "bun:test";
import { fileSystemContract } from "../src/contracts/file-system.contract.ts";
import { FixedClock, InMemoryFileSystem, ScriptedProcessRunner } from "../src/fakes.ts";

fileSystemContract("InMemoryFileSystem", async (files) => new InMemoryFileSystem(files));

describe("ScriptedProcessRunner", () => {
  test("replays the first response whose argv prefix matches and records calls", async () => {
    const runner = new ScriptedProcessRunner([
      { argvPrefix: ["git", "diff"], result: { stdout: "a.ts\n" } },
      { argvPrefix: ["git"], result: { exitCode: 128 } },
    ]);
    expect((await runner.run({ argv: ["git", "diff", "--name-only"], cwd: "." })).stdout).toBe("a.ts\n");
    expect((await runner.run({ argv: ["git", "status"], cwd: "." })).exitCode).toBe(128);
    expect(runner.calls.map((c) => c.argv[1])).toEqual(["diff", "status"]);
  });

  test("unscripted commands fail loudly with exit code 127", async () => {
    const result = await new ScriptedProcessRunner().run({ argv: ["rm", "-rf", "/"], cwd: "." });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("unscripted command");
  });
});

describe("FixedClock", () => {
  test("only moves when told to", () => {
    const clock = new FixedClock(new Date("2026-05-01T10:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-05-01T10:00:00.000Z");
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2026-05-01T10:00:01.500Z");
  });
});
