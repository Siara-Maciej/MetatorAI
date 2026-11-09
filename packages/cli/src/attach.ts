import { err, MetatorError, ok, type Result } from "@metator/core";

/**
 * `metator attach <pane>` (R4, ADR-0080): a terminal client of one pane over the daemon's pane
 * socket. The person's terminal goes raw: every key goes to the pane, every byte of the pane comes
 * back, the size follows the window. The detach prefix (Ctrl-]) ends it; so does the pane's exit.
 * The daemon decides who may type (the run's driver lock); a refusal is shown, never retried.
 */
export const DETACH_KEY = "\x1d";
export const DETACH_HINT = "detach: Ctrl-]";

export interface AttachIo {
  /** Writes to the person's terminal as is. */
  write(text: string): void;
  onKey(listener: (data: string) => void): () => void;
  onResize(listener: () => void): () => void;
  size(): { readonly cols: number; readonly rows: number };
  /** Raw mode: keys arrive one by one, nothing is echoed or interpreted by the terminal. */
  setRaw(on: boolean): void;
}

/** The pane socket, as the client needs it (a WebSocket, or a fake in tests). */
export interface AttachSocket {
  send(text: string): void;
  close(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

export interface AttachOutcome {
  readonly paneId: string;
  /** How it ended: the person detached, the pane's process exited, the daemon closed the socket. */
  readonly ended: "detached" | "exited" | "closed";
  readonly exitCode?: number;
  /** What the daemon refused while attached (typing without the lock), each once. */
  readonly refused: readonly string[];
}

interface PaneEvent {
  readonly type: string;
  readonly data?: string;
  readonly code?: number;
  readonly reason?: string;
  readonly session?: { readonly alive?: boolean; readonly role?: string; readonly runId?: string };
  readonly error?: { readonly message?: string };
}

export function attachPane(input: {
  readonly paneId: string;
  readonly io: AttachIo;
  readonly connect: () => AttachSocket;
}): Promise<Result<AttachOutcome, MetatorError>> {
  return new Promise((resolve) => {
    const { io } = input;
    const refused: string[] = [];
    let done = false;
    let socket: AttachSocket;
    const stops: (() => void)[] = [];
    const finish = (r: Result<AttachOutcome, MetatorError>) => {
      if (done) return;
      done = true;
      for (const stop of stops) stop();
      io.setRaw(false);
      socket.close();
      resolve(r);
    };
    const end = (ended: AttachOutcome["ended"], exitCode?: number) =>
      finish(ok({ paneId: input.paneId, ended, ...(exitCode !== undefined ? { exitCode } : {}), refused }));
    socket = input.connect();
    socket.onOpen(() => {
      const size = io.size();
      socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
    });
    socket.onMessage((text) => {
      let e: PaneEvent;
      try {
        e = JSON.parse(text) as PaneEvent;
      } catch {
        return;
      }
      if (e.type === "data" && typeof e.data === "string") io.write(e.data);
      else if (e.type === "session") {
        io.setRaw(true);
        const who = e.session?.runId
          ? `${e.session.role ?? "pane"} of run ${e.session.runId}`
          : (e.session?.role ?? "pane");
        io.write(`\r\n\x1b[90m[metator: attached to ${input.paneId} (${who}); ${DETACH_HINT}]\x1b[0m\r\n`);
      } else if (e.type === "exit") {
        io.write(`\r\n\x1b[90m[metator: pane ${input.paneId} exited with ${e.code ?? "?"}]\x1b[0m\r\n`);
        end("exited", e.code);
      } else if (e.type === "refused") {
        const reason = e.reason ?? "refused";
        if (!refused.includes(reason)) refused.push(reason);
        io.write(`\r\n\x1b[33m[metator: ${reason}]\x1b[0m\r\n`);
      } else if (e.type === "error") {
        // The daemon said no before anything was attached: its message is the error.
        finish(
          err(new MetatorError("NOT_FOUND", e.error?.message ?? `pane ${input.paneId} cannot be attached`)),
        );
      }
    });
    socket.onClose(() => end("closed"));
    stops.push(
      io.onKey((data) => {
        const at = data.indexOf(DETACH_KEY);
        if (at >= 0) {
          if (at > 0) socket.send(JSON.stringify({ type: "input", data: data.slice(0, at) }));
          io.write(`\r\n\x1b[90m[metator: detached from ${input.paneId}; the pane goes on]\x1b[0m\r\n`);
          end("detached");
          return;
        }
        socket.send(JSON.stringify({ type: "input", data }));
      }),
    );
    stops.push(
      io.onResize(() => {
        const size = io.size();
        socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
      }),
    );
  });
}

/** `w1:p2` is a pane id; anything else names a run (its conductor pane). */
export const isPaneId = (id: string): boolean => /^w\d+:p\d+$/.test(id);
