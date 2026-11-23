import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exitOf, outputUntil } from "@metator/testing";
import { EXIT_WAIT_MS, NodePtyTerminal, nativeDir, ptyDone } from "../src/node-pty-terminal.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

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
    // Ended by a signal (SIGHUP): 128 + 1, as a shell reports it, never a plain 0 that reads as done.
    expect(await exitOf(pty)).toBe(129);
  }, 20_000);
});

describe("NodePtyTerminal from a package folder (the desktop app's resources, ADR-0105)", () => {
  test("pty.node is the machine's build first, else the platform's prebuild, else none", () => {
    const has =
      (...files: string[]) =>
      (p: string) =>
        files.includes(p);
    const built = join("/p", "build", "Release");
    const prebuild = join("/p", "prebuilds", "darwin-arm64");
    expect(nativeDir("/p", "darwin", "arm64", has(join(built, "pty.node"), join(prebuild, "pty.node")))).toBe(
      built,
    );
    expect(nativeDir("/p", "darwin", "arm64", has(join(prebuild, "pty.node")))).toBe(prebuild);
    expect(nativeDir("/p", "darwin", "x64", has(join(prebuild, "pty.node")))).toBeUndefined();
  });

  test("a session runs on the pty.node of the folder given, and a folder without one says to reinstall", async () => {
    const given = mkdtempSync(join(tmpdir(), "metator-pty-pkg-"));
    dirs.push(given);
    const installed = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    const from = nativeDir(installed, process.platform, process.arch, (p) => Bun.file(p).size > 0) as string;
    mkdirSync(join(given, "build", "Release"), { recursive: true });
    cpSync(join(from, "pty.node"), join(given, "build", "Release", "pty.node"));
    const pty = new NodePtyTerminal(given)
      .spawn(["sh", "-c", "echo from-folder"], { cwd: tmpdir() })
      ._unsafeUnwrap();
    expect(await outputUntil(pty, "from-folder")).toContain("from-folder");
    expect(await exitOf(pty)).toBe(0);

    const empty = mkdtempSync(join(tmpdir(), "metator-pty-empty-"));
    dirs.push(empty);
    const none = new NodePtyTerminal(empty).spawn(["sh", "-c", "true"], { cwd: tmpdir() })._unsafeUnwrapErr();
    expect(none.message).toContain(empty);
    expect(none.hint).toContain("Reinstall the MetatorAI app");
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
