import slugify from "@sindresorhus/slugify";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type RunEvent, type RunEventType, RunStateMachine } from "../domain/run-machine.ts";
import { APPROVAL_ACTIONS, type Approval, type Autonomy, type RunRecord } from "../domain/run-record.ts";
import type { Clock } from "../ports/index.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";
import type { CreateWorktree } from "./worktrees.ts";

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
  readonly approvals: RunRecord["approvals"];
  readonly files: { readonly state: string; readonly log: string };
  readonly worktree?: RunRecord["worktree"];
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
    approvals: record.approvals,
    files: { state: repo.stateFile(record.runId), log: repo.logFile(record.runId) },
    ...(record.worktree ? { worktree: record.worktree } : {}),
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
  /** Work in a new git worktree with its own ports (F8.2), branched from `base`. */
  readonly worktree?: { readonly base?: string };
}

export class InitRun {
  constructor(
    private readonly catalog: WorkflowCatalog,
    private readonly repo: RunRepository,
    private readonly clock: Clock,
    private readonly worktrees?: Pick<CreateWorktree, "execute">,
  ) {}

  async execute(input: InitRunInput): Promise<Result<RunView, MetatorError>> {
    const resolved = await machineFor(this.catalog, input.workflow);
    if (resolved.isErr()) return err(resolved.error);
    const { machine, source } = resolved.value;

    const now = this.clock.now().toISOString();
    const runId = await this.uniqueId(now, machine.workflow.id, input.task);
    let worktree: RunRecord["worktree"];
    if (input.worktree) {
      if (!this.worktrees) return err(new MetatorError("INTERNAL", "InitRun has no worktree support wired"));
      const wt = await this.worktrees.execute({
        id: runId,
        run: runId,
        ...(input.worktree.base ? { base: input.worktree.base } : {}),
      });
      if (wt.isErr()) return err(wt.error);
      worktree = { id: wt.value.id, path: wt.value.path, branch: wt.value.branch };
    }
    const created: RunRecord = {
      runId,
      workflow: { id: machine.workflow.id, revision: machine.workflow.revision, source },
      task: input.task,
      autonomy: input.autonomy ?? "L0",
      createdAt: now,
      updatedAt: now,
      state: machine.start(),
      approvals: {},
      ...(worktree ? { worktree } : {}),
    };
    const { record, lines } = skipGates(machine, created, now);
    const saved = await this.repo.save(record);
    if (saved.isErr()) return err(saved.error);
    for (const line of [
      `${now} · created · workflow ${record.workflow.id}@${record.workflow.revision} · ${record.autonomy}`,
      ...(worktree ? [`${now} · worktree · ${worktree.path} on ${worktree.branch}`] : []),
      ...lines,
    ]) {
      const logged = await this.repo.appendLog(runId, line);
      if (logged.isErr()) return err(logged.error);
    }
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

    const logReady = await this.repo.verifyLog(record.value.runId);
    if (logReady.isErr()) return err(logReady.error);

    const before = record.value.state.stage;
    const next = machine.send(record.value.state, input.event);
    if (next.isErr()) return err(next.error);

    const now = this.clock.now().toISOString();
    const approvals =
      input.event.type === "APPROVE"
        ? { ...record.value.approvals, [before]: approval(input.event, now) }
        : record.value.approvals;
    const autopilot = input.event.type === "APPROVE" && input.event.choice === AUTOPILOT_CHOICE;
    if (autopilot && machine.workflow.autonomy && !machine.workflow.autonomy.includes("L1")) {
      return err(
        MetatorError.usage(
          `workflow ${machine.workflow.id} does not support autopilot (L1)`,
          `Supported autonomy levels: ${machine.workflow.autonomy.join(", ")}.`,
        ),
      );
    }
    const autonomy = autopilot && record.value.autonomy === "L0" ? "L1" : record.value.autonomy;
    const { record: updated, lines } = skipGates(
      machine,
      { ...record.value, autonomy, state: next.value, approvals, updatedAt: now },
      now,
    );
    const saved = await this.repo.save(updated);
    if (saved.isErr()) return err(saved.error);
    for (const line of [
      `${now} · ${before} · ${describe(input.event)} → ${next.value.stage}`,
      ...(autonomy === record.value.autonomy ? [] : [`${now} · autopilot · autonomy ${autonomy}`]),
      ...lines,
    ]) {
      const logged = await this.repo.appendLog(updated.runId, line);
      if (logged.isErr()) return err(logged.error);
    }
    return ok(view(updated, machine, this.repo));
  }
}

function approval(event: { readonly by: string; readonly choice?: string }, at: string): Approval {
  return event.choice === undefined ? { by: event.by, at } : { by: event.by, choice: event.choice, at };
}

/** Choosing this at a human gate switches the run to L1 for the rest of the run (06-running). */
export const AUTOPILOT_CHOICE = "autopilot";

/**
 * Approves every human gate the run's autonomy may skip, one after another, and returns the
 * log lines. External actions (push, comment) are not stages: they still need `run approve`.
 */
function skipGates(
  machine: RunStateMachine,
  record: RunRecord,
  now: string,
): { record: RunRecord; lines: string[] } {
  let current = record;
  const lines: string[] = [];
  while (machine.skippable(current.state, current.autonomy)) {
    const stage = current.state.stage;
    const by = `autonomy ${current.autonomy}`;
    const next = machine.send(current.state, { type: "APPROVE", by });
    if (next.isErr()) break;
    current = {
      ...current,
      state: next.value,
      approvals: { ...current.approvals, [stage]: { by, at: now } },
    };
    lines.push(`${now} · ${stage} · skipped at ${current.autonomy} → ${next.value.stage}`);
  }
  return { record: current, lines };
}

/**
 * `run approve <gate> --by <who>` (ADR-0037): a HITL stage that is current is approved through
 * the state machine; an external action (push, comment) is recorded for `guard pre-tool`.
 */
export class ApproveRun {
  constructor(
    private readonly advance: Pick<AdvanceRun, "execute">,
    private readonly repo: RunRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly runId?: string;
    readonly gate: string;
    readonly by: string;
    readonly choice?: string;
  }): Promise<
    Result<RunView | { readonly runId: string; readonly approvals: RunRecord["approvals"] }, MetatorError>
  > {
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const decision = { by: input.by, ...(input.choice === undefined ? {} : { choice: input.choice }) };

    if (record.value.state.stage === input.gate)
      return this.advance.execute({ runId: id.value, event: { type: "APPROVE", ...decision } });
    if (!(APPROVAL_ACTIONS as readonly string[]).includes(input.gate)) {
      return err(
        MetatorError.usage(
          `"${input.gate}" is neither the current stage (${record.value.state.stage}) nor an action (${APPROVAL_ACTIONS.join(", ")})`,
          "Approve the stage the run is waiting at, or an external action.",
        ),
      );
    }
    if (record.value.state.status !== "active")
      return err(MetatorError.usage(`run ${id.value} is ${record.value.state.status}; nothing to approve`));

    const now = this.clock.now().toISOString();
    const approvals = { ...record.value.approvals, [input.gate]: approval(decision, now) };
    const saved = await this.repo.save({ ...record.value, approvals, updatedAt: now });
    if (saved.isErr()) return err(saved.error);
    const logged = await this.repo.appendLog(id.value, `${now} · approved ${input.gate} · by ${input.by}`);
    if (logged.isErr()) return err(logged.error);
    return ok({ runId: id.value, approvals });
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
