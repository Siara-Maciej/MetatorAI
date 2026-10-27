import type { MetatorError, Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { SetupPrompter } from "./prompts.ts";

/** What a command produces: a result for the envelope plus optional warnings. */
export interface Outcome {
  readonly result: Result<unknown, MetatorError>;
  readonly warnings?: readonly string[];
  /**
   * Hook commands (`guard *`) answer in the host's hook protocol instead of the envelope:
   * this object is printed as is (nothing for null) and the exit code is 0 (ADR-0038).
   */
  readonly hook?: Record<string, unknown> | null;
}

/** Shared by all command modules: lazy access to the composition root and action wrapping. */
export interface CommandContext {
  /** Builds the container for the repository selected by `--root` or the working directory. */
  readonly container: () => MetatorContainer;
  /** The process's standard input (hook payloads). */
  readonly stdin: () => Promise<string>;
  /** Runs another command in this process and returns its envelope (`meta check-all`). */
  readonly invoke: (
    argv: readonly string[],
  ) => Promise<{ readonly code: number; readonly envelope: Record<string, unknown> }>;
  /** Asks a person (`setup`); null when there is no terminal to ask in. */
  readonly prompter: SetupPrompter | null;
  /** Wraps a handler so its Outcome becomes the command's single JSON envelope. */
  readonly action: <A extends unknown[]>(
    handler: (...args: A) => Promise<Outcome> | Outcome,
  ) => (...args: A) => Promise<void>;
}
