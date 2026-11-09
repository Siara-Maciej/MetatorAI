import type { SupervisorPolicy } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { countAttention } from "../domain/overview.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { RunJournal } from "./drive.ts";
import type { WorkOverview } from "./overview.ts";
import type { PtyBroker } from "./pty-broker.ts";
import type { RunDrivers } from "./run-drivers.ts";
import type { RunRepository } from "./run-repository.ts";

export interface SupervisorDependencies {
  readonly policy: SupervisorPolicy;
  readonly repo: Pick<RunRepository, "list" | "load">;
  readonly drivers: Pick<RunDrivers, "status">;
  readonly journal: Pick<RunJournal, "record" | "activity" | "questions" | "ask">;
  readonly broker: Pick<PtyBroker, "list" | "nudge" | "close">;
  readonly overview: Pick<WorkOverview, "execute">;
  /** Starts a run's drive again (the CLI's `run continue`); the stage it stands at. */
  readonly restart: (runId: string) => Promise<Result<{ readonly stage: string }, MetatorError>>;
}

export interface SupervisorReport {
  /** Drives started again after they died, with the attempt number. */
  readonly revived: readonly { readonly runId: string; readonly stage: string; readonly attempt: number }[];
  /** Runs whose drive died more often than the policy allows; said once in their activity. */
  readonly gaveUp: readonly string[];
  /** Idle sessions told to go on. */
  readonly nudged: readonly string[];
  /** Idle sessions a person was asked about (still idle after a nudge). */
  readonly asked: readonly string[];
  /** Sessions closed because a person chose so. */
  readonly closed: readonly string[];
  /** How many runs wait for a person against the WIP limit. */
  readonly attention: { readonly waiting: number; readonly limit: number; readonly over: boolean };
}

export const NUDGE =
  "metator: no output for a while and no question is open. Go on with the next step of your plan, or say what you are waiting for.";
export const IDLE_QUESTION = "The session stayed idle after a nudge";
export const NUDGE_AGAIN = "Nudge again";
export const CLOSE_SESSION = "Close the session";

/**
 * The supervisor (D4, ADR-0077): keeps sessions alive and people's attention in budget. One
 * `tick` restarts drives that died (with resume, up to the policy's attempts), nudges an idle
 * session once, asks a person about it the second time, and counts who waits against the WIP
 * limit. It never hands out tasks (decision 5).
 */
export class Supervisor {
  /** Idle episodes per run: 1 after a nudge, 2 once a person was asked; cleared when output returns. */
  private readonly episodes = new Map<string, { nudged: boolean; question?: string }>();

  constructor(private readonly d: SupervisorDependencies) {}

  async tick(): Promise<Result<SupervisorReport, MetatorError>> {
    const revived: SupervisorReport["revived"][number][] = [];
    const gaveUp: string[] = [];
    if (this.d.policy.respawn.enabled) {
      for (const runId of await this.d.repo.list()) {
        const record = await this.d.repo.load(runId);
        if (record.isErr()) return err(record.error);
        if (record.value.state.status !== "active") continue;
        const driver = await this.d.drivers.status(runId);
        if (driver.isErr()) return err(driver.error);
        // No file: nobody drove it, or its drive left on purpose (stopped, a host limit).
        if (!driver.value || driver.value.alive) continue;
        const activity = await this.d.journal.activity(runId);
        if (activity.isErr()) return err(activity.error);
        const attempts = activity.value.filter((a) => a.type === "restart").length;
        if (attempts >= this.d.policy.respawn.maxAttempts) {
          const said = activity.value.at(-1)?.text.startsWith("gave up");
          if (!said) {
            const noted = await this.d.journal.record(runId, {
              type: "error",
              origin: "run",
              text: `gave up: its drive died ${attempts} time(s), the policy allows ${this.d.policy.respawn.maxAttempts} restart(s); continue it yourself (metator run continue)`,
            });
            if (noted.isErr()) return err(noted.error);
          }
          gaveUp.push(runId);
          continue;
        }
        const noted = await this.d.journal.record(runId, {
          type: "restart",
          origin: "run",
          text: `restart ${attempts + 1} of ${this.d.policy.respawn.maxAttempts}: its drive (process ${driver.value.pid}) had died`,
        });
        if (noted.isErr()) return err(noted.error);
        const started = await this.d.restart(runId);
        if (started.isErr()) return err(started.error);
        revived.push({ runId, stage: started.value.stage, attempt: attempts + 1 });
      }
    }

    const nudged: string[] = [];
    const asked: string[] = [];
    const closed: string[] = [];
    for (const session of this.d.broker.list()) {
      // Only a run's conductor is nudged; workers answer to it, shells to nobody.
      const runId = session.runId;
      if (!runId || session.role !== "conductor") continue;
      const episode = this.episodes.get(runId);
      if (!session.alive) {
        this.episodes.delete(runId);
        continue;
      }
      if (!session.idle) {
        // Output came back after a nudge; a question asked meanwhile is answered below or stays.
        if (episode && !episode.question) this.episodes.delete(runId);
        if (episode?.question) {
          const answer = await this.answered(runId, episode.question);
          if (answer === CLOSE_SESSION) {
            await this.d.broker.close(session.paneId);
            closed.push(runId);
            this.episodes.delete(runId);
          } else if (answer !== undefined) this.episodes.delete(runId);
        }
        continue;
      }
      if (!episode) {
        const r = await this.d.broker.nudge(session.paneId, NUDGE);
        if (r.isErr()) continue; // a person drives: nothing to nudge
        const noted = await this.d.journal.record(runId, {
          type: "idle",
          origin: "run",
          agent: session.host,
          text: "nudged: go on with the next step of the plan",
        });
        if (noted.isErr()) return err(noted.error);
        this.episodes.set(runId, { nudged: true });
        nudged.push(runId);
        continue;
      }
      if (!episode.question) {
        const q = await this.d.journal.ask(runId, {
          stage: "session",
          source: "agent",
          agent: session.host,
          prompt: `${IDLE_QUESTION}: no output and no question from ${session.host} after the nudge.`,
          options: [
            { label: NUDGE_AGAIN, description: "Tell it once more to go on with its plan" },
            { label: CLOSE_SESSION, description: "End the terminal session; the run stays where it is" },
          ],
          multiSelect: false,
        });
        if (q.isErr()) return err(q.error);
        episode.question = q.value.id;
        asked.push(runId);
        continue;
      }
      const answer = await this.answered(runId, episode.question);
      if (answer === CLOSE_SESSION) {
        await this.d.broker.close(session.paneId);
        closed.push(runId);
        this.episodes.delete(runId);
      } else if (answer !== undefined) {
        // Nudge again (or any other words): one more nudge, then the question comes back.
        const r = await this.d.broker.nudge(session.paneId, NUDGE);
        if (r.isOk()) nudged.push(runId);
        this.episodes.set(runId, { nudged: true });
      }
    }

    const overview = await this.d.overview.execute();
    if (overview.isErr()) return err(overview.error);
    const waiting = countAttention(overview.value.runs).you;
    return ok({
      revived,
      gaveUp,
      nudged,
      asked,
      closed,
      attention: { waiting, limit: this.d.policy.wipLimit, over: waiting > this.d.policy.wipLimit },
    });
  }

  private async answered(runId: string, questionId: string): Promise<string | undefined> {
    const questions = await this.d.journal.questions(runId);
    if (questions.isErr()) return undefined;
    const q = questions.value.find((x) => x.id === questionId);
    if (!q?.answer) return undefined;
    return q.answer.choices[0] ?? q.answer.text ?? NUDGE_AGAIN;
  }
}
