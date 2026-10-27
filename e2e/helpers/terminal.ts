import { CLI_ENTRY } from "./cli.ts";

export interface TerminalStep {
  /** Text that must be on the screen (ANSI stripped) before the keys are sent. */
  readonly waitFor: string;
  readonly keys: string;
}

export interface TerminalRun {
  readonly code: number;
  /** Everything the program printed, ANSI stripped. */
  readonly screen: string;
  /** The JSON envelope (the last line starting with `{"ok"`). */
  readonly json: Record<string, unknown>;
}

export const KEY = { enter: "\r", space: " ", down: "\x1b[B", up: "\x1b[A", ctrlC: "\x03" } as const;

/**
 * Runs the real `metator` in a pseudo-terminal (Bun.Terminal), as a person would: each step
 * waits for its text on the screen, then types its keys.
 */
export async function inTerminal(
  args: readonly string[],
  cwd: string,
  steps: readonly TerminalStep[],
  timeoutMs = 20_000,
  env: Readonly<Record<string, string>> = {},
): Promise<TerminalRun> {
  let raw = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", ...env },
    terminal: {
      cols: 120,
      rows: 40,
      data: (_t, data) => {
        raw += decoder.decode(data, { stream: true });
      },
    },
  });
  const seen = (text: string) => Bun.stripANSI(raw).includes(text);
  const deadline = Date.now() + timeoutMs;
  let from = 0;
  for (const step of steps) {
    while (!Bun.stripANSI(raw).slice(from).includes(step.waitFor)) {
      if (Date.now() > deadline || proc.exitCode !== null)
        throw new Error(`never saw "${step.waitFor}" on the screen:\n${Bun.stripANSI(raw)}`);
      await Bun.sleep(25);
    }
    from = Bun.stripANSI(raw).length;
    proc.terminal?.write(step.keys);
  }
  const code = await Promise.race([
    proc.exited,
    Bun.sleep(Math.max(0, deadline - Date.now())).then(() => {
      proc.kill();
      throw new Error(`timed out:\n${Bun.stripANSI(raw)}`);
    }),
  ]);
  while (!seen('{"ok"') && Date.now() < deadline) await Bun.sleep(25);
  proc.terminal?.close();
  const screen = Bun.stripANSI(raw);
  const line = screen
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trimStart().startsWith('{"ok"'));
  if (!line) throw new Error(`no JSON envelope on the screen:\n${screen}`);
  return { code, screen, json: JSON.parse(line.trim()) as Record<string, unknown> };
}
