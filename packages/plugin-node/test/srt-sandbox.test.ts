import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok, sandboxSettings } from "@metator/core";
import { FakeTerminal, sandboxUnheldHere } from "@metator/testing";
import { NodePtyTerminal } from "../src/node-pty-terminal.ts";
import { descendants, SandboxedTerminal, SrtSandbox, srtCli } from "../src/srt-sandbox.ts";

const unheld = sandboxUnheldHere();
if (unheld) console.warn(`srt-sandbox.test.ts: the tests in a real sandbox are skipped here: ${unheld}`);

const dirs: string[] = [];
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "metator-srt-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const settings = sandboxSettings(
  { denyRead: ["~/.ssh"], allowWrite: [], allowedDomains: [] },
  { domains: ["api.githubcopilot.com"], writable: ["~/.copilot"] },
  { root: "/repo", cwd: "/repo", temp: "/tmp" },
);

describe("SrtSandbox: a host session's command line inside the sandbox runtime", () => {
  test("srt with the settings file, then the program, told it runs in the sandbox", async () => {
    const dir = await temp();
    const argv = new SrtSandbox(dir, "/usr/bin/bun", () => "/x/srt/cli.js")
      .command(["copilot", "-i", "say hi"], settings)
      ._unsafeUnwrap();
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/bun", "/x/srt/cli.js", "--settings"]);
    expect(argv.slice(4)).toEqual(["--", "env", "METATOR_SANDBOX=1", "copilot", "-i", "say hi"]);
    // The file is named by what it holds, outside the session's own reach, and holds the settings.
    const file = argv[3] as string;
    expect(file.startsWith(dir)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(settings);
    const again = new SrtSandbox(dir, "/usr/bin/bun", () => "/x/srt/cli.js").command(["claude"], settings);
    expect(again._unsafeUnwrap()[3]).toBe(file);
    // A session that wrote over the file does not change the next start: it is written again.
    writeFileSync(file, "{}");
    new SrtSandbox(dir, "/usr/bin/bun", () => "/x/srt/cli.js").command(["claude"], settings);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(settings);
  });

  test("nothing to start, or no runtime to start it with, is an error and starts nothing", async () => {
    const dir = await temp();
    expect(new SrtSandbox(dir).command([], settings)._unsafeUnwrapErr().code).toBe("USAGE");
    const missing = new SrtSandbox(dir, "bun", () => {
      throw new Error("Cannot find module '@anthropic-ai/sandbox-runtime/package.json'");
    }).command(["claude"], settings);
    expect(missing._unsafeUnwrapErr().message).toContain("cannot prepare the sandbox");
  });

  test("the runtime's command line ships with MetatorAI", () => {
    expect(srtCli()).toMatch(/@anthropic-ai[\\/]sandbox-runtime[\\/]dist[\\/]cli\.js$/);
  });
});

describe("descendants: the processes below one, from /proc", () => {
  test("children and their children, whatever their names hold", async () => {
    const proc = await temp();
    const stat = (pid: number, ppid: number, name = "sh") => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (${name}) S ${ppid} 1 1 0 -1\n`);
    };
    stat(10, 1);
    stat(11, 10, "bwrap");
    stat(12, 11, "copilot (cli) x");
    stat(13, 12);
    stat(20, 1);
    mkdirSync(join(proc, "self"));
    expect(descendants(10, proc).sort()).toEqual([11, 12, 13]);
    expect(descendants(13, proc)).toEqual([]);
    expect(descendants(10, join(proc, "nowhere"))).toEqual([]);
  });
});

describe("SandboxedTerminal: sessions start through the launch", () => {
  test("sandboxed: the wrapped command line runs; a resize is SIGWINCH and a kill SIGHUP below the sandbox", () => {
    const inner = new FakeTerminal();
    const signalled: number[] = [];
    const terminal = new SandboxedTerminal(
      inner,
      (argv) => ok({ argv: ["srt", "--", ...argv], sandboxed: true }),
      (pid) => {
        signalled.push(pid);
        return [];
      },
    );
    const pty = terminal
      .spawn(["claude", "hi"], { cwd: "/repo", size: { cols: 80, rows: 24 } })
      ._unsafeUnwrap();
    expect(inner.spawned[0]?.argv).toEqual(["srt", "--", "claude", "hi"]);
    expect(inner.spawned[0]?.cwd).toBe("/repo");
    pty.resize(100, 30);
    expect(inner.spawned[0]?.pty.sizes).toEqual([{ cols: 100, rows: 30 }]);
    pty.kill();
    expect(inner.spawned[0]?.pty.killed).toBe(true);
    expect(signalled).toEqual([pty.pid, pty.pid]);
  });

  test("not sandboxed: the program and its handle as they are; a launch that fails spawns nothing", () => {
    const inner = new FakeTerminal();
    const plain = new SandboxedTerminal(
      inner,
      (argv) => ok({ argv, sandboxed: false }),
      () => {
        throw new Error("never asked");
      },
    );
    const pty = plain.spawn(["copilot"], { cwd: "/r" })._unsafeUnwrap();
    expect(pty).toBe(inner.spawned[0]?.pty as never);
    pty.resize(90, 20);
    const failing = new SandboxedTerminal(inner, () => err(new MetatorError("COMMAND_FAILED", "no srt")));
    expect(failing.spawn(["copilot"], { cwd: "/r" })._unsafeUnwrapErr().message).toBe("no srt");
    expect(inner.spawned).toHaveLength(1);
  });
});

describe("in a real sandbox (bubblewrap, a real PTY)", () => {
  test.skipIf(unheld !== undefined)(
    "the session is held, knows it is, and hears its terminal's new size",
    async () => {
      const dir = await temp();
      const cache = await temp();
      writeFileSync(join(dir, ".env"), "TOKEN=x\n");
      const real = new SrtSandbox(cache);
      const terminal = new SandboxedTerminal(new NodePtyTerminal(), (argv, cwd) =>
        real
          .command(
            argv,
            sandboxSettings(
              { denyRead: [], allowWrite: [], allowedDomains: [] },
              { domains: [], writable: [] },
              { root: dir, cwd, temp: dir },
            ),
          )
          .map((wrapped) => ({ argv: wrapped, sandboxed: true })),
      );
      const pty = terminal
        .spawn(
          [
            "sh",
            "-c",
            'echo "in=$METATOR_SANDBOX"; cat .env; trap "stty size; exit 0" WINCH; while :; do sleep 0.1; done',
          ],
          { cwd: dir, size: { cols: 80, rows: 24 } },
        )
        ._unsafeUnwrap();
      let out = "";
      pty.onData((d) => {
        out += d;
      });
      const exited = new Promise<number>((resolve) => pty.onExit(resolve));
      for (let i = 0; i < 50 && !out.includes("Permission denied"); i++) await Bun.sleep(100);
      pty.resize(120, 40);
      const code = await Promise.race([exited, Bun.sleep(10_000).then(() => -1)]);
      if (code === -1) pty.kill();
      expect(out).toContain("in=1");
      expect(out).toContain("Permission denied");
      expect(out).toContain("40 120");
    },
    30_000,
  );
});
