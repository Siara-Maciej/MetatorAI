import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  isTerminal,
  type RunSummary,
  RunSummaryDocument,
  renderHandoff,
  summarizeRun,
} from "../domain/run-report.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import type { RunRepository } from "./run-repository.ts";
import type { AdvanceRun, GetRunStatus } from "./runs.ts";

/** Files the run directory holds besides the run's own bookkeeping. */
async function artifactsOf(fs: FileSystem, repo: RunRepository, runId: string): Promise<string[]> {
  const dir = repo.runDir(runId);
  const own = new Set(["state.json", "log.md", "summary.json", "handoff.md"]);
  return (await fs.glob([`${dir}/**`]))
    .map((f) => f.slice(dir.length + 1))
    .filter((f) => !own.has(f))
    .sort();
}

/** `run handoff` (ADR-0044): a handoff document generated from the run directory, not the chat. */
export class HandoffRun {
  constructor(
    private readonly status: Pick<GetRunStatus, "execute">,
    private readonly repo: RunRepository,
    private readonly fs: FileSystem,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly runId?: string;
    readonly logLines?: number;
  }): Promise<
    Result<
      { readonly runId: string; readonly file: string; readonly artifacts: readonly string[] },
      MetatorError
    >
  > {
    const view = await this.status.execute(input.runId ? { runId: input.runId } : {});
    if (view.isErr()) return err(view.error);
    const runId = view.value.runId;
    const record = await this.repo.load(runId);
    if (record.isErr()) return err(record.error);
    const log = await this.repo.readLog(runId);
    if (log.isErr()) return err(log.error);
    const artifacts = await artifactsOf(this.fs, this.repo, runId);
    const file = `${this.repo.runDir(runId)}/handoff.md`;
    const written = await this.fs.write(
      file,
      renderHandoff({
        record: record.value,
        expects: view.value.expects,
        artifacts,
        log: log.value.slice(-(input.logLines ?? 10)),
        writtenAt: this.clock.now(),
      }),
    );
    if (written.isErr()) return err(written.error);
    return ok({ runId, file, artifacts });
  }
}

/**
 * `run close` (ADR-0044): a run that reached a terminal state gets its summary (final telemetry);
 * `--aborted --reason` aborts an active run first. An active run is never closed silently.
 */
export class CloseRun {
  constructor(
    private readonly advance: Pick<AdvanceRun, "execute">,
    private readonly repo: RunRepository,
    private readonly fs: FileSystem,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly runId?: string;
    readonly abortReason?: string;
  }): Promise<Result<RunSummary & { readonly file: string }, MetatorError>> {
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    let record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);

    if (record.value.state.status === "active") {
      if (input.abortReason === undefined) {
        return err(
          MetatorError.usage(
            `run ${id.value} is still active at stage ${record.value.state.stage}`,
            "Advance it to a terminal state first, or close it with `--aborted --reason <why>`.",
          ),
        );
      }
      const aborted = await this.advance.execute({
        runId: id.value,
        event: { type: "ABORT", reason: input.abortReason },
      });
      if (aborted.isErr()) return err(aborted.error);
      record = await this.repo.load(id.value);
      if (record.isErr()) return err(record.error);
    }
    const current = record.value;
    const status = current.state.status;
    if (!isTerminal(status)) return err(new MetatorError("INTERNAL", `run ${id.value} did not end`));

    const summary = summarizeRun(
      { ...current, state: { ...current.state, status } },
      this.clock.now(),
      await artifactsOf(this.fs, this.repo, id.value),
    );
    const file = `${this.repo.runDir(id.value)}/summary.json`;
    const written = await this.fs.write(file, serializeJsonDocument(RunSummaryDocument.stamp(summary)));
    if (written.isErr()) return err(written.error);
    const logged = await this.repo.appendLog(id.value, `${summary.closedAt} · closed · ${status}`);
    if (logged.isErr()) return err(logged.error);
    return ok({ ...summary, file });
  }
}
