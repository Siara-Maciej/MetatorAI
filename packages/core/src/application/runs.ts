import slugify from "@sindresorhus/slugify";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type RunEvent, type RunEventType, RunStateMachine } from "../domain/run-machine.ts";
import type { Autonomy, RunRecord } from "../domain/run-record.ts";
import type { Clock } from "../ports/index.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

/** What commands return about a run: enough for an agent to decide its next step. */
export interface RunView {
  readonly runId: string;
  readonly workflow: string;
  readonly task: string;
  readonly autonomy: Autonomy;
  readonly stage: string;
  readonly status: RunRecord["state"]["status"];
  readonly expects: readonly RunEventType[];
  readonly loops: Readonly<Record<string, number>>;
  readonly recent: RunRecord["state"]["context"]["history"];
  readonly files: { readonly state: string; readonly log: string };
  readonly updatedAt: string;
}

function view(record: RunRecord, machine: RunStateMachine, repo: RunRepository): RunView {
  return {
    runId: record.runId,
    workflow: record.workflow.id,
    task: record.task,
    autonomy: record.autonomy,
    stage: record.state.stage,
    status: record.state.status,
    expects: machine.expects(record.state),
    loops: record.state.context.loops,
    recent: record.state.context.history.slice(-5),
    files: { state: repo.stateFile(record.runId), log: repo.logFile(record.runId) },
    updatedAt: record.updatedAt,
  };
}

function describe(event: RunEvent): string {
  switch (event.type) {
    case "PASS":
      return "PASS";
    case "FAIL":
      return event.reason ? `FAIL · ${event.reason}` : "FAIL";
    case "APPROVE":
      return `APPROVE · by ${event.by}${event.choice ? ` · choice ${event.choice}` : ""}`;
    case "ABORT":
      return `ABORT · ${event.reason}`;
  }
}

async function machineFor(
  catalog: WorkflowCatalog,
  workflowId: string,
): Promise<Result<{ machine: RunStateMachine; source: string }, MetatorError>> {
  const entry = await catalog.get(workflowId);
  if (entry.isErr()) return err(entry.error);
  return RunStateMachine.create(entry.value.spec).map((machine) => ({ machine, source: entry.value.source }));
}

export interface InitRunInput {
  readonly workflow: string;
  readonly task: string;
  readonly autonomy?: Autonomy;
}

export class InitRun {
  constructor(
    private readonly catalog: WorkflowCatalog,
    private readonly repo: RunRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: InitRunInput): Promise<Result<RunView, MetatorError>> {
    const resolved = await machineFor(this.catalog, input.workflow);
    if (resolved.isErr()) return err(resolved.error);
    const { machine, source } = resolved.value;

    const now = this.clock.now().toISOString();
    const runId = await this.uniqueId(now, machine.workflow.id, input.task);
    const record: RunRecord = {
      schemaVersion: 1,
      runId,
      workflow: { id: machine.workflow.id, version: machine.workflow.version, source },
      task: input.task,
      autonomy: input.autonomy ?? "L0",
      createdAt: now,
      updatedAt: now,
      state: machine.start(),
    };
    const saved = await this.repo.save(record);
    if (saved.isErr()) return err(saved.error);
    await this.repo.appendLog(
      runId,
      `${now} · created · workflow ${record.workflow.id}@${record.workflow.version} · ${record.autonomy}`,
    );
    return ok(view(record, machine, this.repo));
  }

  private async uniqueId(nowIso: string, workflow: string, task: string): Promise<string> {
    const date = nowIso.slice(0, 10).replaceAll("-", "");
    const slug = slugify(task).slice(0, 40).replace(/-+$/, "") || "run";
    const base = `${date}-${workflow}-${slug}`;
    let candidate = base;
    for (let n = 2; await this.repo.exists(candidate); n++) candidate = `${base}-${n}`;
    return candidate;
  }
}

export class AdvanceRun {
  constructor(
    private readonly catalog: WorkflowCatalog,
    private readonly repo: RunRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly runId?: string;
    readonly event: RunEvent;
  }): Promise<Result<RunView, MetatorError>> {
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const resolved = await machineFor(this.catalog, record.value.workflow.id);
    if (resolved.isErr()) return err(resolved.error);
    const { machine } = resolved.value;

    const before = record.value.state.stage;
    const next = machine.send(record.value.state, input.event);
    if (next.isErr()) return err(next.error);

    const now = this.clock.now().toISOString();
    const updated: RunRecord = { ...record.value, state: next.value, updatedAt: now };
    const saved = await this.repo.save(updated);
    if (saved.isErr()) return err(saved.error);
    await this.repo.appendLog(
      updated.runId,
      `${now} · ${before} · ${describe(input.event)} → ${next.value.stage}`,
    );
    return ok(view(updated, machine, this.repo));
  }
}

export class GetRunStatus {
  constructor(
    private readonly catalog: WorkflowCatalog,
    private readonly repo: RunRepository,
  ) {}

  async execute(input: { readonly runId?: string }): Promise<Result<RunView, MetatorError>> {
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const resolved = await machineFor(this.catalog, record.value.workflow.id);
    if (resolved.isErr()) return err(resolved.error);
    return ok(view(record.value, resolved.value.machine, this.repo));
  }
}

export class ListRuns {
  constructor(private readonly repo: RunRepository) {}

  async execute(): Promise<
    Result<
      readonly { runId: string; workflow: string; stage: string; status: string; updatedAt: string }[],
      MetatorError
    >
  > {
    const rows = [];
    for (const runId of await this.repo.list()) {
      const record = await this.repo.load(runId);
      if (record.isErr()) return err(record.error);
      const { workflow, state, updatedAt } = record.value;
      rows.push({ runId, workflow: workflow.id, stage: state.stage, status: state.status, updatedAt });
    }
    return ok(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
}
