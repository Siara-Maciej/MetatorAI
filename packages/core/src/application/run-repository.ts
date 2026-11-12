import { MetatorError } from "../domain/errors.ts";
import { InProcessLock } from "../domain/in-process-lock.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  parseRunRecord,
  RunLogDocument,
  RunPointerDocument,
  type RunRecord,
  RunRecordDocument,
} from "../domain/run-record.ts";
import {
  parseJsonDocument,
  readFrontMatter,
  renderFrontMatter,
  serializeJsonDocument,
} from "../domain/versioned.ts";
import type { FileLock, FileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

/** A run whose record cannot be read (a torn or hand-edited `state.json`): skipped, and said. */
export interface UnreadableRun {
  readonly runId: string;
  readonly file: string;
  readonly message: string;
}

/** What a person is told about an unreadable run: the file, and the two ways out. */
export const unreadableRunWarning = (u: UnreadableRun): string =>
  `run ${u.runId} cannot be read and is left out (${u.message}): restore ${u.file} (from git or a backup), or delete the run's directory to drop it`;

/**
 * Stores runs as versioned documents (ADR-0016): `<runs>/<id>/state.json` (RunRecord),
 * an append-only `<runs>/<id>/log.md` (RunLog) and `<runs>/latest.json` (RunPointer).
 * Writes always stamp the current schemaVersion; reads always validate it.
 */
export class RunRepository {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
    /** The run this process works for (a run's worktree): what "no run named" means, not the latest. */
    private readonly current?: string,
    /** One writer at a time per run record; the runtime gives the lock that holds across processes. */
    private readonly lock: FileLock = new InProcessLock(),
  ) {}

  runDir(runId: string): string {
    return `${this.paths.runs}/${runId}`;
  }

  stateFile(runId: string): string {
    return `${this.runDir(runId)}/state.json`;
  }

  logFile(runId: string): string {
    return `${this.runDir(runId)}/log.md`;
  }

  pointerFile(): string {
    return `${this.paths.runs}/latest.json`;
  }

  async exists(runId: string): Promise<boolean> {
    return this.fs.exists(this.stateFile(runId));
  }

  async save(record: RunRecord): Promise<Result<void, MetatorError>> {
    const written = await this.fs.write(
      this.stateFile(record.runId),
      serializeJsonDocument(RunRecordDocument.stamp(record)),
    );
    if (written.isErr()) return written;
    return this.fs.write(
      this.pointerFile(),
      serializeJsonDocument(RunPointerDocument.stamp({ runId: record.runId })),
    );
  }

  /**
   * Reads the record, changes it and writes it back as one step: the CLI, the daemon and a drive
   * change one run at the same time, and none of them writes over what another just wrote (R5).
   * `change` sees the record as it is now and decides from it; an error value changes nothing.
   */
  async update(
    runId: string,
    change: (record: RunRecord) => Result<RunRecord, MetatorError>,
  ): Promise<Result<RunRecord, MetatorError>> {
    return this.lock.hold(this.stateFile(runId), async () => {
      const record = await this.load(runId);
      if (record.isErr()) return err(record.error);
      const next = change(record.value);
      if (next.isErr()) return err(next.error);
      const saved = await this.save(next.value);
      return saved.map(() => next.value);
    });
  }

  async load(runId: string): Promise<Result<RunRecord, MetatorError>> {
    const source = this.stateFile(runId);
    const text = await this.fs.read(source);
    if (text.isErr()) {
      return err(
        new MetatorError("NOT_FOUND", `Run "${runId}" not found`, {
          hint: "List runs with `metator run list`.",
          details: { source },
        }),
      );
    }
    return parseRunRecord(text.value, source);
  }

  /** Resolves undefined to the current run (when there is one), and "latest" to the most recent run. */
  async resolveId(runId: string | undefined): Promise<Result<string, MetatorError>> {
    if (runId && runId !== "latest") return this.named(runId);
    if (runId === undefined && this.current && (await this.exists(this.current))) return ok(this.current);
    const source = this.pointerFile();
    const text = await this.fs.read(source);
    if (text.isErr()) {
      return err(
        new MetatorError("NOT_FOUND", "No runs yet", { hint: "Start one with `metator run init`." }),
      );
    }
    return parseJsonDocument(text.value, source)
      .andThen((raw) => RunPointerDocument.parse(raw, source))
      .map((pointer) => pointer.runId);
  }

  /**
   * The run a typed id names: the id itself when such a run exists, else the one run whose id
   * starts with it (ids are long). Several such runs are a usage error that lists them; none
   * leaves the id as typed, for the caller to report as not found.
   */
  private async named(typed: string): Promise<Result<string, MetatorError>> {
    if (await this.exists(typed)) return ok(typed);
    const starting = (await this.list()).filter((id) => id.startsWith(typed));
    if (starting.length <= 1) return ok(starting[0] ?? typed);
    return err(
      MetatorError.usage(
        `${starting.length} runs start with "${typed}"`,
        `Type more of the id: ${starting.join(", ")}.`,
      ),
    );
  }

  async list(): Promise<readonly string[]> {
    const files = await this.fs.glob([`${this.paths.runs}/*/state.json`]);
    return files.map((f) => f.slice(this.paths.runs.length + 1, -"/state.json".length)).sort();
  }

  /** Every run that can be read; one broken record never hides the others (R2). */
  async loadAll(): Promise<{
    readonly runs: readonly RunRecord[];
    readonly unreadable: readonly UnreadableRun[];
  }> {
    const runs: RunRecord[] = [];
    const unreadable: UnreadableRun[] = [];
    for (const runId of await this.list()) {
      const record = await this.load(runId);
      if (record.isOk()) runs.push(record.value);
      else unreadable.push({ runId, file: this.stateFile(runId), message: record.error.message });
    }
    return { runs, unreadable };
  }

  /** Checks the log's version header before a state change, so the audit trail never diverges. */
  async verifyLog(runId: string): Promise<Result<void, MetatorError>> {
    const file = this.logFile(runId);
    const current = await this.fs.read(file);
    if (current.isErr()) return ok(undefined); // created on first append
    return readFrontMatter(current.value, file)
      .andThen((raw) => RunLogDocument.parse(raw, file))
      .map(() => undefined);
  }

  /** The log's entries, oldest first (empty before the first append). */
  async readLog(runId: string): Promise<Result<string[], MetatorError>> {
    const file = this.logFile(runId);
    const current = await this.fs.read(file);
    if (current.isErr()) return ok([]);
    return readFrontMatter(current.value, file)
      .andThen((raw) => RunLogDocument.parse(raw, file))
      .map(() =>
        current.value
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2)),
      );
  }

  /** One line added at the end in one step: two writers never lose each other's line (R5). */
  async appendLog(runId: string, line: string): Promise<Result<void, MetatorError>> {
    const file = this.logFile(runId);
    if (!(await this.fs.exists(file))) {
      // The header is written once, whoever comes first.
      const created = await this.lock.hold(file, async () => {
        if (await this.fs.exists(file)) return ok(undefined);
        return this.fs.write(file, renderFrontMatter(RunLogDocument.stamp({ runId }), `# Run ${runId}\n\n`));
      });
      if (created.isErr()) return err(created.error);
    }
    const valid = await this.verifyLog(runId);
    if (valid.isErr()) return err(valid.error);
    return this.fs.append(file, `- ${line}\n`);
  }
}
