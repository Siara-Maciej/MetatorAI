import type { ProcessResult, ProcessRunner, ResolvedCommand } from "@metator/core";

const POSIX = process.platform !== "win32";
/** How long a timed-out process's output may still drain before the read gives up on it. */
const DRAIN_MS = 200;

/**
 * ProcessRunner on Bun.spawn. Never throws for process failures: a missing binary is exit
 * code 127 and a timeout is 124 (coreutils convention), both with a message on stderr.
 *
 * With a timeout the process leads its own process group (POSIX), so a timeout kills what it
 * started too, and the read stops waiting for output a survivor may hold open. On Windows only
 * the process itself is killed.
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
        // Only a run that can time out needs its own group: one that cannot keeps the terminal's.
        detached: POSIX && options.timeoutMs !== undefined,
      });
    } catch (e) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: (e as Error).message,
        durationMs: performance.now() - started,
      };
    }

    const stdout = collect(proc.stdout as ReadableStream<Uint8Array>);
    const stderr = collect(proc.stderr as ReadableStream<Uint8Array>);
    const finished = Promise.all([stdout.done, stderr.done, proc.exited]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut =
      options.timeoutMs === undefined
        ? undefined
        : new Promise<true>((resolve) => {
            timer = setTimeout(() => {
              killGroup(proc);
              resolve(true);
            }, options.timeoutMs);
          });
    const outcome = await Promise.race([
      finished.then(() => false as const),
      ...(timedOut ? [timedOut] : []),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome) {
      // What the group wrote before it died is kept; a pipe held by a survivor is not waited on.
      await Promise.race([finished, Bun.sleep(DRAIN_MS)]);
      stdout.cancel();
      stderr.cancel();
      return {
        exitCode: 124,
        stdout: stdout.text(),
        stderr: `${stderr.text()}timed out after ${options.timeoutMs} ms`,
        durationMs: performance.now() - started,
      };
    }
    return {
      exitCode: await proc.exited,
      stdout: stdout.text(),
      stderr: stderr.text(),
      durationMs: performance.now() - started,
    };
  }
}

/** SIGKILL to the process's group (it leads one); the process alone where there is none. */
function killGroup(proc: ReturnType<typeof Bun.spawn>): void {
  if (POSIX) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The group is gone already, or was never made: the process itself below.
    }
  }
  proc.kill("SIGKILL");
}

/** A stream read to its end in the background: the text so far, and a way to stop reading. */
function collect(stream: ReadableStream<Uint8Array>): {
  readonly done: Promise<void>;
  text(): string;
  cancel(): void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      // Cancelled: the text read so far is the answer.
    }
  })();
  return {
    done,
    text: () => text,
    cancel: () => {
      reader.cancel().catch(() => undefined);
    },
  };
}
