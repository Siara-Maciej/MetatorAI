/**
 * Ports: small interfaces cut along axes of change (ISP). Adapters live in plugins;
 * application code depends only on these.
 */

import type { Agent } from "../domain/agent.ts";
import type { ManifestSet } from "../domain/architecture.ts";
import type { ToolBoundaries } from "../domain/architecture-check.ts";
import type { ContractComparison } from "../domain/contract-diff.ts";
import type { Diagnostic } from "../domain/diagnostic.ts";
import type { AgentAnswer, AgentEvent, AgentQuestion, AgentTask } from "../domain/drive.ts";
import type { HealthTarget, PostgresTarget } from "../domain/environment.ts";
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
  /**
   * A new worktree on `branch` from `base`. Each `shared` directory of this checkout (a run's
   * state) is reached from the worktree through a link at the same relative path.
   */
  add(
    path: string,
    branch: string,
    base: string,
    shared?: readonly string[],
  ): Promise<Result<void, MetatorError>>;
  remove(path: string, force: boolean): Promise<Result<void, MetatorError>>;
  /** Uncommitted or untracked changes in the worktree. */
  isDirty(path: string): Promise<Result<boolean, MetatorError>>;
  /**
   * Puts the worktree on a new branch from `base` (resolved in the main checkout) and deletes the
   * branch it was on: a warm pool worktree taken by a run (F8.7).
   */
  switchBranch(path: string, branch: string, base: string): Promise<Result<void, MetatorError>>;
}

/** Whether a TCP port on this machine can be bound right now. */
export interface PortProbe {
  isFree(port: number): Promise<boolean>;
}

/**
 * An AI host that runs one agent on one task (F8.3): Claude Code through its Agent SDK, Copilot
 * CLI, or a scenario for tests. Questions and permission requests go to `ask`.
 */
export interface AgentHost {
  readonly id: string;
  run(task: AgentTask, ask: (q: AgentQuestion) => Promise<AgentAnswer>): AsyncIterable<AgentEvent>;
}

/** Waiting without blocking (polling for answers); instant in tests. */
export interface Timer {
  sleep(ms: number): Promise<void>;
}

/** A process that outlives the command that started it (`run drive --detach`, `env up`). */
export interface BackgroundProcess {
  start(
    argv: readonly string[],
    cwd: string,
    logFile: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<Result<number, MetatorError>>;
  isAlive(pid: number): boolean;
  stop(pid: number): Promise<Result<void, MetatorError>>;
  /** The last lines of a log file it wrote (empty when there is none). */
  readLog(logFile: string, lines: number): Promise<string>;
}

/** One Compose service of one project (F8.5). */
export interface ComposeService {
  readonly file: string;
  readonly service: string;
  /** The Compose project: `metator-<repo>-<tag>-<place>`, one per repository and place. */
  readonly project: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Containers through Docker Compose (MVP: Docker only, decision 4). */
export interface ContainerRuntime {
  up(service: ComposeService): Promise<Result<void, MetatorError>>;
  stop(service: ComposeService): Promise<Result<void, MetatorError>>;
  logs(service: ComposeService, lines: number): Promise<Result<string, MetatorError>>;
}

/** Programs a person uses from `metator ui`: an editor, a shell, a pager, a browser (F8.6). */
export interface Launcher {
  /** Runs a program on this terminal and waits until it exits (shell, terminal editor, diff). */
  attached(argv: readonly string[], cwd: string): Promise<Result<number, MetatorError>>;
  /** Starts a program in its own window and returns at once (GUI editor, browser). */
  detached(argv: readonly string[], cwd: string): Promise<Result<void, MetatorError>>;
  /** Which of these commands are on PATH, in the given order. */
  available(commands: readonly string[]): readonly string[];
}

/** One database per place on a shared Postgres (F8.7): cloned from a template, dropped with its worktree. */
export interface DataIsolator {
  /** Creates the database, from `template` when given; false when it already existed. */
  createDatabase(
    target: PostgresTarget,
    name: string,
    template?: string,
  ): Promise<Result<boolean, MetatorError>>;
  /** Drops the database; false when there was none. */
  dropDatabase(target: PostgresTarget, name: string): Promise<Result<boolean, MetatorError>>;
}

/**
 * State shared by every repository on this machine (G1): small named JSON documents in the user's
 * state directory, written atomically.
 */
export interface MachineState {
  /** The document's text; undefined when it was never written. */
  read(name: string): Promise<Result<string | undefined, MetatorError>>;
  write(name: string, content: string): Promise<Result<void, MetatorError>>;
  /** Whether an absolute directory still exists (a repository or a worktree holding state). */
  dirExists(path: string): Promise<boolean>;
}

/** Copies a directory tree, copy-on-write where the file system can (build reuse, F8.7). */
export interface TreeCopier {
  /** Absolute paths. False, and nothing copied, when `from` is missing or `to` already exists. */
  copy(from: string, to: string): Promise<Result<boolean, MetatorError>>;
}

/** Waits until a service accepts TCP connections or answers HTTP. */
export interface HealthProbe {
  waitFor(target: HealthTarget, timeoutMs: number): Promise<Result<void, MetatorError>>;
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

/** A commit of a branch, as a review's metadata shows it. */
export interface BranchCommit {
  readonly sha: string;
  readonly author: string;
  readonly email: string;
  /** ISO date of the commit. */
  readonly date: string;
  readonly subject: string;
}

/** A branch against its base (`review metadata`): where it forks and what it adds. */
export interface BranchHistory {
  branch(base: string): Promise<
    Result<
      {
        /** The current branch; null when HEAD is detached. */
        readonly branch: string | null;
        readonly head: string | null;
        readonly mergeBase: string | null;
        /** Commits after the merge base, newest first. */
        readonly commits: readonly BranchCommit[];
        /** The working tree has changes no commit holds. */
        readonly uncommitted: boolean;
      },
      MetatorError
    >
  >;
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

/**
 * What each workspace package declares (H1): `package.json` dependencies and entry points, plus
 * the tags and project type of Nx `project.json` and Turborepo `turbo.json`.
 */
export interface ManifestReader {
  manifests(): Promise<Result<ManifestSet, MetatorError>>;
}

/** Other repositories at a pinned commit, cloned once into a cache (F7.3). */
export interface RepositoryCloner {
  /** The commit `ref` points to in `repo` (its default branch without a ref). */
  resolve(repo: string, ref?: string): Promise<Result<string, MetatorError>>;
  /** A checkout of `sha` in `dir`; an existing one is reused. */
  checkout(repo: string, sha: string, dir: string): Promise<Result<void, MetatorError>>;
}

/** Files of another checkout on this machine, by absolute root (F7.3). */
export interface CheckoutReader {
  /** The file's text, or undefined when it does not exist. */
  read(root: string, path: string): Promise<Result<string | undefined, MetatorError>>;
  isDirectory(path: string): Promise<boolean>;
}

/** A specification a contract plugin recognized (F7.2). */
export interface DetectedContract {
  /** Repo-relative file. */
  readonly path: string;
  readonly title: string;
  readonly version?: string;
  /** Where the provider says it is served (`servers[].url`). */
  readonly servers: readonly string[];
}

/** One contract kind's specifications (`openapi`, later `asyncapi`, …): what `system discover` finds. */
export interface ContractDetector {
  readonly kind: string;
  /** Files worth reading, as globs. */
  readonly globs: readonly string[];
  detect(path: string, text: string): Result<DetectedContract | undefined, MetatorError>;
}

/** Two versions of one contract kind's specification compared (`contract diff`, F7.4). */
export interface ContractDiffer {
  readonly kind: string;
  compare(
    before: { readonly path: string; readonly text: string },
    after: { readonly path: string; readonly text: string },
  ): Promise<Result<ContractComparison, MetatorError>>;
}

/** A throwaway git repository made of given files (H7: architecture evals), removed by `dispose`. */
export interface Sandbox {
  create(
    files: Readonly<Record<string, string>>,
  ): Promise<Result<{ readonly root: string; dispose(): Promise<void> }, MetatorError>>;
}

/** Recent history of the repository (H3: packages that change together). */
export interface ChangeHistory {
  /** Files each of the last `limit` commits changed, newest first; none before the first commit. */
  commits(limit: number): Promise<Result<readonly (readonly string[])[], MetatorError>>;
}

/** Boundary rules other tools enforce (Turborepo `boundaries`, Nx `depConstraints`), for `arch init`. */
export interface ToolBoundariesReader {
  read(): Promise<Result<readonly ToolBoundaries[], MetatorError>>;
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
  /** What made resolution approximate (e.g. a config that extends a package not installed). */
  notes?(): readonly string[];
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
  /** The script in every workspace package that has it (`pnpm -r --if-present run <script>`). */
  workspacesCommand(script: string): Promise<Result<ResolvedCommand, MetatorError>>;
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
