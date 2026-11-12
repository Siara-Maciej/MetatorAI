import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { RunStateMachine } from "../domain/run-machine.ts";
import { isRunBookkeeping, type RunRecord } from "../domain/run-record.ts";
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
import type { WorkflowCatalog } from "./workflow-catalog.ts";

/** Files the run directory holds besides the run's own bookkeeping. */
async function artifactsOf(fs: FileSystem, repo: RunRepository, runId: string): Promise<string[]> {
  const dir = repo.runDir(runId);
  return (await fs.glob([`${dir}/**`]))
    .map((f) => f.slice(dir.length + 1))
    .filter((f) => !isRunBookkeeping(f))
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
 * What an abort needs from the run's drivers. Declared here, so this module does not import the
 * drivers, which import the drive that imports this module.
 */
export interface DriverStopper {
  stop(runId: string): Promise<Result<{ readonly stopped: number | null }, MetatorError>>;
}

/**
 * `run close` (ADR-0044): a run that reached a terminal state gets its summary (final telemetry);
 * `--aborted --reason` aborts an active or an escalated run first (F6), and the process that
 * drives it is stopped, so no agent goes on writing after the abort (R3). An active run is never
 * closed silently.
 */
export class CloseRun {
  constructor(
    private readonly advance: Pick<AdvanceRun, "execute">,
    private readonly repo: RunRepository,
    private readonly fs: FileSystem,
    private readonly clock: Clock,
    /** Who drives the run: an abort stops them. */
    private readonly drivers?: DriverStopper,
    /** The workflows: an escalated run is given up through its state machine. */
    private readonly catalog?: Pick<WorkflowCatalog, "get">,
  ) {}

  async execute(input: {
    readonly runId?: string;
    readonly abortReason?: string;
  }): Promise<Result<RunSummary & { readonly file: string; readonly stoppedDriver?: number }, MetatorError>> {
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
    } else if (record.value.state.status === "escalated" && input.abortReason !== undefined) {
      const given = await this.abandon(record.value, input.abortReason);
      if (given.isErr()) return err(given.error);
      record = given;
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
    // Last, once everything is written: the caller may itself be a child of the drive it stops.
    let stoppedDriver: number | null = null;
    if (input.abortReason !== undefined && this.drivers) {
      const stopped = await this.drivers.stop(id.value);
      if (stopped.isErr()) return err(stopped.error);
      stoppedDriver = stopped.value.stopped;
    }
    return ok({ ...summary, file, ...(stoppedDriver !== null ? { stoppedDriver } : {}) });
  }

  /** An escalated run ends as aborted, with the reason in its history and its log. */
  private async abandon(record: RunRecord, reason: string): Promise<Result<RunRecord, MetatorError>> {
    if (!this.catalog) return err(new MetatorError("INTERNAL", "CloseRun has no workflow catalog wired"));
    const entry = await this.catalog.get(record.workflow.id);
    if (entry.isErr()) return err(entry.error);
    const machine = RunStateMachine.create(entry.value.spec);
    if (machine.isErr()) return err(machine.error);
    const now = this.clock.now().toISOString();
    const updated = await this.repo.update(record.runId, (current) =>
      machine.value.abandon(current.state, reason).map((state) => ({ ...current, state, updatedAt: now })),
    );
    if (updated.isErr()) return err(updated.error);
    const logged = await this.repo.appendLog(
      record.runId,
      `${now} · escalated · ABORT · ${reason} → aborted`,
    );
    if (logged.isErr()) return err(logged.error);
    return ok(updated.value);
  }
}
