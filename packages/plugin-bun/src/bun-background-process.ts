import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type BackgroundProcess, err, MetatorError, ok, type Result, type Timer } from "@metator/core";

/** BackgroundProcess on Bun.spawn: detached, output appended to a log file, outlives its parent. */
export class BunBackgroundProcess implements BackgroundProcess {
  async start(argv: readonly string[], cwd: string, logFile: string): Promise<Result<number, MetatorError>> {
    try {
      await mkdir(dirname(logFile), { recursive: true });
      const log = Bun.file(logFile);
      const proc = Bun.spawn([...argv], { cwd, stdout: log, stderr: log, stdin: "ignore", detached: true });
      proc.unref();
      return ok(proc.pid);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `cannot start ${argv[0]}: ${(e as Error).message}`));
    }
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async stop(pid: number): Promise<Result<void, MetatorError>> {
    if (!this.isAlive(pid)) return ok(undefined);
    try {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 50 && this.isAlive(pid); i++) await Bun.sleep(100);
      if (this.isAlive(pid)) process.kill(pid, "SIGKILL");
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
