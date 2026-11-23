import { createConnection } from "node:net";
import { err, MetatorError, ok, type Result } from "@metator/core";

/** The ends of a tunnel: this process's stdin and stdout, or a test's streams. */
export interface TunnelEnds {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

/**
 * `metator tunnel --port <n>` (ADR-0106): joins this process's stdin and stdout to a TCP port of
 * this machine, byte for byte, both ways. The desktop app on the person's computer starts it in a
 * dev container (`docker exec -i … metator tunnel --port <daemon's>`) for each connection of its
 * window, so HTTP and WebSockets reach a daemon that listens on 127.0.0.1 inside the container,
 * with no port published. The end of the connection ends the tunnel once everything it sent is
 * written out. The end of stdin ends the connection once the daemon has been quiet for `quietMs`:
 * a server that sees its client close half the connection drops the answer it is writing (Bun's
 * does), and a browser that went away sends nothing more anyway.
 */
export function tunnel(
  to: { readonly port: number; readonly host: string; readonly quietMs?: number },
  ends: TunnelEnds,
): Promise<Result<{ readonly sent: number; readonly received: number }, MetatorError>> {
  return new Promise((resolve) => {
    let [sent, received] = [0, 0];
    let settled = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let inputEnded = false;
    const waitQuiet = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => socket.end(), to.quietMs ?? 2000);
    };
    const finish = (r: Result<{ readonly sent: number; readonly received: number }, MetatorError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(quiet);
      ends.input.removeListener("data", onInput);
      ends.input.pause();
      resolve(r);
    };
    const socket = createConnection({ port: to.port, host: to.host });
    const onInput = (chunk: Buffer | string) => {
      sent += chunk.length;
      if (!socket.write(chunk)) ends.input.pause();
    };
    socket.on("drain", () => ends.input.resume());
    socket.once("connect", () => {
      ends.input.on("data", onInput);
      ends.input.once("end", () => {
        inputEnded = true;
        waitQuiet();
      });
      ends.input.resume();
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (inputEnded) waitQuiet();
      if (!ends.output.write(chunk)) {
        socket.pause();
        ends.output.once("drain", () => socket.resume());
      }
    });
    // Everything written out first: the process may exit right after.
    socket.once("close", () => {
      ends.output.write(new Uint8Array(0), () => finish(ok({ sent, received })));
    });
    socket.once("error", (e: Error) => {
      if (sent === 0 && received === 0)
        finish(
          err(
            new MetatorError("COMMAND_FAILED", `nothing listens on ${to.host}:${to.port}: ${e.message}`, {
              hint: "The daemon of the repository stopped: open the repository again (metator serve --ensure).",
            }),
          ),
        );
    });
  });
}
