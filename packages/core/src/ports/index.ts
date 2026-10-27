/**
 * Ports: small interfaces cut along axes of change (ISP). Adapters live in plugins;
 * application code depends only on these.
 */
import type { Agent } from "../domain/agent.ts";
import type { Diagnostic } from "../domain/diagnostic.ts";
import type { MetatorError } from "../domain/errors.ts";
import type { Edge } from "../domain/graph.ts";
import type { Result } from "../domain/result.ts";
import type { Skill } from "../domain/skill.ts";
import type { ModuleSymbols } from "../domain/symbols.ts";

export interface ReadonlyFileSystem {
  read(path: string): Promise<Result<string, MetatorError>>;
  exists(path: string): Promise<boolean>;
  /** Repo-relative paths matching the glob patterns (supports `!` negation). */
  glob(patterns: readonly string[]): Promise<readonly string[]>;
}

export interface FileSystem extends ReadonlyFileSystem {
  write(path: string, content: string): Promise<Result<void, MetatorError>>;
  /** Deletes a file; a missing file is not an error. */
  remove(path: string): Promise<Result<void, MetatorError>>;
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

/** Git worktrees (F8.2). Paths are repo-relative. */
export interface WorktreeManager {
  add(path: string, branch: string, base: string): Promise<Result<void, MetatorError>>;
  remove(path: string, force: boolean): Promise<Result<void, MetatorError>>;
  /** Uncommitted or untracked changes in the worktree. */
  isDirty(path: string): Promise<Result<boolean, MetatorError>>;
}

/** Whether a TCP port on this machine can be bound right now. */
export interface PortProbe {
  isFree(port: number): Promise<boolean>;
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
  /** URL of the `origin` remote (or the first one); undefined when there is none. */
  remoteUrl(): Promise<Result<string | undefined, MetatorError>>;
}

/** File contents at an earlier revision (split from Vcs: history is read by few use cases). */
export interface RevisionReader {
  /** `path` at the merge base of `base` and HEAD; undefined when the file did not exist there. */
  readAt(base: string, path: string): Promise<Result<string | undefined, MetatorError>>;
  /** Lines added since the merge base, per file (1-based, working tree; untracked files whole). */
  addedLines(base: string): Promise<Result<ReadonlyMap<string, readonly number[]>, MetatorError>>;
  /** ISO date of the last commit that touched each committed file (none before the first commit). */
  lastChanged(): Promise<Result<ReadonlyMap<string, string>, MetatorError>>;
}

/** Line coverage from a report the repository's test runner wrote (e.g. LCOV). */
export interface CoverageReader {
  /** Repo-relative file → line → hit count, for instrumented lines only. */
  read(report: string): Promise<Result<ReadonlyMap<string, ReadonlyMap<number, number>>, MetatorError>>;
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

/** Exported and imported names of one module (split from ImportAnalyzer: a different axis). */
export interface SymbolAnalyzer {
  symbols(path: string, content: string): Result<ModuleSymbols, MetatorError>;
}

/** Declaration files (`.d.ts`) of the project, by repo-relative path (ADR-0040). */
export interface DeclarationEmitter {
  emit(): Promise<Result<ReadonlyMap<string, string>, MetatorError>>;
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

export interface DetectedPackageManager {
  readonly name: string;
  readonly version?: string;
  /** Lockfiles at the repository root; more than one is a warning. */
  readonly lockfiles: readonly string[];
}

/** Which package manager the repository uses (packageManager field, lockfiles). */
export interface PackageManagerDetector {
  detect(): Promise<Result<DetectedPackageManager | undefined, MetatorError>>;
}

/** Runs package.json scripts the way the repository's package manager does (npm needs `--`). */
export interface PackageManager {
  scriptCommand(script: string, args: readonly string[]): Promise<Result<ResolvedCommand, MetatorError>>;
}

/** Commands for project binaries: `node_modules/.bin/<bin>` of the repository first, PATH otherwise. */
export interface BinResolver {
  command(bin: string, args: readonly string[]): Promise<ResolvedCommand>;
}

export interface GeneratedFile {
  /** Repo-relative path the host reads. */
  readonly path: string;
  readonly content: string;
}

export interface HostAgentContext {
  /** Canonical source file, named in the generated file's marker. */
  readonly source: string;
  /** How the agent runs MetatorAI in this repository, e.g. "bun run metator". */
  readonly metatorCommand: string;
  /** Model for the agent's tier on this host, when the config sets one. */
  readonly model?: string;
}

/** Writes one host's skill directories from canonical skills (ADR-0039). */
export interface SkillGenerator {
  readonly host: "copilot" | "claude";
  /** Glob of the SKILL.md files this generator owns (for orphan detection). */
  readonly owns: string;
  /** SKILL.md and its supporting files for the host; `files` are the canonical supporting files. */
  skill(
    skill: Skill,
    body: string,
    files: readonly GeneratedFile[],
    context: { readonly source: string; readonly metatorCommand: string },
  ): readonly GeneratedFile[];
}

/** Writes one host's files from canonical sources; its tool-name table lives here (ADR-0030). */
export interface HostGenerator {
  readonly host: "copilot" | "claude";
  /** Globs of the files this generator owns (for orphan detection). */
  readonly owns: readonly string[];
  agent(agent: Agent, body: string, context: HostAgentContext): GeneratedFile;
  /** The host's hook configuration file (ADR-0038). */
  readonly hooksFile: string;
  /** Hook configuration running `metator guard *`, merged into `existing` (the file as it is). */
  hooks(metatorCommand: string, existing: string | undefined): Result<GeneratedFile, MetatorError>;
}
