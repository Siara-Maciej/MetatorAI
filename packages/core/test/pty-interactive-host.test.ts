import { describe, expect, test } from "bun:test";
import { type AgentTask, err, MetatorError, ok, PtyInteractiveHost } from "@metator/core";
import { FakeTerminal } from "@metator/testing";

const task: AgentTask = {
  agent: "session",
  prompt: "Add discount",
  cwd: "/work/wt",
  projectRoot: "/work",
  runDir: "/work/.metator/runs/r1",
};
const size = { cols: 100, rows: 30 };

describe("PtyInteractiveHost", () => {
  test("a start spawns the launch's command line in the task's directory, at the given size", async () => {
    const terminal = new FakeTerminal();
    const host = new PtyInteractiveHost(terminal, {
      id: "cli",
      env: (t) => ({ RUN: t.runDir }),
      launch: async (t, resume) => ok({ argv: ["cli", t.prompt, String(resume)], sessionId: "s-1" }),
    });
    const session = (await host.start(task, size))._unsafeUnwrap();
    expect(host.id).toBe("cli");
    expect(session.sessionId).toBe("s-1");
    expect(session.pty).toBe(terminal.spawned[0]?.pty as never);
    expect(terminal.spawned[0]).toMatchObject({
      argv: ["cli", "Add discount", "undefined"],
      cwd: "/work/wt",
      env: { RUN: "/work/.metator/runs/r1" },
      size,
    });
  });

  test("a resume hands the session id to the launch and reports the id the launch names", async () => {
    const terminal = new FakeTerminal();
    const host = new PtyInteractiveHost(terminal, {
      id: "cli",
      launch: async (_t, resume) =>
        ok({ argv: ["cli", "--resume", String(resume)], sessionId: `${resume}!` }),
    });
    const session = (await host.resume("s-7", task, size))._unsafeUnwrap();
    expect(session.sessionId).toBe("s-7!");
    expect(terminal.spawned[0]?.argv).toEqual(["cli", "--resume", "s-7"]);
  });

  test("a host without an environment of its own passes none to the terminal", async () => {
    const terminal = new FakeTerminal();
    const host = new PtyInteractiveHost(terminal, {
      id: "cli",
      launch: async () => ok({ argv: ["cli"], sessionId: "s" }),
    });
    await host.start(task, size);
    expect("env" in (terminal.spawned[0] ?? {})).toBe(false);
  });

  test("a launch that fails is the error and nothing is spawned", async () => {
    const terminal = new FakeTerminal();
    const host = new PtyInteractiveHost(terminal, {
      id: "cli",
      launch: async () => err(MetatorError.usage("no entry")),
    });
    expect((await host.start(task, size))._unsafeUnwrapErr().message).toBe("no entry");
    expect(terminal.spawned).toEqual([]);
  });

  test("a terminal that cannot spawn is the error, not a throw", async () => {
    const host = new PtyInteractiveHost(new FakeTerminal(new MetatorError("COMMAND_FAILED", "no pty")), {
      id: "cli",
      launch: async () => ok({ argv: ["cli"], sessionId: "s" }),
    });
    expect((await host.resume("s", task, size))._unsafeUnwrapErr().message).toBe("no pty");
  });
});
