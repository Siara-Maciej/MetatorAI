import {
  type Clock,
  err,
  type FileSystem,
  MetatorError,
  matchesAny,
  normalizePath,
  ok,
  type ProcessResult,
  type ProcessRunner,
  type ResolvedCommand,
  type Result,
  type Vcs,
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
  ) {}

  async changedFiles(): Promise<Result<readonly string[], MetatorError>> {
    return this.files === "not-a-repo" ? err(MetatorError.notFound("git repository")) : ok(this.changed);
  }

  async listFiles(): Promise<Result<readonly string[], MetatorError>> {
    return this.files === "not-a-repo" ? err(MetatorError.notFound("git repository")) : ok(this.files);
  }
}
