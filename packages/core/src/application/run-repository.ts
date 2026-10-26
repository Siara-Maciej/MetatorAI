import { MetatorError } from "../domain/errors.ts";
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
import type { FileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

/**
 * Stores runs as versioned documents (ADR-0016): `<runs>/<id>/state.json` (RunRecord),
 * an append-only `<runs>/<id>/log.md` (RunLog) and `<runs>/latest.json` (RunPointer).
 * Writes always stamp the current schemaVersion; reads always validate it.
 */
export class RunRepository {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
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

  /** Resolves "latest" (or undefined) to the most recently written run. */
  async resolveId(runId: string | undefined): Promise<Result<string, MetatorError>> {
    if (runId && runId !== "latest") return ok(runId);
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

  async list(): Promise<readonly string[]> {
    const files = await this.fs.glob([`${this.paths.runs}/*/state.json`]);
    return files.map((f) => f.slice(this.paths.runs.length + 1, -"/state.json".length)).sort();
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

  async appendLog(runId: string, line: string): Promise<Result<void, MetatorError>> {
    const file = this.logFile(runId);
    const current = await this.fs.read(file);
    if (current.isErr()) {
      const header = renderFrontMatter(RunLogDocument.stamp({ runId }), `# Run ${runId}\n\n`);
      return this.fs.write(file, `${header}- ${line}\n`);
    }
    const valid = readFrontMatter(current.value, file).andThen((raw) => RunLogDocument.parse(raw, file));
    if (valid.isErr()) return err(valid.error);
    return this.fs.write(file, `${current.value}- ${line}\n`);
  }
}
