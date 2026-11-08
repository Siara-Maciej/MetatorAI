import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTask, InteractiveHost, PtyHandle } from "@metator/core";

export interface InteractiveHostWorld {
  readonly host: InteractiveHost;
  readonly task: AgentTask;
  /** A line the first session says. */
  readonly says: string;
  /** What to type when the session asks, and what it says back. */
  readonly answer: { readonly type: string; readonly echoes: string };
}

/**
 * A stand-in for a host CLI (D6): a shell script that prints its arguments on one line
 * (`args: …`), reads one line from the terminal, echoes it (`typed: …`) and exits 0. The
 * adapters' contract runs on it in a real PTY where the real CLI is not installed; the argv an
 * adapter composes is what the test reads.
 */
export function standInCli(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\nprintf 'args: %s\\n' "$*"\nread -r line\nprintf 'typed: %s\\n' "$line"\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** Output until `text` appears, or until the deadline. */
export async function outputUntil(pty: PtyHandle, text: string, ms = 10_000): Promise<string> {
  let out = "";
  return new Promise((resolve) => {
    const done = () => {
      stop();
      resolve(out);
    };
    const stop = pty.onData((d) => {
      out += d;
      if (out.includes(text)) done();
    });
    setTimeout(done, ms);
  });
}

export const exitOf = (pty: PtyHandle, ms = 10_000): Promise<number> =>
  new Promise((resolve) => {
    pty.onExit(resolve);
    setTimeout(() => resolve(-1), ms);
  });

/**
 * Every InteractiveHost adapter (D3, ADR-0077) passes this suite: it starts with the task, its
 * words come through the PTY, typed input is read, a session can be resumed by its id, and the
 * end of the session is an exit event.
 */
export function interactiveHostContract(name: string, make: () => Promise<InteractiveHostWorld>): void {
  describe(`InteractiveHost contract: ${name}`, () => {
    test("starts with the task, speaks through the PTY, reads what is typed, and exits", async () => {
      const w = await make();
      const session = (await w.host.start(w.task, { cols: 80, rows: 24 }))._unsafeUnwrap();
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.pty.pid).toBeGreaterThan(0);
      const first = await outputUntil(session.pty, w.says);
      expect(first).toContain(w.says);
      session.pty.write(`${w.answer.type}\r`);
      const echoed = await outputUntil(session.pty, w.answer.echoes);
      expect(echoed).toContain(w.answer.echoes);
      expect(await exitOf(session.pty)).toBe(0);
    }, 30_000);

    test("a session resumed by its id is a session again, with its own PTY", async () => {
      const w = await make();
      const first = (await w.host.start(w.task, { cols: 80, rows: 24 }))._unsafeUnwrap();
      first.pty.kill();
      const again = (await w.host.resume(first.sessionId, w.task, { cols: 80, rows: 24 }))._unsafeUnwrap();
      expect(again.pty.pid).not.toBe(first.pty.pid);
      expect(again.sessionId.length).toBeGreaterThan(0);
      again.pty.kill();
    }, 30_000);
  });
}
