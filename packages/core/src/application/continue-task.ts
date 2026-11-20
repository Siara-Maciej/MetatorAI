import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Conductor } from "./conductor.ts";
import type { Panes } from "./panes.ts";
import type { RunDrivers } from "./run-drivers.ts";
import type { RunJournal } from "./run-journal.ts";
import type { EnsureDriven } from "./run-operations.ts";
import type { RunRepository } from "./run-repository.ts";

/** One repository a daemon serves, through its own container (the panes live in it). */
export interface TaskRepository {
  /** Its name in a folder; none when the daemon serves one repository. */
  readonly name?: string;
  readonly runs: Pick<RunRepository, "loadAll" | "load">;
  readonly panes: Pick<Panes, "view" | "resumePane">;
  readonly drivers: Pick<RunDrivers, "status">;
  readonly ensureDriven: Pick<EnsureDriven, "execute">;
  readonly conductor: Pick<Conductor, "start">;
  readonly journal: Pick<RunJournal, "record">;
}

export interface ContinueReport {
  readonly resumed: readonly {
    readonly repo?: string;
    readonly paneId: string;
    readonly role: string;
    readonly sessionId: string;
  }[];
  readonly drives: readonly { readonly repo?: string; readonly runId: string; readonly host: string }[];
  readonly skipped: readonly {
    readonly repo?: string;
    readonly paneId?: string;
    readonly runId?: string;
    readonly why: string;
  }[];
}

/**
 * "Continue" for a task (ADR-0092): the run, every run below it (a system run's children, the
 * runs started with `--parent`) across the repositories the daemon serves, and the chat where the
 * task was given. Every paused pane is resumed in place; every active run that nothing carries
 * then gets back what carried it: its conductor session, else its background drive.
 */
export class ContinueTask {
  constructor(private readonly repos: () => readonly TaskRepository[]) {}

  async execute(input: {
    readonly runId: string;
    readonly repo?: string;
    readonly by: string;
  }): Promise<Result<ContinueReport, MetatorError>> {
    if (input.by.trim() === "")
      return err(MetatorError.usage("say who continues: by", "Continuing a task records who did."));
    const repos = this.repos();
    // Every run of every repository, read once: the task's runs are found by their parent links.
    const all: { repo: TaskRepository; runId: string; parent?: string; status: string }[] = [];
    for (const repo of repos) {
      const loaded = await repo.runs.loadAll();
      for (const r of loaded.runs)
        all.push({
          repo,
          runId: r.runId,
          ...(r.parent ? { parent: r.parent } : {}),
          status: r.state.status,
        });
    }
    const root = all.find((r) => r.runId === input.runId && (!input.repo || r.repo.name === input.repo));
    if (!root) return err(MetatorError.notFound(`run ${input.runId}`));
    const task = [root];
    for (let i = 0; i < task.length; i++) {
      const parent = task[i] as (typeof all)[number];
      for (const child of all) if (child.parent === parent.runId && !task.includes(child)) task.push(child);
    }
    const of = (repo: TaskRepository) => (repo.name ? { repo: repo.name } : {});
    const resumed: ContinueReport["resumed"][number][] = [];
    const drives: ContinueReport["drives"][number][] = [];
    const skipped: ContinueReport["skipped"][number][] = [];
    const say = async (repo: TaskRepository, runId: string, text: string) =>
      repo.journal.record(runId, { type: "agent", origin: "run", text: `continued by ${input.by}: ${text}` });

    // 1. The paused panes of the task's runs, and the chat where the task was given.
    for (const repo of repos) {
      const view = await repo.panes.view();
      if (view.isErr()) return err(view.error);
      for (const pane of view.value.panes) {
        const run = task.find((t) => t.repo === repo && t.runId === pane.runId);
        const mainChat = pane.startedRun === root.runId;
        if (!run && !mainChat) continue;
        if (!pane.paused || pane.live?.alive) continue;
        if (run && run.status !== "active") {
          skipped.push({
            ...of(repo),
            paneId: pane.id,
            runId: run.runId,
            why: `run ${run.runId} is ${run.status}`,
          });
          continue;
        }
        const back = await repo.panes.resumePane(pane.id);
        if (back.isErr()) {
          skipped.push({ ...of(repo), paneId: pane.id, why: back.error.message });
          continue;
        }
        const sessionId = back.value.live?.sessionId ?? "";
        resumed.push({ ...of(repo), paneId: pane.id, role: pane.role, sessionId });
        if (pane.runId) {
          const noted = await say(repo, pane.runId, `resumed pane ${pane.id} (session ${sessionId})`);
          if (noted.isErr()) return err(noted.error);
        }
      }
    }

    // 2. Each active run nothing carries now: its conductor session again, else its drive.
    for (const run of task) {
      if (run.status === "escalated") {
        skipped.push({
          ...of(run.repo),
          runId: run.runId,
          why: `escalated: resume it first (\`metator run resume --run ${run.runId} --by <name>\`)`,
        });
        continue;
      }
      if (run.status !== "active") continue;
      const view = await run.repo.panes.view();
      if (view.isErr()) return err(view.error);
      const conductor = view.value.panes.find((p) => p.runId === run.runId && p.role === "conductor");
      if (conductor?.live?.alive) continue;
      const driver = await run.repo.drivers.status(run.runId);
      if (driver.isErr()) return err(driver.error);
      if (driver.value?.alive) continue;
      if (conductor && !conductor.ended) {
        const opened = await run.repo.conductor.start({ runId: run.runId });
        if (opened.isErr()) {
          skipped.push({
            ...of(run.repo),
            runId: run.runId,
            paneId: conductor.id,
            why: opened.error.message,
          });
          continue;
        }
        const sessionId = opened.value.live?.sessionId ?? "";
        resumed.push({ ...of(run.repo), paneId: opened.value.id, role: "conductor", sessionId });
        const noted = await say(
          run.repo,
          run.runId,
          `resumed its conductor in pane ${opened.value.id} (session ${sessionId})`,
        );
        if (noted.isErr()) return err(noted.error);
        continue;
      }
      const driven = await run.repo.ensureDriven.execute({ runId: run.runId });
      if (driven.isErr()) {
        skipped.push({ ...of(run.repo), runId: run.runId, why: driven.error.message });
        continue;
      }
      if (!driven.value.started) continue;
      const host = driven.value.host ?? "";
      drives.push({ ...of(run.repo), runId: run.runId, host });
      const noted = await say(
        run.repo,
        run.runId,
        `its drive started again on ${host} at ${driven.value.stage}`,
      );
      if (noted.isErr()) return err(noted.error);
    }
    return ok({ resumed, drives, skipped });
  }
}
