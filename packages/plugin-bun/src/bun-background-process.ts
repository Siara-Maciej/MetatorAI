import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type BackgroundProcess, err, MetatorError, ok, type Result, type Timer } from "@metator/core";

/** BackgroundProcess on Bun.spawn: detached, output appended to a log file, outlives its parent. */
export class BunBackgroundProcess implements BackgroundProcess {
  async start(
    argv: readonly string[],
    cwd: string,
    logFile: string,
    env: Readonly<Record<string, string>> = {},
  ): Promise<Result<number, MetatorError>> {
    try {
      await mkdir(dirname(logFile), { recursive: true });
      const log = Bun.file(logFile);
      const proc = Bun.spawn([...argv], {
        cwd,
        env: { ...process.env, ...env },
        stdout: log,
        stderr: log,
        stdin: "ignore",
        detached: true,
      });
      proc.unref();
      return ok(proc.pid);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `cannot start ${argv[0]}: ${(e as Error).message}`));
    }
  }

  /**
   * A detached process leads its own process group: it is alive while anything it started is,
   * since `sh -c "bun server.ts"` keeps serving after the shell itself is gone.
   */
  isAlive(pid: number): boolean {
    if (!signal(-pid, 0) && !signal(pid, 0)) return false;
    // Where /proc exists, an exited process nobody reaped yet (a zombie) is not alive.
    return groupStates(pid)?.some((state) => state !== "Z") ?? true;
  }

  async readLog(logFile: string, lines: number): Promise<string> {
    const file = Bun.file(logFile);
    if (!(await file.exists())) return "";
    return (await file.text())
      .split("\n")
      .slice(-lines - 1)
      .join("\n")
      .trimEnd();
  }

  async stop(pid: number): Promise<Result<void, MetatorError>> {
    if (!this.isAlive(pid)) return ok(undefined);
    try {
      // The whole group: the shell and every process it started.
      if (!signal(-pid, "SIGTERM")) process.kill(pid, "SIGTERM");
      for (let i = 0; i < 50 && this.isAlive(pid); i++) await Bun.sleep(100);
      if (this.isAlive(pid) && !signal(-pid, "SIGKILL")) process.kill(pid, "SIGKILL");
      return ok(undefined);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `cannot stop process ${pid}: ${(e as Error).message}`));
    }
  }
}

/** Timer on Bun.sleep. */
export class BunTimer implements Timer {
  sleep(ms: number): Promise<void> {
    return Bun.sleep(ms);
  }
}

/** Sends a signal; false when no such process (or group) exists. */
function signal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * The states of the processes in a process group (Linux /proc), undefined where there is no /proc.
 * A stat line is `pid (comm) state ppid pgrp …`; comm may hold spaces and parentheses.
 */
function groupStates(pgid: number): string[] | undefined {
  if (!existsSync("/proc/self/stat")) return undefined;
  const states: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) === pgid || Number(entry) === pgid) states.push(state ?? "");
    } catch {
      // The process ended while we looked.
    }
  }
  return states;
}
