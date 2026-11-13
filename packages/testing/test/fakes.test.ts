import { describe, expect, test } from "bun:test";
import { agentHostContract } from "../src/contracts/agent-host.contract.ts";
import { dataIsolatorContract } from "../src/contracts/data-isolator.contract.ts";
import { fileSystemContract } from "../src/contracts/file-system.contract.ts";
import { interactiveHostContract } from "../src/contracts/interactive-host.contract.ts";
import { machineStateContract } from "../src/contracts/machine-state.contract.ts";
import { ruleEngineContract } from "../src/contracts/rule-engine.contract.ts";
import { treeCopierContract } from "../src/contracts/tree-copier.contract.ts";
import { vcsContract } from "../src/contracts/vcs.contract.ts";
import { worktreeManagerContract } from "../src/contracts/worktree-manager.contract.ts";
import {
  FakeAgentHost,
  FakeDataIsolator,
  FakeInteractiveHost,
  FakeRuleEngine,
  FakeTreeCopier,
  FakeVcs,
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

vcsContract("FakeVcs", async () => ({
  vcs: new FakeVcs(["a.ts", "b.ts", "c.ts"], ["a.ts", "c.ts"], "git@example.com:shop/web.git"),
  base: "main",
  remote: "git@example.com:shop/web.git",
  outside: new FakeVcs("not-a-repo"),
}));

ruleEngineContract("FakeRuleEngine", async () => ({
  engine: new FakeRuleEngine(
    "fake",
    [
      { id: "no-eval", source: "rules/no-eval.yml", hasTest: false },
      { id: "no-var", source: "rules/no-var.yml", hasTest: true },
    ],
    [{ source: "fake", toolRuleId: "no-var", file: "src/a.ts", severity: "error", message: "no var" }],
  ),
  bare: new FakeRuleEngine("fake", []),
  finding: { file: "src/a.ts", toolRuleId: "no-var" },
  clean: "src/clean.ts",
}));

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

// The fake's sessions say nothing on their own: the test plays the session (it speaks, echoes
// what is typed and exits), the way tests of the host's consumers drive a FakePty.
interactiveHostContract("FakeInteractiveHost", async () => ({
  host: new FakeInteractiveHost("fake", (pty) => {
    setTimeout(() => pty.print("ready\n"), 5);
    const typed = setInterval(() => {
      if (pty.killed) clearInterval(typed);
      if (pty.typed.length === 0) return;
      clearInterval(typed);
      pty.print(`typed: ${pty.typed.join("")}`);
      setTimeout(() => pty.exit(0), 5);
    }, 5);
  }),
  task: { agent: "session", prompt: "p", cwd: "/w", projectRoot: "/w", runDir: "/w/.metator/runs/r" },
  says: "ready",
  answer: { type: "ship it", echoes: "typed: ship it" },
}));

treeCopierContract(
  "FakeTreeCopier",
  () => new FakeTreeCopier(),
  async () => ({
    copier: new FakeTreeCopier(new Set(["/repo/node_modules"])),
    source: "/repo/node_modules",
    target: "/wt/node_modules",
    missing: "/repo/none",
  }),
);
