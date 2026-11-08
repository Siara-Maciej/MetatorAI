import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetatorError } from "@metator/core";
import { NodePtyTerminal } from "@metator/plugin-node";
import { FakeTerminal, interactiveHostContract, standInCli } from "@metator/testing";
import { CONTINUE, CopilotInteractiveHost } from "../src/copilot-interactive-host.ts";

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

interactiveHostContract("CopilotInteractiveHost", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "metator-copilot-pty-"));
  const bin = standInCli(join(cwd, "bin"), "copilot");
  return {
    host: new CopilotInteractiveHost(new NodePtyTerminal(), bin),
    task: task(cwd),
    says: "args: -i Add discount",
    answer: { type: "ship it", echoes: "typed: ship it" },
  };
});

describe("CopilotInteractiveHost", () => {
  test("starts `copilot -i <task>` in the worktree with the run directory added and git push denied", async () => {
    const terminal = new FakeTerminal();
    const host = new CopilotInteractiveHost(terminal, "copilot", { PATH: "/bin", HOME: undefined });
    const cwd = "/work/wt";
    const session = (await host.start(task(cwd, { dirs: ["/work/other"] }), size))._unsafeUnwrap();
    expect(session.sessionId).toBe(CONTINUE);
    expect(terminal.spawned[0]).toMatchObject({
      argv: [
        "copilot",
        "-i",
        "Add discount",
        "--add-dir",
        "/work/wt/.metator/runs/20261102-mt-feature-a",
        "--add-dir",
        "/work/other",
        "--deny-tool",
        "shell(git push)",
      ],
      cwd,
      env: {
        PATH: "/bin",
        METATOR_RUN: "20261102-mt-feature-a",
        METATOR_RUN_DIR: "/work/wt/.metator/runs/20261102-mt-feature-a",
        METATOR_DRIVEN: "1",
      },
      size,
    });
    expect(terminal.spawned[0]?.env).not.toHaveProperty("HOME");
  });

  test("the run's agent is passed when the repository has its Copilot agent file", async () => {
    const root = mkdtempSync(join(tmpdir(), "metator-copilot-agent-"));
    mkdirSync(join(root, ".github/agents"), { recursive: true });
    writeFileSync(join(root, ".github/agents/mt-implementer.agent.md"), "---\nname: x\n---\n");
    const terminal = new FakeTerminal();
    await new CopilotInteractiveHost(terminal).start(task(root, { agent: "mt-implementer" }), size);
    expect(terminal.spawned[0]?.argv.slice(0, 5)).toEqual([
      "copilot",
      "-i",
      "Add discount",
      "--agent",
      "mt-implementer",
    ]);
  });

  test("a resume continues the directory's last session, or the given one when it is a real id", async () => {
    const terminal = new FakeTerminal();
    const host = new CopilotInteractiveHost(terminal);
    const t = task("/work/wt", { driven: false });
    const last = (await host.resume(CONTINUE, t, size))._unsafeUnwrap();
    const id = "0b7a9c2e-3d4f-4a5b-8c6d-7e8f9a0b1c2d";
    const given = (await host.resume(id, t, size))._unsafeUnwrap();
    expect([last.sessionId, given.sessionId]).toEqual([CONTINUE, id]);
    expect(terminal.spawned.map((s) => s.argv.slice(1, 3))).toEqual([
      ["--continue", "--add-dir"],
      ["--resume", id],
    ]);
    expect(terminal.spawned[0]?.env).not.toHaveProperty("METATOR_DRIVEN");
  });

  test("a terminal that cannot spawn is the error, not a throw", async () => {
    const host = new CopilotInteractiveHost(new FakeTerminal(new MetatorError("COMMAND_FAILED", "no pty")));
    expect((await host.start(task("/work"), size))._unsafeUnwrapErr().message).toBe("no pty");
  });
});

describe("CopilotInteractiveHost.launch", () => {
  test("the same command line start runs, with only the run's variables, and without spawning", async () => {
    const terminal = new FakeTerminal();
    const host = new CopilotInteractiveHost(terminal, "copilot", { PATH: "/bin" });
    const launch = (await host.launch(task("/work/wt")))._unsafeUnwrap();
    expect(launch).toEqual({
      argv: [
        "copilot",
        "-i",
        "Add discount",
        "--add-dir",
        "/work/wt/.metator/runs/20261102-mt-feature-a",
        "--deny-tool",
        "shell(git push)",
      ],
      sessionId: CONTINUE,
      env: {
        METATOR_RUN: "20261102-mt-feature-a",
        METATOR_RUN_DIR: "/work/wt/.metator/runs/20261102-mt-feature-a",
        METATOR_DRIVEN: "1",
      },
    });
    expect(terminal.spawned).toEqual([]);
    const id = "0b7a9c2e-3d4f-4a5b-8c6d-7e8f9a0b1c2d";
    expect((await host.launch(task("/w"), id))._unsafeUnwrap().argv.slice(1, 3)).toEqual(["--resume", id]);
    expect((await host.launch(task("/w"), CONTINUE))._unsafeUnwrap().argv[1]).toBe("--continue");
  });
});
