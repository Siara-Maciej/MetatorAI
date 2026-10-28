import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI_ENTRY = join(import.meta.dir, "../../packages/cli/src/main.ts");

/** Machine-wide state of the e2e runs (port leases), kept out of the user's own state directory. */
export const E2E_STATE_DIR = join(tmpdir(), "metator-e2e-state");

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  readonly json: Record<string, unknown>;
}

/** Runs the real `metator` entrypoint as a separate process, exactly like an agent or hook would. */
export async function metator(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<CliRun> {
  const started = performance.now();
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const lines = stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== 1) throw new Error(`expected exactly one stdout line, got ${lines.length}: ${stdout}`);
  return { code, stdout, stderr, ms: performance.now() - started, json: JSON.parse(lines[0] as string) };
}

/** Runs a hook command as a host would: the payload on stdin, the answer (or nothing) on stdout. */
export async function hook(
  args: readonly string[],
  payload: unknown,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly json: Record<string, unknown> | null;
}> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const text = stdout.trim();
  return { code, stdout, json: text === "" ? null : (JSON.parse(text) as Record<string, unknown>) };
}
