import { existsSync, readSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  err,
  MetatorError,
  ok,
  type PtyHandle,
  type PtySize,
  type Result,
  type Terminal,
} from "@metator/core";

/** node-pty's native binding: fork a program on a pseudo-terminal, resize it. */
interface NativePty {
  fork(
    file: string,
    args: readonly string[],
    env: readonly string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helperPath: string,
    onExit: (code: number, signal: number) => void,
  ): { fd: number; pid: number; pty: string };
  resize(fd: number, cols: number, rows: number): void;
}

/** How often the master side is read when nothing arrived (the fd is non-blocking). */
const POLL_MS = 10;
const READ_BYTES = 65_536;
/** After the exit callback, how long the last output may still arrive. */
const DRAIN_MS = 250;

/**
 * Terminal on node-pty's native binding (D3, ADR-0077): a real pseudo-terminal, so the host CLI
 * draws its interface as it would for a person. The master side is read with synchronous,
 * non-blocking reads on a short poll instead of node-pty's own tty stream, which under Bun ends
 * the stream after the first read. On Windows node-pty's ConPTY path is used as it is.
 */
export class NodePtyTerminal implements Terminal {
  private native: NativePty | undefined;
  private helper = "";

  spawn(
    argv: readonly string[],
    options: {
      readonly cwd: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly size?: PtySize;
    },
  ): Result<PtyHandle, MetatorError> {
    const [file, ...args] = argv;
    if (!file) return err(MetatorError.usage("nothing to spawn: empty argv"));
    const size = options.size ?? { cols: 120, rows: 36 };
    if (process.platform === "win32") return this.windows(file, args, options.cwd, options.env ?? {}, size);
    const loaded = this.load();
    if (loaded.isErr()) return err(loaded.error);
    const env = { ...(process.env as Record<string, string>), ...options.env, TERM: "xterm-256color" };
    const envList = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const data = new Set<(d: string) => void>();
    const exits = new Set<(c: number) => void>();
    let exit: number | undefined;
    let exitedAt = 0;
    let closed = false;
    const decoder = new TextDecoder();
    const buffer = Buffer.alloc(READ_BYTES);
    let term: { fd: number; pid: number };
    try {
      term = loaded.value.fork(
        file,
        args,
        envList,
        options.cwd,
        size.cols,
        size.rows,
        -1,
        -1,
        true,
        this.helper,
        (code) => {
          exit = code;
          exitedAt = Date.now();
        },
      );
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `cannot spawn ${file} in a terminal: ${(e as Error).message}`),
      );
    }
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const l of exits) l(exit ?? 1);
    };
    const pump = () => {
      if (closed) return;
      try {
        const n = readSync(term.fd, buffer, 0, READ_BYTES, null);
        if (n > 0) {
          const text = decoder.decode(buffer.subarray(0, n), { stream: true });
          for (const l of data) l(text);
          setTimeout(pump, 0);
          return;
        }
        if (n === 0) return finish();
      } catch (e) {
        // EAGAIN: nothing yet. EIO: the slave side is gone, so the session is over.
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") return finish();
      }
      // The exit callback comes before the last bytes (and before EIO): drain a little longer.
      if (exit !== undefined && Date.now() - exitedAt > DRAIN_MS) return finish();
      setTimeout(pump, POLL_MS);
    };
    setTimeout(pump, 0);
    return ok({
      pid: term.pid,
      write: (text) => {
        if (!closed) writeSync(term.fd, text);
      },
      resize: (cols, rows) => {
        if (!closed) loaded.value.resize(term.fd, cols, rows);
      },
      onData: (listener) => {
        data.add(listener);
        return () => data.delete(listener);
      },
      onExit: (listener) => {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      kill: () => {
        if (closed) return;
        try {
          process.kill(term.pid, "SIGHUP");
        } catch {
          finish();
        }
      },
    });
  }

  /** node-pty's own ConPTY terminal, whose stream model is not the Unix one. */
  private windows(
    file: string,
    args: string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
    size: PtySize,
  ): Result<PtyHandle, MetatorError> {
    try {
      const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
      const handle = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        cwd,
        env: { ...(process.env as Record<string, string>), ...env },
      });
      return ok({
        pid: handle.pid,
        write: (d) => handle.write(d),
        resize: (cols, rows) => handle.resize(cols, rows),
        onData: (listener) => {
          const d = handle.onData(listener);
          return () => d.dispose();
        },
        onExit: (listener) => {
          const d = handle.onExit(({ exitCode }) => listener(exitCode));
          return () => d.dispose();
        },
        kill: () => handle.kill(),
      });
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `cannot spawn ${file} in a terminal: ${(e as Error).message}`),
      );
    }
  }

  /** The native binding: the build of this machine, else node-pty's prebuild for it. */
  private load(): Result<NativePty, MetatorError> {
    if (this.native) return ok(this.native);
    try {
      const require = createRequire(import.meta.url);
      const root = dirname(require.resolve("node-pty/package.json"));
      const dirs = [join(root, "build/Release"), join(root, `prebuilds/${process.platform}-${process.arch}`)];
      const dir = dirs.find((d) => existsSync(join(d, "pty.node")));
      if (!dir)
        return err(
          new MetatorError("COMMAND_FAILED", "node-pty has no native build for this machine", {
            hint: "Run the package manager's install again (node-pty builds on install), or `bun pm trust node-pty`.",
          }),
        );
      this.native = require(join(dir, "pty.node")) as NativePty;
      this.helper = join(dir, "spawn-helper");
      return ok(this.native);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `node-pty cannot load: ${(e as Error).message}`));
    }
  }
}
