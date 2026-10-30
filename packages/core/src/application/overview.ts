import type { Question, RunActivity } from "../domain/drive.ts";
import type { MetatorError } from "../domain/errors.ts";
import {
  type Attention,
  type AttentionCounts,
  attentionOf,
  byAttention,
  countAttention,
  type StageProgress,
  stageProgress,
  stoppedAt,
} from "../domain/overview.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock } from "../ports/index.ts";
import type { ConversationRepository } from "./ask.ts";
import type { RunJournal } from "./drive.ts";
import type { EnvironmentServices, ServiceReport } from "./environments.ts";
import type { RunDrivers } from "./run-drivers.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";
import type { WorktreeRegistry } from "./worktrees.ts";

export interface RunOverview {
  readonly runId: string;
  readonly workflow: string;
  readonly task: string;
  readonly autonomy: string;
  readonly status: string;
  readonly stage: string;
  readonly attention: Attention;
  readonly stages: readonly StageProgress[];
  /** Open questions: what to answer, in order. */
  readonly questions: readonly Question[];
  readonly driving: boolean;
  /** The host that drives (or drove) the run. */
  readonly host?: string;
  readonly last?: Pick<RunActivity, "at" | "type" | "text" | "stage" | "agent">;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** How long the run has been going (to its last change once it is finished). */
  readonly elapsedMs: number;
  readonly worktree?: {
    readonly id: string;
    readonly path: string;
    readonly branch: string;
    readonly ports?: { readonly from: number; readonly count: number };
  };
  readonly services: readonly Pick<ServiceReport, "service" | "status" | "ports" | "scope">[];
}

export interface ConversationOverview {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  readonly turns: number;
  readonly updatedAt: string;
}

export interface Overview {
  readonly runs: readonly RunOverview[];
  readonly conversations: readonly ConversationOverview[];
  readonly counts: AttentionCounts & { readonly questions: number; readonly services: number };
}

/**
 * `metator status` (G4, ADR-0059): every run with its stages, who must act, the questions to
 * answer, the last thing that happened, its worktree and services; and the conversations.
 */
export class WorkOverview {
  constructor(
    private readonly runs: RunRepository,
    private readonly workflows: Pick<WorkflowCatalog, "get">,
    private readonly journal: Pick<RunJournal, "questions" | "activity">,
    private readonly drivers: Pick<RunDrivers, "status">,
    private readonly registry: Pick<WorktreeRegistry, "get">,
    private readonly services: Pick<EnvironmentServices, "status">,
    private readonly conversations: Pick<ConversationRepository, "list">,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<Result<Overview, MetatorError>> {
    const out: RunOverview[] = [];
    for (const runId of await this.runs.list()) {
      const record = await this.runs.load(runId);
      if (record.isErr()) return err(record.error);
      const r = record.value;
      const questions = await this.journal.questions(runId);
      const open = questions.isOk() ? questions.value.filter((q) => !q.answer) : [];
      const driver = await this.drivers.status(runId);
      const driving = driver.isOk() && driver.value?.alive === true;
      const spec = await this.workflows.get(r.workflow.id);
      const stage = stoppedAt(r.state.stage, r.state.status, r.state.context.history);
      const declared = spec.isOk() ? spec.value.spec.stages : [{ id: stage }];
      const stages = stageProgress(declared, stage, r.state.status, open.length);
      const atGate = stages.some((s) => s.state === "waiting" && s.hitl);
      const activity = await this.journal.activity(runId);
      const last = activity.isOk() ? activity.value.at(-1) : undefined;
      const active = r.state.status === "active";
      const end = active ? this.clock.now().getTime() : new Date(r.updatedAt).getTime();
      let worktree: RunOverview["worktree"];
      let services: RunOverview["services"] = [];
      if (r.worktree) {
        const entry = await this.registry.get(r.worktree.id);
        worktree = { ...r.worktree, ...(entry.isOk() ? { ports: entry.value.ports } : {}) };
        const status = await this.services.status({ worktree: r.worktree.id });
        // No environment file, or a worktree that is gone: the run simply has no services.
        if (status.isOk())
          services = status.value.map((s) => ({
            service: s.service,
            status: s.status,
            ports: s.ports,
            scope: s.scope,
          }));
      }
      out.push({
        runId,
        workflow: r.workflow.id,
        task: r.task,
        autonomy: r.autonomy,
        status: r.state.status,
        stage,
        attention: attentionOf(r.state.status, open.length, driving, atGate),
        stages,
        questions: open,
        driving,
        ...(driver.isOk() && driver.value ? { host: driver.value.host } : r.host ? { host: r.host } : {}),
        ...(last
          ? {
              last: {
                at: last.at,
                type: last.type,
                text: last.text,
                ...(last.stage ? { stage: last.stage } : {}),
                ...(last.agent ? { agent: last.agent } : {}),
              },
            }
          : {}),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        elapsedMs: Math.max(0, end - new Date(r.createdAt).getTime()),
        ...(worktree ? { worktree } : {}),
        services,
      });
    }
    const talks = await this.conversations.list();
    if (talks.isErr()) return err(talks.error);
    const runs = byAttention(out);
    return ok({
      runs,
      conversations: talks.value.map((c) => ({
        id: c.id,
        title: c.title,
        host: c.host,
        turns: c.turns.length,
        updatedAt: c.updatedAt,
      })),
      counts: {
        ...countAttention(runs),
        questions: runs.reduce((n, r) => n + r.questions.length, 0),
        services: runs.reduce((n, r) => n + r.services.filter((s) => s.status === "running").length, 0),
      },
    });
  }
}
