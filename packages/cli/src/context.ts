import type { MetatorError, Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";

/** What a command produces: a result for the envelope plus optional warnings. */
export interface Outcome {
  readonly result: Result<unknown, MetatorError>;
  readonly warnings?: readonly string[];
}

/** Shared by all command modules: lazy access to the composition root and action wrapping. */
export interface CommandContext {
  /** Builds the container for the repository selected by `--root` or the working directory. */
  readonly container: () => MetatorContainer;
  /** Wraps a handler so its Outcome becomes the command's single JSON envelope. */
  readonly action: <A extends unknown[]>(
    handler: (...args: A) => Promise<Outcome> | Outcome,
  ) => (...args: A) => Promise<void>;
}
