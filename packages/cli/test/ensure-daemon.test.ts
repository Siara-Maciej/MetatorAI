import { describe, expect, test } from "bun:test";
import { type EnsureDeps, ensureDaemon } from "../src/serve/ensure.ts";

const info = (pid: number) => ({
  url: `http://127.0.0.1:${4000 + pid}`,
  pid,
  startedAt: "2026-11-15T10:00:00.000Z",
});

/** A world where a started daemon writes its file after `after` looks. */
function world(opts: { live?: number; after?: number; dies?: boolean; fails?: boolean } = {}) {
  const calls: string[] = [];
  let looks = 0;
  let started = false;
  const deps: EnsureDeps = {
    live: () => {
      if (opts.live) return info(opts.live);
      if (!started) return undefined;
      looks += 1;
      return !opts.dies && looks > (opts.after ?? 0) ? info(77) : undefined;
    },
    start: async (argv, cwd, logFile) => {
      calls.push(`start ${argv.join(" ")} @${cwd} >${logFile}`);
      if (opts.fails) return undefined;
      started = true;
      return 77;
    },
    alive: () => !opts.dies,
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
    },
    log: async () => "error: port 4310 in use",
  };
  return { deps, calls };
}
const request = { roots: ["/repo"], argv: ["bun", "main.ts", "serve", "--port", "0"], timeoutMs: 1000 };

describe("ensureDaemon (serve --ensure)", () => {
  test("a daemon that already serves the directory is the answer: nothing is started", async () => {
    const { deps, calls } = world({ live: 5 });
    expect((await ensureDaemon(request, deps))._unsafeUnwrap()).toEqual({ ...info(5), started: false });
    expect(calls).toEqual([]);
  });

  test("without one, the daemon is started detached and awaited until its file names a live process", async () => {
    const { deps, calls } = world({ after: 2 });
    expect((await ensureDaemon(request, deps))._unsafeUnwrap()).toEqual({ ...info(77), started: true });
    expect(calls[0]).toBe("start bun main.ts serve --port 0 @/repo >/repo/.metator/daemon.log");
    expect(calls.filter((c) => c.startsWith("sleep"))).toHaveLength(2);
  });

  test("a daemon that ends before it listens is an error with the last lines of its log", async () => {
    const { deps } = world({ dies: true });
    const error = (await ensureDaemon(request, deps))._unsafeUnwrapErr();
    expect([error.code, error.message]).toEqual([
      "COMMAND_FAILED",
      expect.stringContaining("port 4310 in use"),
    ]);
  });

  test("a daemon that never writes its file is given up on after the timeout, not forever", async () => {
    const { deps, calls } = world({ after: 1_000_000 });
    const error = (await ensureDaemon({ ...request, timeoutMs: 300 }, deps))._unsafeUnwrapErr();
    expect(error.message).toContain("did not start within 300 ms");
    expect(calls.filter((c) => c.startsWith("sleep")).length).toBe(3);
  });

  test("a process that cannot be started is an error", async () => {
    const { deps } = world({ fails: true });
    expect((await ensureDaemon(request, deps)).isErr()).toBe(true);
  });
});
