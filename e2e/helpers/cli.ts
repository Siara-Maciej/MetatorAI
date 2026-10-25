import { join } from "node:path";

export const CLI_ENTRY = join(import.meta.dir, "../../packages/cli/src/main.ts");

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  readonly json: Record<string, unknown>;
}

/** Runs the real `metator` entrypoint as a separate process, exactly like an agent or hook would. */
export async function metator(args: readonly string[], cwd: string): Promise<CliRun> {
  const started = performance.now();
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const lines = stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== 1) throw new Error(`expected exactly one stdout line, got ${lines.length}: ${stdout}`);
  return { code, stdout, stderr, ms: performance.now() - started, json: JSON.parse(lines[0] as string) };
}
