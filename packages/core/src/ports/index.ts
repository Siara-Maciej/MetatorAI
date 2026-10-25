/**
 * Ports: small interfaces cut along axes of change (ISP). Adapters live in plugins;
 * application code depends only on these.
 */
import type { MetatorError } from "../domain/errors.ts";
import type { Edge } from "../domain/graph.ts";
import type { Result } from "../domain/result.ts";

export interface ReadonlyFileSystem {
  read(path: string): Promise<Result<string, MetatorError>>;
  exists(path: string): Promise<boolean>;
  /** Repo-relative paths matching the glob patterns (supports `!` negation). */
  glob(patterns: readonly string[]): Promise<readonly string[]>;
}

export interface FileSystem extends ReadonlyFileSystem {
  write(path: string, content: string): Promise<Result<void, MetatorError>>;
}

export interface ResolvedCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ProcessRunner {
  run(command: ResolvedCommand, options?: { readonly timeoutMs?: number }): Promise<ProcessResult>;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface Vcs {
  /** Files changed between `base` and the working tree (repo-relative). */
  changedFiles(base: string): Promise<Result<readonly string[], MetatorError>>;
}

export interface ImportGraphReader {
  read(): Promise<Result<readonly Edge[], MetatorError>>;
}
