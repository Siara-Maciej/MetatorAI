import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetatorError } from "@metator/core";
import { NodePtyTerminal } from "@metator/plugin-node";
import { FakeTerminal, interactiveHostContract, standInCli } from "@metator/testing";
import { ClaudeInteractiveHost } from "../src/claude-interactive-host.ts";

const task = (cwd: string, extra: Record<string, unknown> = {}) => ({
  agent: "session",
  prompt: "Add discount",
  cwd,
  projectRoot: cwd,
  runDir: join(cwd, ".metator/runs/20261102-mt-feature-a"),
  driven: true,
  ...extra,
});
const size = { cols: 80, rows: 24 };
const ID = "0b7a9c2e-3d4f-4a5b-8c6d-7e8f9a0b1c2d";

interactiveHostContract("ClaudeInteractiveHost", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "metator-claude-pty-"));
  const bin = standInCli(join(cwd, "bin"), "claude");
  return {
    host: new ClaudeInteractiveHost(new NodePtyTerminal(), bin),
    task: task(cwd),
    says: "args: Add discount --session-id",
    answer: { type: "ship it", echoes: "typed: ship it" },
  };
});

describe("ClaudeInteractiveHost", () => {
  test("starts `claude <task> --session-id <uuid>` in the worktree with the run directory added", async () => {
    const terminal = new FakeTerminal();
    const host = new ClaudeInteractiveHost(terminal, "claude", { PATH: "/bin" }, () => ID);
    const session = (await host.start(task("/work/wt", { dirs: ["/work/other"] }), size))._unsafeUnwrap();
    expect(session.sessionId).toBe(ID);
    expect(terminal.spawned[0]).toMatchObject({
      argv: [
        "claude",
        "Add discount",
        "--session-id",
        ID,
        "--add-dir",
        "/work/wt/.metator/runs/20261102-mt-feature-a",
        "--add-dir",
        "/work/other",
        "--permission-mode",
        "default",
      ],
      cwd: "/work/wt",
      env: {
        PATH: "/bin",
        METATOR_RUN: "20261102-mt-feature-a",
        METATOR_RUN_DIR: "/work/wt/.metator/runs/20261102-mt-feature-a",
        METATOR_DRIVEN: "1",
      },
      size,
    });
  });

  test("a new session gets a fresh UUID each time", async () => {
    const terminal = new FakeTerminal();
    const host = new ClaudeInteractiveHost(terminal);
    const a = (await host.start(task("/w"), size))._unsafeUnwrap();
    const b = (await host.start(task("/w"), size))._unsafeUnwrap();
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("the run's agent is passed when the repository has its Claude agent file", async () => {
    const root = mkdtempSync(join(tmpdir(), "metator-claude-agent-"));
    mkdirSync(join(root, ".claude/agents"), { recursive: true });
    writeFileSync(join(root, ".claude/agents/mt-implementer.md"), "---\nname: x\n---\n");
    const terminal = new FakeTerminal();
    await new ClaudeInteractiveHost(terminal, "claude", {}, () => ID).start(
      task(root, { agent: "mt-implementer" }),
      size,
    );
    expect(terminal.spawned[0]?.argv.slice(0, 6)).toEqual([
      "claude",
      "Add discount",
      "--session-id",
      ID,
      "--agent",
      "mt-implementer",
    ]);
  });

  test("a resume is `claude --resume <id>` without the task again", async () => {
    const terminal = new FakeTerminal();
    const again = (await new ClaudeInteractiveHost(terminal).resume(ID, task("/w"), size))._unsafeUnwrap();
    expect(again.sessionId).toBe(ID);
    expect(terminal.spawned[0]?.argv.slice(0, 4)).toEqual(["claude", "--resume", ID, "--add-dir"]);
  });

  test("a terminal that cannot spawn is the error, not a throw", async () => {
    const host = new ClaudeInteractiveHost(new FakeTerminal(new MetatorError("COMMAND_FAILED", "no pty")));
    expect((await host.start(task("/work"), size))._unsafeUnwrapErr().message).toBe("no pty");
  });
});
