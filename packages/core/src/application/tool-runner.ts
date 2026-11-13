import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { BinResolver, ProcessResult, ProcessRunner } from "../ports/index.ts";

/** One run of a project's tool (a linter, a type checker): which binary, with what, for how long. */
export interface ToolRun {
  /** The binary's name in `node_modules/.bin` and on PATH. */
  readonly bin: string;
  readonly args: readonly string[];
  /** The tool's name in the message when it differs from the binary's. */
  readonly tool?: string;
  /** How to install the tool, shown when it is missing. */
  readonly hint?: string;
  readonly timeoutMs?: number;
}

/**
 * Runs a project's tool the way every adapter of one does: the binary `bins` resolves (the
 * repository's pinned one first), and a binary that cannot be started (exit 127) as
 * BIN_NOT_FOUND with the install hint. Any other exit code is the tool's own answer, returned
 * for the adapter to read.
 */
export async function runTool(
  runner: ProcessRunner,
  bins: BinResolver,
  run: ToolRun,
): Promise<Result<ProcessResult, MetatorError>> {
  const command = await bins.command(run.bin, run.args);
  const r = await runner.run(command, run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs });
  if (r.exitCode === 127)
    return err(
      new MetatorError(
        "BIN_NOT_FOUND",
        `${run.tool ?? run.bin} is not installed`,
        run.hint === undefined ? {} : { hint: run.hint },
      ),
    );
  return ok(r);
}
