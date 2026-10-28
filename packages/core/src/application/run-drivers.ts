import { RunDriverDocument } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { BackgroundProcess, Clock, FileSystem } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { RunRepository } from "./run-repository.ts";

export interface DriverView {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly alive: boolean;
}

/**
 * Who drives a run (`.metator/runs/<id>/driver.json`): one process at a time. A driver that died
 * leaves its file behind; it counts as gone, so `run continue` can start a new one.
 */
export class RunDrivers {
  constructor(
    private readonly fs: FileSystem,
    private readonly repo: RunRepository,
    private readonly processes: BackgroundProcess,
    private readonly journal: RunJournal,
    private readonly clock: Clock,
  ) {}

  file(runId: string): string {
    return `${this.repo.runDir(runId)}/driver.json`;
  }

  async status(runId: string): Promise<Result<DriverView | null, MetatorError>> {
    const file = this.file(runId);
    if (!(await this.fs.exists(file))) return ok(null);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file)
      .andThen((raw) => RunDriverDocument.parse(raw, file))
      .map((d) => ({ ...d, alive: this.processes.isAlive(d.pid) }));
  }

  /** Records `pid` as the run's driver; refused while another live process drives it. */
  async claim(runId: string, pid: number, host: string): Promise<Result<void, MetatorError>> {
    const current = await this.status(runId);
    if (current.isErr()) return err(current.error);
    if (current.value?.alive && current.value.pid !== pid) {
      return err(
        MetatorError.usage(
          `run ${runId} is already driven by process ${current.value.pid}`,
          "Watch it with `metator run activity`, or stop it with `metator run stop`.",
        ),
      );
    }
    const doc = RunDriverDocument.stamp({ pid, host, startedAt: this.clock.now().toISOString() });
    return this.fs.write(this.file(runId), serializeJsonDocument(doc));
  }

  async release(runId: string, pid: number): Promise<Result<void, MetatorError>> {
    const current = await this.status(runId);
    if (current.isErr()) return err(current.error);
    if (current.value && current.value.pid !== pid) return ok(undefined);
    return this.fs.remove(this.file(runId));
  }

  /** `run drive --detach`: the drive goes on in its own process after this command returns. */
  async start(input: {
    readonly runId: string;
    readonly host: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly logFile: string;
  }): Promise<Result<DriverView, MetatorError>> {
    const current = await this.status(input.runId);
    if (current.isErr()) return err(current.error);
    if (current.value?.alive) {
      return err(
        MetatorError.usage(
          `run ${input.runId} is already driven by process ${current.value.pid}`,
          "Watch it with `metator run activity`, or stop it with `metator run stop`.",
        ),
      );
    }
    const pid = await this.processes.start(input.argv, input.cwd, input.logFile);
    if (pid.isErr()) return err(pid.error);
    const claimed = await this.claim(input.runId, pid.value, input.host);
    if (claimed.isErr()) return err(claimed.error);
    const logged = await this.journal.record(input.runId, {
      type: "drive",
      text: `started in the background (process ${pid.value}, log ${input.logFile})`,
    });
    if (logged.isErr()) return err(logged.error);
    return ok({ pid: pid.value, host: input.host, startedAt: this.clock.now().toISOString(), alive: true });
  }

  /** `run stop`: ends the run's drive process; the run stays where it is and can continue. */
  async stop(runId: string): Promise<Result<{ readonly stopped: number | null }, MetatorError>> {
    const current = await this.status(runId);
    if (current.isErr()) return err(current.error);
    if (!current.value) return ok({ stopped: null });
    if (current.value.alive) {
      const stopped = await this.processes.stop(current.value.pid);
      if (stopped.isErr()) return err(stopped.error);
    }
    const removed = await this.fs.remove(this.file(runId));
    if (removed.isErr()) return err(removed.error);
    const logged = await this.journal.record(runId, {
      type: "drive",
      text: `stopped (process ${current.value.pid})`,
    });
    if (logged.isErr()) return err(logged.error);
    return ok({ stopped: current.value.alive ? current.value.pid : null });
  }
}
