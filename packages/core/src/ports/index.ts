/**
 * Ports: small interfaces cut along axes of change (ISP). Adapters live in plugins;
 * application code depends only on these.
 */
import type { Diagnostic } from "../domain/diagnostic.ts";
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
  /** Tracked and untracked, non-ignored files (repo-relative): the repository as git sees it. */
  listFiles(): Promise<Result<readonly string[], MetatorError>>;
}

export interface ImportGraphReader {
  read(): Promise<Result<readonly Edge[], MetatorError>>;
}

export interface WorkspacePackage {
  readonly name: string;
  /** Repo-relative directory; "." for a single-package repository root. */
  readonly dir: string;
}

export interface WorkspaceReader {
  packages(): Promise<Result<readonly WorkspacePackage[], MetatorError>>;
}

export interface ImportSpecifier {
  readonly specifier: string;
  readonly kind: "static" | "reexport" | "dynamic";
  /** `import type` / `export type`: affects type checking, not runtime. */
  readonly typeOnly: boolean;
}

export type Resolution =
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "external"; readonly name: string }
  | { readonly type: "unresolved" };

/** Language-specific import extraction and module resolution (e.g. TypeScript via oxc). */
export interface ImportAnalyzer {
  /** File extensions this analyzer understands, e.g. [".ts", ".tsx"]. */
  readonly extensions: readonly string[];
  /** Stable content fingerprint used to skip re-parsing unchanged files. */
  fingerprint(content: string): string;
  parse(path: string, content: string): Result<readonly ImportSpecifier[], MetatorError>;
  /** Resolves a specifier from a repo-relative file; files outside the repo or in node_modules are external. */
  resolve(fromPath: string, specifier: string): Resolution;
}

/** A rule implemented by a tool (an E1 rule's `implementation` points at one). */
export interface EngineRule {
  readonly id: string;
  /** Repo-relative file that defines it. */
  readonly source: string;
  /** Whether the tool has a test for it (e.g. an ast-grep rule test). */
  readonly hasTest: boolean;
  /** Whether the repo's tool config turns it on; omitted when the engine cannot tell. */
  readonly enabled?: boolean;
}

/** A deterministic rule engine (ast-grep, Biome, ...) that E1 rules bind to. */
export interface RuleEngine {
  /** The `<engine>` part of `<engine>:<rule id>`. */
  readonly engine: string;
  rules(): Promise<Result<readonly EngineRule[], MetatorError>>;
  /** Runs the engine on the given repo-relative files (all files when omitted). */
  check(files?: readonly string[]): Promise<Result<readonly Diagnostic[], MetatorError>>;
}

export interface RuleScaffoldSpec {
  /** Tool rule id, e.g. "mt-arch-009". */
  readonly ruleId: string;
  readonly message: string;
  /** Globs the tool rule is limited to (the canon rule's applyTo). */
  readonly files: readonly string[];
}

/** Writes the skeleton of a new tool rule and its test (ISP: separate from checking). */
export interface RuleScaffolder {
  readonly engine: string;
  scaffold(spec: RuleScaffoldSpec): Promise<Result<{ readonly files: readonly string[] }, MetatorError>>;
}
