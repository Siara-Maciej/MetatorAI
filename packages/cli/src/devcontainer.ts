import { type ErrorCode, err, MetatorError, ok, type Result } from "@metator/core";

/**
 * What `metator devcontainer …` (ADR-0106) needs beside its use cases: progress lines for the
 * person (stderr: stdout keeps the one envelope), the envelope of the `metator` that ran in the
 * container, and `--env` words.
 */

/** A line of progress on stderr, as it happens (the desktop app shows each). */
export function progress(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** The envelope the `metator` in the container printed (its last JSON line), as this command's own answer. */
export function fromEnvelope(
  stdout: string,
  exitCode: number,
): { readonly result: Result<unknown, MetatorError>; readonly warnings: readonly string[] } {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  let env: Record<string, unknown> | undefined;
  try {
    env = line === undefined ? undefined : (JSON.parse(line) as Record<string, unknown>);
  } catch {
    env = undefined;
  }
  if (env === undefined)
    return {
      result: err(
        new MetatorError(
          "COMMAND_FAILED",
          `metator in the container exited ${exitCode} without an answer${stdout.trim() ? `: ${stdout.trim().slice(-500)}` : ""}`,
        ),
      ),
      warnings: [],
    };
  const warnings = Array.isArray(env.warnings)
    ? env.warnings.filter((w): w is string => typeof w === "string")
    : [];
  if (env.ok === true) return { result: ok(env.data ?? null), warnings };
  const e = (env.error ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const hint = text("hint");
  const details =
    e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : undefined;
  return {
    result: err(
      new MetatorError(
        (text("code") ?? "COMMAND_FAILED") as ErrorCode,
        text("message") ?? "metator failed in the container",
        {
          ...(hint === undefined ? {} : { hint }),
          ...(details === undefined ? {} : { details }),
        },
      ),
    ),
    warnings,
  };
}

/** `--env NAME=value` words as variables. */
export function envWords(words: readonly string[]): Result<Record<string, string>, MetatorError> {
  const out: Record<string, string> = {};
  for (const w of words) {
    const at = w.indexOf("=");
    if (at <= 0) return err(MetatorError.usage(`--env ${w}: write it NAME=value`));
    out[w.slice(0, at)] = w.slice(at + 1);
  }
  return ok(out);
}

/** The port of a daemon's address (`http://127.0.0.1:4711`). */
export function portOf(url: string): number | undefined {
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}
