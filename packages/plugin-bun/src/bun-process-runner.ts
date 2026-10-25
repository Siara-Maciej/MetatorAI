import type { ProcessResult, ProcessRunner, ResolvedCommand } from "@metator/core";

/**
 * ProcessRunner on Bun.spawn. Never throws for process failures: a missing binary is exit
 * code 127 and a timeout is 124 (coreutils convention), both with a message on stderr.
 */
export class BunProcessRunner implements ProcessRunner {
  async run(command: ResolvedCommand, options: { readonly timeoutMs?: number } = {}): Promise<ProcessResult> {
    const started = performance.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([...command.argv], {
        cwd: command.cwd,
        env: { ...process.env, ...command.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: (e as Error).message,
        durationMs: performance.now() - started,
      };
    }

    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
          }, options.timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);
    const durationMs = performance.now() - started;
    if (timedOut)
      return {
        exitCode: 124,
        stdout,
        stderr: `${stderr}timed out after ${options.timeoutMs} ms`,
        durationMs,
      };
    return { exitCode, stdout, stderr, durationMs };
  }
}
