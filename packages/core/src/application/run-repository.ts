import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseRunRecord, type RunRecord } from "../domain/run-record.ts";
import type { FileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

/** Stores runs as `<runs>/<id>/state.json` + append-only `log.md`, plus a `latest` pointer. */
export class RunRepository {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  stateFile(runId: string): string {
    return `${this.paths.runs}/${runId}/state.json`;
  }

  logFile(runId: string): string {
    return `${this.paths.runs}/${runId}/log.md`;
  }

  async exists(runId: string): Promise<boolean> {
    return this.fs.exists(this.stateFile(runId));
  }

  async save(record: RunRecord): Promise<Result<void, MetatorError>> {
    const written = await this.fs.write(this.stateFile(record.runId), `${JSON.stringify(record, null, 2)}\n`);
    if (written.isErr()) return written;
    return this.fs.write(`${this.paths.runs}/latest`, `${record.runId}\n`);
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
    const pointer = await this.fs.read(`${this.paths.runs}/latest`);
    if (pointer.isErr() || pointer.value.trim() === "") {
      return err(
        new MetatorError("NOT_FOUND", "No runs yet", { hint: "Start one with `metator run init`." }),
      );
    }
    return ok(pointer.value.trim());
  }

  async list(): Promise<readonly string[]> {
    const files = await this.fs.glob([`${this.paths.runs}/*/state.json`]);
    return files.map((f) => f.slice(this.paths.runs.length + 1, -"/state.json".length)).sort();
  }

  async appendLog(runId: string, line: string): Promise<Result<void, MetatorError>> {
    const file = this.logFile(runId);
    const current = await this.fs.read(file);
    const header = `# Run ${runId}\n\n`;
    return this.fs.write(file, `${current.isOk() ? current.value : header}- ${line}\n`);
  }
}
