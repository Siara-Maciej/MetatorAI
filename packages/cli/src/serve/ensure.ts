import { join } from "node:path";
import { type DaemonInfo, err, MetatorError, ok, type Result } from "@metator/core";

/** What `serve --ensure` needs from the machine; the command gives the real ones, a test its own. */
export interface EnsureDeps {
  /** The live daemon a directory's `.metator/daemon.json` names, if any. */
  live(root: string): DaemonInfo | undefined;
  /** Starts a process that outlives this command, its output in `logFile`; its pid, or undefined. */
  start(argv: readonly string[], cwd: string, logFile: string): Promise<number | undefined>;
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  /** The last lines of the daemon's log. */
  log(logFile: string): Promise<string>;
}

export interface EnsureRequest {
  /** The directories the daemon serves (one repository, or each repository of a folder). */
  readonly roots: readonly string[];
  /** The command that runs the daemon in the foreground (this program with `serve …`). */
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export type Ensured = DaemonInfo & { readonly started: boolean };

const STEP_MS = 100;

/**
 * `metator serve --ensure` (ADR-0087): the address of the daemon that serves these directories,
 * starting one in the background when none does. What the desktop app runs when it opens, so a
 * person never starts `metator serve` by hand; a second call never starts a second daemon.
 */
export async function ensureDaemon(
  request: EnsureRequest,
  deps: EnsureDeps,
): Promise<Result<Ensured, MetatorError>> {
  const root = request.roots[0] as string;
  const serving = request.roots.map((r) => deps.live(r)).find((d) => d !== undefined);
  if (serving) return ok({ ...serving, started: false });

  const logFile = join(root, ".metator", "daemon.log");
  const pid = await deps.start(request.argv, root, logFile);
  if (pid === undefined)
    return err(new MetatorError("COMMAND_FAILED", `cannot start the daemon: ${request.argv.join(" ")}`));
  for (let waited = 0; ; waited += STEP_MS) {
    const daemon = deps.live(root);
    if (daemon) return ok({ ...daemon, started: true });
    if (!deps.alive(pid))
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `the daemon ended before it listened:\n${await deps.log(logFile)}`,
          { hint: `Its output is in ${logFile}.` },
        ),
      );
    if (waited >= request.timeoutMs)
      return err(
        new MetatorError("COMMAND_FAILED", `the daemon did not start within ${request.timeoutMs} ms`, {
          hint: `Its output is in ${logFile}; it may still be starting (pid ${pid}).`,
        }),
      );
    await deps.sleep(STEP_MS);
  }
}
