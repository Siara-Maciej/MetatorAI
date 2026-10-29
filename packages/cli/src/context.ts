import type { MetatorError, Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { Terminal } from "./terminal.ts";

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

/** A folder of repositories (G2): where `metator` was run, and the repositories it gathers. */
export interface Folder {
  readonly root: string;
  /** Absolute paths, with the names `metator ui` and `repos` show. */
  readonly repos: readonly { readonly name: string; readonly path: string; readonly root: string }[];
  /** `metator.repos.yml` when the folder has one; else the repositories were found below it. */
  readonly file: string | null;
}

/** Shared by all command modules: lazy access to the composition root and action wrapping. */
export interface CommandContext {
  /** Builds the container for the repository selected by `--root` or the working directory. */
  readonly container: () => MetatorContainer;
  /** The container that holds this repository's runs (in a worktree: the checkout it came from). */
  readonly runs: () => MetatorContainer;
  /** The container of another repository (one of a folder's). */
  readonly containerAt: (root: string) => MetatorContainer;
  /** The folder of repositories this command runs in; null inside a repository. */
  readonly folder: () => Folder | null;
  /** The process's standard input (hook payloads). */
  readonly stdin: () => Promise<string>;
  /** Runs another command in this process and returns its envelope (`meta check-all`). */
  readonly invoke: (
    argv: readonly string[],
  ) => Promise<{ readonly code: number; readonly envelope: Record<string, unknown> }>;
  /** The person at a terminal (setup, interactive runs); null when there is none. */
  readonly terminal: Terminal | null;
  /** Wraps a handler so its Outcome becomes the command's single JSON envelope. */
  readonly action: <A extends unknown[]>(
    handler: (...args: A) => Promise<Outcome> | Outcome,
  ) => (...args: A) => Promise<void>;
}
