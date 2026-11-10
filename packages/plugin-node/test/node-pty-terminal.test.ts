import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { exitOf, outputUntil } from "@metator/testing";
import { EXIT_WAIT_MS, NodePtyTerminal, ptyDone } from "../src/node-pty-terminal.ts";

describe("NodePtyTerminal", () => {
  test("a program in a real PTY: it sees a TTY, reads what is typed, resizes, exits with its code", async () => {
    const pty = new NodePtyTerminal()
      .spawn(["sh", "-c", 'test -t 0 && echo tty; read -r x; echo "got $x"; stty size; exit 4'], {
        cwd: tmpdir(),
        size: { cols: 100, rows: 30 },
      })
      ._unsafeUnwrap();
    expect(pty.pid).toBeGreaterThan(0);
    expect(await outputUntil(pty, "tty")).toContain("tty");
    pty.resize(60, 20);
    pty.write("abc\r");
    const out = await outputUntil(pty, "20 60");
    expect(out).toContain("got abc");
    expect(await exitOf(pty)).toBe(4);
  }, 20_000);

  test("an empty argv, and a program that is not there, are errors as values", async () => {
    const t = new NodePtyTerminal();
    expect(t.spawn([], { cwd: tmpdir() })._unsafeUnwrapErr().code).toBe("USAGE");
    const missing = t.spawn(["metator-definitely-missing-binary"], { cwd: tmpdir() });
    // node-pty may spawn the shell wrapper and fail at exec: either an error value, or a non-zero exit.
    if (missing.isOk()) expect(await exitOf(missing.value)).not.toBe(0);
    else expect(missing.error.code).toBe("COMMAND_FAILED");
  }, 20_000);

  test("kill ends the session", async () => {
    const pty = new NodePtyTerminal().spawn(["sleep", "30"], { cwd: tmpdir() })._unsafeUnwrap();
    pty.kill();
    expect(await exitOf(pty)).not.toBe(-1);
  }, 20_000);
});

describe("ptyDone", () => {
  test("output ended without an exit code yet: wait for it (it comes later under load), then give up", () => {
    expect(ptyDone({ endedAt: 1000, exit: undefined, exitedAt: 0, now: 1500 })).toBe(false);
    expect(ptyDone({ endedAt: 1000, exit: 0, exitedAt: 1600, now: 1600 })).toBe(true);
    expect(ptyDone({ endedAt: 1000, exit: undefined, exitedAt: 0, now: 1000 + EXIT_WAIT_MS + 1 })).toBe(true);
  });

  test("an exit code before the output ended: drain the last bytes a little before finishing", () => {
    expect(ptyDone({ endedAt: undefined, exit: 0, exitedAt: 1000, now: 1100 })).toBe(false);
    expect(ptyDone({ endedAt: undefined, exit: 0, exitedAt: 1000, now: 1300 })).toBe(true);
    expect(ptyDone({ endedAt: undefined, exit: undefined, exitedAt: 0, now: 99_999 })).toBe(false);
  });
});
