import { describe, expect, test } from "bun:test";
import { agentHostContract } from "../src/contracts/agent-host.contract.ts";
import { dataIsolatorContract } from "../src/contracts/data-isolator.contract.ts";
import { fileSystemContract } from "../src/contracts/file-system.contract.ts";
import { machineStateContract } from "../src/contracts/machine-state.contract.ts";
import { worktreeManagerContract } from "../src/contracts/worktree-manager.contract.ts";
import {
  FakeAgentHost,
  FakeDataIsolator,
  FakeWorktreeManager,
  FixedClock,
  InMemoryFileSystem,
  InMemoryMachineState,
  ScriptedProcessRunner,
} from "../src/fakes.ts";

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

worktreeManagerContract("FakeWorktreeManager", async () => {
  const manager = new FakeWorktreeManager();
  return { manager, makeDirty: async (path) => void manager.dirty.add(path) };
});

agentHostContract("FakeAgentHost", async () => ({
  host: new FakeAgentHost({ "mt-x": [{ text: "hello\nSTATUS: done" }] }),
  task: { agent: "mt-x", prompt: "p", cwd: "/w", projectRoot: "/w", runDir: "/w/.metator/runs/r" },
}));

dataIsolatorContract("FakeDataIsolator", async () => {
  const isolator = new FakeDataIsolator();
  const target = { host: "127.0.0.1", port: 5432, user: "postgres" };
  return {
    isolator,
    target,
    insert: async (db, value) => {
      isolator.server(target).get(db)?.push(value);
    },
    rows: async (db) => isolator.server(target).get(db) ?? [],
  };
});

machineStateContract("InMemoryMachineState", async () => ({
  state: new InMemoryMachineState(new Set(["/repo"])),
  existing: "/repo",
  missing: "/gone",
}));
