import {
  allowedWorkers,
  conductorPrompt,
  DEFAULT_CONDUCTOR,
  type WorkerResult,
  WorkerResultDocument,
  workerName,
  workerPrompt,
} from "../domain/conductor.ts";
import { MetatorError } from "../domain/errors.ts";
import type { Pane } from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, FileSystem, Timer } from "../ports/index.ts";
import { readDocument, writeDocument } from "./document-io.ts";
import type { Panes, PaneView } from "./panes.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

export interface ConductorDependencies {
  readonly panes: Panes;
  readonly repo: RunRepository;
  readonly journal: Pick<RunJournal, "record" | "ask">;
  readonly catalog: Pick<WorkflowCatalog, "get">;
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly timer: Timer;
  /** Absolute repository root. */
  readonly root: string;
}

export interface WorkerView {
  readonly name: string;
  readonly stage: string;
  readonly agent: string;
  readonly paneId: string;
  readonly alive: boolean;
  readonly idle: boolean;
  readonly exitCode?: number;
  readonly result?: WorkerResult;
}

export type WaitOutcome =
  | { readonly state: "result"; readonly result: WorkerResult }
  | { readonly state: "exited"; readonly exitCode?: number }
  | { readonly state: "idle" }
  | { readonly state: "timeout" };

/**
 * The conductor's side of a run (R2, ADR-0080): the run opened as a conductor pane whose agent
 * runs the workflow, workers delegated into panes of their own with a card, their results
 * waited for and collected. The workflow decides who may work a stage; the agent decides when.
 */
export class Conductor {
  constructor(private readonly d: ConductorDependencies) {}

  /** The run's conductor pane: the workflow's conductor agent, started with the run and its stages. */
  async start(input: {
    readonly runId?: string;
    readonly host?: string;
  }): Promise<Result<PaneView, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.d.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const workflow = await this.d.catalog.get(record.value.workflow.id);
    if (workflow.isErr()) return err(workflow.error);
    const cwd = record.value.worktree ? `${this.d.root}/${record.value.worktree.path}` : this.d.root;
    const prompt = conductorPrompt({
      runId: id.value,
      task: record.value.task,
      workflow: record.value.workflow.id,
      stages: workflow.value.spec.stages,
      runDir: `${cwd}/${this.d.repo.runDir(id.value)}`,
    });
    return this.d.panes.openRun({
      runId: id.value,
      ...(input.host ? { host: input.host } : {}),
      agent: DEFAULT_CONDUCTOR,
      prompt,
    });
  }

  /** A worker pane for a stage: only an agent the workflow lists for it, within its parallel limit. */
  async delegate(input: {
    readonly runId?: string;
    readonly stage?: string;
    readonly agent: string;
    readonly card: string;
    readonly name?: string;
    readonly host?: string;
  }): Promise<
    Result<{ readonly worker: string; readonly paneId: string; readonly stage: string }, MetatorError>
  > {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    const record = await this.d.repo.load(runId);
    if (record.isErr()) return err(record.error);
    if (record.value.state.status !== "active")
      return err(MetatorError.usage(`run ${runId} is ${record.value.state.status}; nothing to delegate`));
    const workflow = await this.d.catalog.get(record.value.workflow.id);
    if (workflow.isErr()) return err(workflow.error);
    const stageId = input.stage ?? record.value.state.stage;
    const stage = workflow.value.spec.stages.find((s) => s.id === stageId);
    if (!stage)
      return err(
        MetatorError.usage(
          `workflow ${record.value.workflow.id} has no stage ${stageId}`,
          `Stages: ${workflow.value.spec.stages.map((s) => s.id).join(", ")}.`,
        ),
      );
    if (stageId !== record.value.state.stage)
      return err(
        MetatorError.usage(
          `the run is at stage ${record.value.state.stage}, not ${stageId}`,
          "Delegate the current stage; `metator run advance` moves to the next.",
        ),
      );
    const allowed = allowedWorkers(stage);
    if (!allowed.includes(input.agent))
      return err(
        MetatorError.usage(
          `stage ${stageId} does not list ${input.agent}`,
          allowed.length > 0
            ? `Its agents: ${allowed.join(", ")}.`
            : "It has no agents; it is yours or a person's.",
        ),
      );
    if (input.card.trim() === "")
      return err(MetatorError.usage("a worker needs a card: its task, inputs and output"));
    const workers = await this.workers(runId);
    if (workers.isErr()) return err(workers.error);
    const live = workers.value.filter((w) => w.stage === stageId && w.alive && !w.result);
    const limit = workflow.value.spec.limits?.parallel;
    if (limit !== undefined && live.length >= limit)
      return err(
        MetatorError.usage(
          `stage ${stageId} allows ${limit} worker(s) at a time; ${live.map((w) => w.name).join(", ")} still work`,
          "Wait for one (`metator run wait <worker>`) and collect it first.",
        ),
      );
    // Names are never reused within a run: a collected worker's card stays in work/.
    const cards = await this.d.fs.glob([`${this.d.repo.runDir(runId)}/work/*.md`]);
    const past = cards.map((c) => c.slice(c.lastIndexOf("/") + 1).replace(/\.md$/, ""));
    const taken = [...new Set([...workers.value.map((w) => w.name), ...past])];
    const name = input.name ?? workerName(input.agent, taken);
    if (taken.includes(name)) return err(MetatorError.usage(`worker ${name} already exists in this run`));
    const workspace = await this.d.panes.openWorkspace({ runId });
    if (workspace.isErr()) return err(workspace.error);
    const cwd = workspace.value.cwd;
    const runDir = `${cwd}/${this.d.repo.runDir(runId)}`;
    const written = await this.d.fs.write(
      `${this.d.repo.runDir(runId)}/work/${name}.md`,
      `${input.card.trim()}\n`,
    );
    if (written.isErr()) return err(written.error);
    const host = input.host ?? record.value.host;
    const pane = await this.d.panes.openPane({
      workspace: workspace.value.id,
      role: "worker",
      label: name,
      runId,
      worker: { name, stage: stageId },
      process: {
        kind: "host",
        ...(host ? { host } : {}),
        agent: input.agent,
        prompt: workerPrompt({
          runId,
          worker: name,
          stage: stageId,
          agent: input.agent,
          card: input.card.trim(),
          runDir,
        }),
      },
    });
    if (pane.isErr()) return err(pane.error);
    const noted = await this.d.journal.record(runId, {
      type: "agent",
      origin: "run",
      stage: stageId,
      agent: input.agent,
      text: `delegated ${stageId} to worker ${name} in pane ${pane.value.id}`,
    });
    if (noted.isErr()) return err(noted.error);
    return ok({ worker: name, paneId: pane.value.id, stage: stageId });
  }

  /** The run's workers: their panes' state and their results so far. */
  async workers(runId: string): Promise<Result<readonly WorkerView[], MetatorError>> {
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const out: WorkerView[] = [];
    for (const p of view.value.panes) {
      if (p.runId !== runId || p.role !== "worker" || !p.worker) continue;
      const result = await this.result(runId, p.worker.name);
      if (result.isErr()) return err(result.error);
      out.push({
        name: p.worker.name,
        stage: p.worker.stage,
        agent: p.process.kind === "host" ? p.process.agent : p.label,
        paneId: p.id,
        alive: p.live?.alive ?? false,
        idle: p.live?.idle ?? false,
        ...(p.live?.exitCode !== undefined ? { exitCode: p.live.exitCode } : {}),
        ...(result.value ? { result: result.value } : {}),
      });
    }
    return ok(out);
  }

  /** Until the worker reported, its pane ended, or it sits idle without a report; or the time is up. */
  async wait(input: {
    readonly runId?: string;
    readonly worker: string;
    readonly timeoutMs: number;
    readonly pollMs?: number;
  }): Promise<Result<WaitOutcome, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const pane = await this.workerPane(id.value, input.worker);
    if (pane.isErr()) return err(pane.error);
    const deadline = this.d.clock.now().getTime() + input.timeoutMs;
    for (;;) {
      const result = await this.result(id.value, input.worker);
      if (result.isErr()) return err(result.error);
      if (result.value) return ok({ state: "result", result: result.value });
      const live = (await this.d.panes.pane(pane.value.id)).unwrapOr(undefined)?.live;
      if (live && !live.alive)
        return ok({ state: "exited", ...(live.exitCode !== undefined ? { exitCode: live.exitCode } : {}) });
      if (live?.idle) return ok({ state: "idle" });
      if (this.d.clock.now().getTime() >= deadline) return ok({ state: "timeout" });
      await this.d.timer.sleep(input.pollMs ?? 500);
    }
  }

  /** The worker's result, its pane closed; without a result the worker is still at work. */
  async collect(input: {
    readonly runId?: string;
    readonly worker: string;
  }): Promise<Result<WorkerResult & { readonly paneClosed: boolean }, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const result = await this.result(id.value, input.worker);
    if (result.isErr()) return err(result.error);
    if (!result.value)
      return err(
        MetatorError.usage(
          `worker ${input.worker} has not reported yet`,
          "Wait for it (`metator run wait <worker>`), or read its pane (`metator pane read <pane>`).",
        ),
      );
    const pane = await this.workerPane(id.value, input.worker);
    let paneClosed = false;
    if (pane.isOk()) {
      const closed = await this.d.panes.closePane(pane.value.id);
      if (closed.isErr()) return err(closed.error);
      paneClosed = closed.value.closed;
    }
    const noted = await this.d.journal.record(id.value, {
      type: "agent",
      origin: "run",
      stage: result.value.stage,
      agent: result.value.agent,
      text: `collected worker ${input.worker}: ${result.value.status}, ${result.value.summary.split("\n")[0]}`,
    });
    if (noted.isErr()) return err(noted.error);
    return ok({ ...result.value, paneClosed });
  }

  /** A worker's report (`metator run result`); a blocked one also asks the person its question. */
  async report(input: {
    readonly runId?: string;
    readonly worker: string;
    readonly status: WorkerResult["status"];
    readonly summary: string;
    readonly artifacts?: readonly string[];
    readonly question?: string;
  }): Promise<Result<WorkerResult, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const pane = await this.workerPane(id.value, input.worker);
    if (pane.isErr()) return err(pane.error);
    if (input.status === "blocked" && !input.question?.trim())
      return err(MetatorError.usage("a blocked worker says what it needs: --question <text>"));
    const agent = pane.value.process.kind === "host" ? pane.value.process.agent : pane.value.label;
    const result: WorkerResult = {
      worker: input.worker,
      stage: pane.value.worker?.stage ?? "?",
      agent,
      status: input.status,
      summary: input.summary.trim(),
      artifacts: [...(input.artifacts ?? [])],
      ...(input.question?.trim() ? { question: input.question.trim() } : {}),
      at: this.d.clock.now().toISOString(),
    };
    const written = await writeDocument(
      this.d.fs,
      this.resultFile(id.value, input.worker),
      WorkerResultDocument,
      result,
      "json",
    );
    if (written.isErr()) return err(written.error);
    const noted = await this.d.journal.record(id.value, {
      type: "agent",
      origin: "run",
      stage: result.stage,
      agent,
      text: `worker ${input.worker} reported ${input.status}: ${result.summary.split("\n")[0]}`,
    });
    if (noted.isErr()) return err(noted.error);
    if (input.status === "blocked" && result.question) {
      const asked = await this.d.journal.ask(id.value, {
        stage: result.stage,
        source: "agent",
        agent,
        prompt: `${input.worker}: ${result.question}`,
        options: [
          { label: "Answer", description: "Your answer goes to the conductor, who delegates again with it" },
        ],
        multiSelect: false,
      });
      if (asked.isErr()) return err(asked.error);
    }
    return ok(result);
  }

  private async result(
    runId: string,
    worker: string,
  ): Promise<Result<WorkerResult | undefined, MetatorError>> {
    return readDocument(this.d.fs, this.resultFile(runId, worker), WorkerResultDocument);
  }

  private resultFile(runId: string, worker: string): string {
    return `${this.d.repo.runDir(runId)}/results/${worker}.json`;
  }

  private async workerPane(runId: string, worker: string): Promise<Result<Pane, MetatorError>> {
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const pane = view.value.panes.find(
      (p) => p.runId === runId && p.role === "worker" && p.worker?.name === worker,
    );
    return pane ? ok(pane) : err(MetatorError.notFound(`worker ${worker} of run ${runId}`));
  }
}
