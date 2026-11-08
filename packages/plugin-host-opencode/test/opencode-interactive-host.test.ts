import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetatorError } from "@metator/core";
import { NodePtyTerminal } from "@metator/plugin-node";
import { FakeTerminal, interactiveHostContract, standInCli } from "@metator/testing";
import { CONTINUE, OpencodeInteractiveHost } from "../src/opencode-interactive-host.ts";

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

interactiveHostContract("OpencodeInteractiveHost", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "metator-opencode-pty-"));
  const bin = standInCli(join(cwd, "bin"), "opencode");
  return {
    host: new OpencodeInteractiveHost(new NodePtyTerminal(), bin),
    task: task(cwd),
    says: `args: ${cwd} --prompt Add discount`,
    answer: { type: "ship it", echoes: "typed: ship it" },
  };
});

describe("OpencodeInteractiveHost", () => {
  test("starts `opencode <worktree> --prompt <task>` with the run in the environment", async () => {
    const terminal = new FakeTerminal();
    const host = new OpencodeInteractiveHost(terminal, "opencode", { PATH: "/bin" });
    const session = (await host.start(task("/work/wt"), size))._unsafeUnwrap();
    expect(session.sessionId).toBe(CONTINUE);
    expect(terminal.spawned[0]).toMatchObject({
      argv: ["opencode", "/work/wt", "--prompt", "Add discount"],
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

  test("the run's agent is passed when the repository defines it for OpenCode", async () => {
    const root = mkdtempSync(join(tmpdir(), "metator-opencode-agent-"));
    mkdirSync(join(root, ".opencode/agent"), { recursive: true });
    writeFileSync(join(root, ".opencode/agent/mt-implementer.md"), "---\nmode: subagent\n---\n");
    const terminal = new FakeTerminal();
    await new OpencodeInteractiveHost(terminal).start(task(root, { agent: "mt-implementer" }), size);
    expect(terminal.spawned[0]?.argv).toEqual([
      "opencode",
      root,
      "--prompt",
      "Add discount",
      "--agent",
      "mt-implementer",
    ]);
  });

  test("a resume continues the worktree's last session, or the given `ses_` one", async () => {
    const terminal = new FakeTerminal();
    const host = new OpencodeInteractiveHost(terminal);
    const t = task("/work/wt");
    const last = (await host.resume(CONTINUE, t, size))._unsafeUnwrap();
    const given = (await host.resume("ses_abc123", t, size))._unsafeUnwrap();
    expect([last.sessionId, given.sessionId]).toEqual([CONTINUE, "ses_abc123"]);
    expect(terminal.spawned.map((s) => s.argv)).toEqual([
      ["opencode", "/work/wt", "--continue"],
      ["opencode", "/work/wt", "--session", "ses_abc123"],
    ]);
  });

  test("a terminal that cannot spawn is the error, not a throw", async () => {
    const host = new OpencodeInteractiveHost(new FakeTerminal(new MetatorError("COMMAND_FAILED", "no pty")));
    expect((await host.start(task("/work"), size))._unsafeUnwrapErr().message).toBe("no pty");
  });
});
