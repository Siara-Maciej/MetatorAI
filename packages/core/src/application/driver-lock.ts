import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Driver } from "../domain/run-record.ts";
import type { Clock } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { RunRepository } from "./run-repository.ts";

export interface DriverLockView {
  readonly runId: string;
  readonly driver: Driver;
}

/**
 * The driver lock (D1, ADR-0077): one session, one driver. A person who attaches takes the
 * keyboard (input goes to the PTY) and may approve from the chat; release gives the session back
 * to the agent. Each change is one write of state.json, a line in log.md and an activity entry.
 */
export class DriverLock {
  constructor(
    private readonly repo: RunRepository,
    private readonly journal: Pick<RunJournal, "record">,
    private readonly clock: Clock,
  ) {}

  async attach(input: {
    readonly runId?: string;
    readonly by: string;
  }): Promise<Result<DriverLockView, MetatorError>> {
    if (input.by.trim() === "") return err(MetatorError.usage("say who attaches: --by <name>"));
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    if (record.value.state.status !== "active")
      return err(
        MetatorError.usage(
          `run ${id.value} is ${record.value.state.status}; there is no session to attach to`,
        ),
      );
    const current = record.value.driver;
    if (current?.by === "human" && current.attachedBy !== input.by)
      return err(
        MetatorError.usage(
          `run ${id.value} is driven by ${current.attachedBy} since ${current.attachedAt}`,
          "One session has one driver: ask them to `metator run release`, or attach to another run.",
        ),
      );
    if (current?.by === "human") return ok({ runId: id.value, driver: current });
    const at = this.clock.now().toISOString();
    const driver: Driver = { by: "human", attachedBy: input.by, attachedAt: at };
    const saved = await this.repo.update(id.value, (now) =>
      // Someone else attached meanwhile: the lock is theirs.
      now.driver?.by === "human" && now.driver.attachedBy !== input.by
        ? err(
            MetatorError.usage(
              `run ${id.value} is driven by ${now.driver.attachedBy} since ${now.driver.attachedAt}`,
            ),
          )
        : ok({ ...now, driver, updatedAt: at }),
    );
    if (saved.isErr()) return err(saved.error);
    const logged = await this.repo.appendLog(id.value, `${at} · driver · ${input.by} attached`);
    if (logged.isErr()) return err(logged.error);
    const noted = await this.journal.record(id.value, {
      type: "driver",
      origin: "run",
      text: `${input.by} attached: the keyboard is theirs; approvals from the chat count`,
    });
    if (noted.isErr()) return err(noted.error);
    return ok({ runId: id.value, driver });
  }

  async release(input: { readonly runId?: string }): Promise<Result<DriverLockView, MetatorError>> {
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const current = record.value.driver;
    const driver: Driver = { by: "agent" };
    if (!current || current.by === "agent") return ok({ runId: id.value, driver });
    const at = this.clock.now().toISOString();
    const saved = await this.repo.update(id.value, (now) => ok({ ...now, driver, updatedAt: at }));
    if (saved.isErr()) return err(saved.error);
    const logged = await this.repo.appendLog(id.value, `${at} · driver · ${current.attachedBy} released`);
    if (logged.isErr()) return err(logged.error);
    const noted = await this.journal.record(id.value, {
      type: "driver",
      origin: "run",
      text: `${current.attachedBy} released: the agent drives again`,
    });
    if (noted.isErr()) return err(noted.error);
    return ok({ runId: id.value, driver });
  }
}
