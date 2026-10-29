import {
  type AgentAnswer,
  type AgentEvent,
  type AgentHost,
  type AgentQuestion,
  type AgentTask,
  type BackgroundProcess,
  type CheckoutReader,
  type Clock,
  type ComposeService,
  type ContainerRuntime,
  type DataIsolator,
  type Diagnostic,
  type EngineRule,
  err,
  type FileSystem,
  type HealthProbe,
  type HealthTarget,
  type MachineState,
  MetatorError,
  matchesAny,
  normalizePath,
  ok,
  type PortProbe,
  type PostgresTarget,
  type ProcessResult,
  type ProcessRunner,
  type ResolvedCommand,
  type Result,
  type RuleEngine,
  type Timer,
  type TreeCopier,
  type Vcs,
  type WorktreeManager,
} from "@metator/core";

export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(normalizePath(path), content);
  }

  async read(path: string): Promise<Result<string, MetatorError>> {
    const content = this.files.get(normalizePath(path));
    return content === undefined ? err(MetatorError.notFound(`File ${path}`, { path })) : ok(content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalizePath(path));
  }

  async glob(patterns: readonly string[]): Promise<readonly string[]> {
    return [...this.files.keys()].filter((path) => matchesAny(path, patterns)).sort();
  }

  async write(path: string, content: string): Promise<Result<void, MetatorError>> {
    this.files.set(normalizePath(path), content);
    return ok(undefined);
  }

  async remove(path: string): Promise<Result<void, MetatorError>> {
    this.files.delete(normalizePath(path));
    return ok(undefined);
  }
}

export interface ScriptedResponse {
  /** Matches when the command's argv starts with this prefix. */
  readonly argvPrefix: readonly string[];
  readonly result: Partial<ProcessResult>;
}

/** Deterministic ProcessRunner: records every call and replays scripted responses. */
export class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: ResolvedCommand[] = [];

  constructor(private readonly responses: readonly ScriptedResponse[] = []) {}

  async run(command: ResolvedCommand): Promise<ProcessResult> {
    this.calls.push(command);
    const match = this.responses.find((r) => r.argvPrefix.every((part, i) => command.argv[i] === part));
    if (!match) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: `unscripted command: ${command.argv.join(" ")}`,
        durationMs: 0,
      };
    }
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, ...match.result };
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date = new Date("2026-01-01T00:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Vcs fake: a fixed file list and change set, or "not a repository". */
export class FakeVcs implements Vcs {
  constructor(
    private readonly files: readonly string[] | "not-a-repo",
    private readonly changed: readonly string[] = [],
    private readonly remote?: string,
  ) {}

  async remoteUrl(): Promise<Result<string | undefined, MetatorError>> {
    return this.files === "not-a-repo" ? err(MetatorError.notFound("git repository")) : ok(this.remote);
  }

  async changedFiles(): Promise<Result<readonly string[], MetatorError>> {
    return this.files === "not-a-repo" ? err(MetatorError.notFound("git repository")) : ok(this.changed);
  }

  async listFiles(): Promise<Result<readonly string[], MetatorError>> {
    return this.files === "not-a-repo" ? err(MetatorError.notFound("git repository")) : ok(this.files);
  }
}

/** Rule engine fake: a fixed rule list and canned diagnostics, recording which files were checked. */
export class FakeRuleEngine implements RuleEngine {
  readonly checked: (readonly string[] | undefined)[] = [];
  constructor(
    readonly engine: string,
    private readonly known: readonly EngineRule[],
    private readonly diagnostics: readonly Diagnostic[] = [],
  ) {}

  async rules(): Promise<Result<readonly EngineRule[], MetatorError>> {
    return ok(this.known);
  }

  async check(files?: readonly string[]): Promise<Result<readonly Diagnostic[], MetatorError>> {
    this.checked.push(files);
    return ok(files ? this.diagnostics.filter((d) => files.includes(d.file)) : this.diagnostics);
  }
}

/** WorktreeManager in memory: records worktrees; `dirty` marks paths with uncommitted work. */
export class FakeWorktreeManager implements WorktreeManager {
  readonly worktrees = new Map<string, { branch: string; base: string }>();
  readonly dirty = new Set<string>();

  async add(path: string, branch: string, base: string): Promise<Result<void, MetatorError>> {
    if (this.worktrees.has(path)) return err(new MetatorError("COMMAND_FAILED", `${path} already exists`));
    this.worktrees.set(path, { branch, base });
    return ok(undefined);
  }

  async remove(path: string, force: boolean): Promise<Result<void, MetatorError>> {
    if (this.dirty.has(path) && !force) return err(new MetatorError("COMMAND_FAILED", `${path} is dirty`));
    this.worktrees.delete(path);
    this.dirty.delete(path);
    return ok(undefined);
  }

  async isDirty(path: string): Promise<Result<boolean, MetatorError>> {
    return ok(this.dirty.has(path));
  }

  async switchBranch(path: string, branch: string, base: string): Promise<Result<void, MetatorError>> {
    if (!this.worktrees.has(path)) return err(new MetatorError("COMMAND_FAILED", `no worktree ${path}`));
    this.worktrees.set(path, { branch, base });
    return ok(undefined);
  }
}

/** PortProbe with a fixed set of busy ports. */
export class FakePortProbe implements PortProbe {
  constructor(readonly busy: ReadonlySet<number> = new Set()) {}

  async isFree(port: number): Promise<boolean> {
    return !this.busy.has(port);
  }
}

/** One start of an agent in FakeAgentHost: what it says and whether it succeeds. */
export interface FakeAgentTurn {
  readonly text?: string;
  readonly ok?: boolean;
  /** Asks a person before finishing; the answer is appended to the text as `answer: …`. */
  readonly ask?: AgentQuestion;
  /** Runs before the result, e.g. to write an artifact. */
  readonly effect?: (task: AgentTask) => Promise<void> | void;
}

/** AgentHost that plays scripted turns per agent (the last repeats) and records every task. */
export class FakeAgentHost implements AgentHost {
  readonly id = "fake";
  readonly tasks: AgentTask[] = [];
  private readonly starts = new Map<string, number>();

  constructor(private readonly turns: Readonly<Record<string, readonly FakeAgentTurn[]>>) {}

  async *run(task: AgentTask, ask: (q: AgentQuestion) => Promise<AgentAnswer>): AsyncIterable<AgentEvent> {
    this.tasks.push(task);
    const list = this.turns[task.agent] ?? [{ text: "STATUS: done" }];
    const n = this.starts.get(task.agent) ?? 0;
    this.starts.set(task.agent, n + 1);
    const turn = list[Math.min(n, list.length - 1)] ?? {};
    yield { type: "session", id: `${task.agent}-${n + 1}` };
    let text = turn.text ?? "STATUS: done";
    if (turn.ask) {
      const a = await ask(turn.ask);
      text = `answer: ${[...a.choices, ...(a.text ? [a.text] : [])].join(", ")}\n${text}`;
    }
    await turn.effect?.(task);
    yield { type: "text", text };
    yield { type: "result", ok: turn.ok ?? true, text: "" };
  }
}

/**
 * Timer that never waits; counts the waits. After `limit` waits it throws, so a test whose answer
 * never comes fails fast instead of polling forever.
 */
export class InstantTimer implements Timer {
  waits = 0;
  constructor(
    private readonly onWait?: () => Promise<void> | void,
    private readonly limit = 1000,
  ) {}

  async sleep(): Promise<void> {
    if (++this.waits > this.limit) throw new Error(`InstantTimer: still waiting after ${this.limit} waits`);
    await this.onWait?.();
  }
}

/** BackgroundProcess that records starts and stops; processes stay alive until stopped. */
export class FakeBackgroundProcess implements BackgroundProcess {
  readonly started: {
    argv: readonly string[];
    cwd: string;
    logFile: string;
    env: Readonly<Record<string, string>>;
  }[] = [];
  readonly logs = new Map<string, string>();
  readonly alive = new Set<number>();
  private next = 4000;

  async start(
    argv: readonly string[],
    cwd: string,
    logFile: string,
    env: Readonly<Record<string, string>> = {},
  ): Promise<Result<number, MetatorError>> {
    this.started.push({ argv, cwd, logFile, env });
    const pid = this.next++;
    this.alive.add(pid);
    return ok(pid);
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async stop(pid: number): Promise<Result<void, MetatorError>> {
    this.alive.delete(pid);
    return ok(undefined);
  }

  async readLog(logFile: string, lines: number): Promise<string> {
    return (this.logs.get(logFile) ?? "").split("\n").slice(-lines).join("\n");
  }
}

/** ContainerRuntime in memory: records ups and stops; a service named in `failing` fails to start. */
export class FakeContainerRuntime implements ContainerRuntime {
  readonly calls: { op: "up" | "stop" | "logs"; service: ComposeService }[] = [];
  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}

  async up(service: ComposeService): Promise<Result<void, MetatorError>> {
    this.calls.push({ op: "up", service });
    return this.failing.has(service.service)
      ? err(new MetatorError("COMMAND_FAILED", `docker compose up ${service.service} failed`))
      : ok(undefined);
  }

  async stop(service: ComposeService): Promise<Result<void, MetatorError>> {
    this.calls.push({ op: "stop", service });
    return ok(undefined);
  }

  async logs(service: ComposeService): Promise<Result<string, MetatorError>> {
    this.calls.push({ op: "logs", service });
    return ok(`logs of ${service.service}`);
  }
}

/** MachineState in memory; `dirs` are the absolute directories that exist ("every": all of them). */
export class InMemoryMachineState implements MachineState {
  readonly files = new Map<string, string>();
  constructor(readonly dirs: Set<string> | "every" = "every") {}

  async read(name: string): Promise<Result<string | undefined, MetatorError>> {
    return ok(this.files.get(name));
  }

  async write(name: string, content: string): Promise<Result<void, MetatorError>> {
    this.files.set(name, content);
    return ok(undefined);
  }

  async dirExists(path: string): Promise<boolean> {
    return this.dirs === "every" || this.dirs.has(path);
  }
}

/** DataIsolator in memory: databases per server port; a template copies its rows. */
export class FakeDataIsolator implements DataIsolator {
  readonly databases = new Map<number, Map<string, number[]>>();
  readonly calls: string[] = [];

  async createDatabase(
    target: PostgresTarget,
    name: string,
    template?: string,
  ): Promise<Result<boolean, MetatorError>> {
    this.calls.push(`create ${name}${template ? ` from ${template}` : ""}`);
    const server = this.server(target);
    if (server.has(name)) return ok(false);
    if (template && !server.has(template))
      return err(new MetatorError("COMMAND_FAILED", `template database "${template}" does not exist`));
    server.set(name, [...(template ? (server.get(template) ?? []) : [])]);
    return ok(true);
  }

  async dropDatabase(target: PostgresTarget, name: string): Promise<Result<boolean, MetatorError>> {
    this.calls.push(`drop ${name}`);
    return ok(this.server(target).delete(name));
  }

  server(target: PostgresTarget): Map<string, number[]> {
    const s = this.databases.get(target.port) ?? new Map<string, number[]>();
    this.databases.set(target.port, s);
    return s;
  }
}

/** TreeCopier on a set of existing directories (absolute paths); records what it copied. */
export class FakeTreeCopier implements TreeCopier {
  readonly copies: { from: string; to: string }[] = [];
  constructor(readonly dirs: Set<string> = new Set()) {}

  async copy(from: string, to: string): Promise<Result<boolean, MetatorError>> {
    if (!this.dirs.has(from) || this.dirs.has(to)) return ok(false);
    this.copies.push({ from, to });
    this.dirs.add(to);
    return ok(true);
  }
}

/** HealthProbe that answers at once; targets in `down` never become ready. */
export class FakeHealthProbe implements HealthProbe {
  readonly checked: HealthTarget[] = [];
  constructor(private readonly down: (t: HealthTarget) => boolean = () => false) {}

  async waitFor(target: HealthTarget): Promise<Result<void, MetatorError>> {
    this.checked.push(target);
    return this.down(target) ? err(new MetatorError("COMMAND_FAILED", "not ready in time")) : ok(undefined);
  }
}

/** Checkouts on this "machine": an in-memory file system per absolute root (CheckoutReader). */
export class InMemoryCheckouts implements CheckoutReader {
  constructor(private readonly roots: Readonly<Record<string, InMemoryFileSystem>>) {}

  async read(root: string, path: string): Promise<Result<string | undefined, MetatorError>> {
    const fs = this.roots[root];
    if (!fs || !(await fs.exists(path))) return ok(undefined);
    const text = await fs.read(path);
    return text.isErr() ? err(text.error) : ok(text.value);
  }

  async isDirectory(path: string): Promise<boolean> {
    return path in this.roots;
  }
}
