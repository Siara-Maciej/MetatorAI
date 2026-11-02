import { parse as parseShell } from "shell-quote";
import { type AnswerPolicy, matchPolicy } from "../domain/answer-policy.ts";
import {
  type AgentAnswer,
  type AgentQuestion,
  blockedPrompt,
  type DecisionCard,
  gatePrompt,
  hostLimit,
  nextQuestionId,
  parseCriticVerdict,
  parseStatus,
  type Question,
  type QuestionAnswer,
  QuestionDocument,
  type RunActivity,
  RunActivityDocument,
  RunSeenDocument,
  stagePrompt,
  stageWork,
} from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { GateReportDocument } from "../domain/gate.ts";
import { stoppedAt } from "../domain/overview.ts";
import { PlanScopeDocument } from "../domain/plan.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { RunEvent } from "../domain/run-machine.ts";
import { messageLines, type RunMessage } from "../domain/run-message.ts";
import { APPROVAL_ACTIONS, fillInputs } from "../domain/run-record.ts";
import { isTerminal } from "../domain/run-report.ts";
import { type AgentUsage, AgentUsageDocument, type HostUsage } from "../domain/telemetry.ts";
import { VerdictDocument, verdictBlocks } from "../domain/verdict.ts";
import { parseJsonDocument, serializeJsonDocument, serializeJsonLine } from "../domain/versioned.ts";
import type { StageSpec } from "../domain/workflow-spec.ts";
import type { AgentHost, Clock, FileSystem, ProcessRunner, Timer } from "../ports/index.ts";
import type { CloseRun } from "./run-close.ts";
import type { RunRepository } from "./run-repository.ts";
import type { AdvanceRun, ApproveRun } from "./runs.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";
import type { WorktreeRegistry } from "./worktrees.ts";

/** The free-text option every question has, so a person is never forced into a listed choice. */
export const OTHER = "Other";
/**
 * A failed `metator gate` read for a person: each failing step and the first line of its output
 * (a stack trace's tail says nothing). Undefined when the output is no gate result.
 */
export function failedSteps(stdout: string): string | undefined {
  const parsed = parseJsonDocument(stdout.trim().split("\n").at(-1) ?? "", "gate output");
  if (parsed.isErr()) return undefined;
  const envelope = parsed.value;
  const error = (envelope as { error?: { message?: unknown; details?: { steps?: unknown } } } | null)?.error;
  const steps = error?.details?.steps;
  if (!Array.isArray(steps)) return undefined;
  const failed = steps
    .filter((s): s is { id: string; detail?: string } => (s as { status?: unknown }).status === "fail")
    .map((s) => {
      const first = (s.detail ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
      return `${s.id}: ${first.trim().slice(0, 300)}`;
    });
  return [typeof error?.message === "string" ? error.message : "gate failed", ...failed].join("; ");
}

/** How many times one worker may ask a person in a stage before the stage fails. */
const MAX_ANSWERS = 3;
/** The two answers to a worker that found nothing to do. */
export const CLOSE_RUN = "Close the run";
export const DO_IT = "Do it anyway";

/** How many of a person's latest answers go into every prompt. */
const MAX_DECISIONS = 12;

export type ActivityInput = Omit<RunActivity, "at">;

/** What a drive leaves in the run directory: the activity line by line, and the questions. */
export class RunJournal {
  constructor(
    private readonly fs: FileSystem,
    private readonly repo: RunRepository,
    private readonly clock: Clock,
  ) {}

  activityFile(runId: string): string {
    return `${this.repo.runDir(runId)}/activity.jsonl`;
  }

  usageFile(runId: string): string {
    return `${this.repo.runDir(runId)}/usage.jsonl`;
  }

  /** The time now, from the journal's clock: how long an agent call took. */
  now(): Date {
    return this.clock.now();
  }

  /** One agent call's usage, appended to `usage.jsonl`. */
  async recordUsage(runId: string, entry: Omit<AgentUsage, "at">): Promise<Result<void, MetatorError>> {
    const file = this.usageFile(runId);
    const before = (await this.fs.exists(file)) ? await this.fs.read(file) : ok("");
    if (before.isErr()) return err(before.error);
    const line = serializeJsonLine(
      AgentUsageDocument.stamp({ at: this.clock.now().toISOString(), ...entry }),
    );
    return this.fs.write(file, `${before.value}${line}`);
  }

  async usage(runId: string): Promise<Result<readonly AgentUsage[], MetatorError>> {
    const file = this.usageFile(runId);
    if (!(await this.fs.exists(file))) return ok([]);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const out: AgentUsage[] = [];
    for (const [i, line] of text.value.split("\n").entries()) {
      if (line.trim() === "") continue;
      const parsed = parseJsonDocument(line, `${file}:${i + 1}`).andThen((raw) =>
        AgentUsageDocument.parse(raw, `${file}:${i + 1}`),
      );
      if (parsed.isErr()) return err(parsed.error);
      out.push(parsed.value);
    }
    return ok(out);
  }

  seenFile(runId: string): string {
    return `${this.repo.runDir(runId)}/seen.json`;
  }

  /** When a person last read the run's brief; undefined before the first. */
  async seen(runId: string): Promise<Result<string | undefined, MetatorError>> {
    const file = this.seenFile(runId);
    if (!(await this.fs.exists(file))) return ok(undefined);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file)
      .andThen((raw) => RunSeenDocument.parse(raw, file))
      .map((d) => d.at);
  }

  /** A person has read the run up to now: the next brief starts here. */
  async markSeen(runId: string): Promise<Result<string, MetatorError>> {
    const at = this.clock.now().toISOString();
    const written = await this.fs.write(
      this.seenFile(runId),
      serializeJsonDocument(RunSeenDocument.stamp({ at })),
    );
    return written.map(() => at);
  }

  questionFile(runId: string, id: string): string {
    return `${this.repo.runDir(runId)}/questions/${id}.json`;
  }

  async record(runId: string, entry: ActivityInput): Promise<Result<void, MetatorError>> {
    const file = this.activityFile(runId);
    const before = (await this.fs.exists(file)) ? await this.fs.read(file) : ok("");
    if (before.isErr()) return err(before.error);
    const line = serializeJsonLine(
      RunActivityDocument.stamp({ at: this.clock.now().toISOString(), ...entry }),
    );
    return this.fs.write(file, `${before.value}${line}`);
  }

  async activity(runId: string): Promise<Result<readonly RunActivity[], MetatorError>> {
    const file = this.activityFile(runId);
    if (!(await this.fs.exists(file))) return ok([]);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const out: RunActivity[] = [];
    for (const [i, line] of text.value.split("\n").entries()) {
      if (line.trim() === "") continue;
      const parsed = parseJsonDocument(line, `${file}:${i + 1}`).andThen((raw) =>
        RunActivityDocument.parse(raw, `${file}:${i + 1}`),
      );
      if (parsed.isErr()) return err(parsed.error);
      out.push(parsed.value);
    }
    return ok(out);
  }

  async questions(runId: string): Promise<Result<readonly Question[], MetatorError>> {
    const files = await this.fs.glob([`${this.repo.runDir(runId)}/questions/q*.json`]);
    const out: Question[] = [];
    for (const file of files) {
      const text = await this.fs.read(file);
      if (text.isErr()) return err(text.error);
      const q = parseJsonDocument(text.value, file).andThen((raw) => QuestionDocument.parse(raw, file));
      if (q.isErr()) return err(q.error);
      out.push(q.value);
    }
    return ok(out.sort((a, b) => a.id.localeCompare(b.id)));
  }

  /**
   * Asks a person. A drive that restarts (`run continue`) asks again: the question it asked before
   * stands, and so does an answer given after `pendingSince` (the run's last change), which no
   * drive has acted on yet.
   */
  async ask(
    runId: string,
    q: Pick<Question, "stage" | "source" | "prompt" | "options" | "multiSelect"> & {
      readonly agent?: string;
      readonly card?: DecisionCard;
    },
    pendingSince?: string,
  ): Promise<Result<Question, MetatorError>> {
    const existing = await this.questions(runId);
    if (existing.isErr()) return err(existing.error);
    const standing = existing.value.find(
      (e) =>
        e.stage === q.stage &&
        e.source === q.source &&
        e.prompt === q.prompt &&
        (!e.answer || (pendingSince !== undefined && e.answer.at > pendingSince)),
    );
    if (standing) return ok(standing);
    const options = q.options.some((o) => o.label === OTHER)
      ? q.options
      : [...q.options, { label: OTHER, description: "Answer in your own words" }];
    const question: Question = {
      id: nextQuestionId(existing.value.map((e) => e.id)),
      runId,
      stage: q.stage,
      source: q.source,
      ...(q.agent ? { agent: q.agent } : {}),
      prompt: q.prompt,
      options,
      multiSelect: q.multiSelect,
      askedAt: this.clock.now().toISOString(),
      ...(q.card ? { card: q.card } : {}),
    };
    const saved = await this.save(question);
    if (saved.isErr()) return err(saved.error);
    const logged = await this.record(runId, {
      type: "question",
      stage: q.stage,
      ...(q.agent ? { agent: q.agent } : {}),
      text: `${question.id}: ${q.prompt}`,
    });
    if (logged.isErr()) return err(logged.error);
    return ok(question);
  }

  /** Records a person's answer; the drive waiting on the question picks it up. */
  async answer(
    runId: string,
    id: string,
    input: { readonly choices: readonly string[]; readonly text?: string; readonly by: string },
  ): Promise<Result<Question, MetatorError>> {
    const file = this.questionFile(runId, id);
    if (!(await this.fs.exists(file))) return err(MetatorError.notFound(`question ${id} of run ${runId}`));
    const q = await this.load(file);
    if (q.isErr()) return err(q.error);
    if (q.value.answer) return err(MetatorError.usage(`question ${id} is already answered`));
    const choices = input.choices.length === 0 && input.text ? [OTHER] : [...input.choices];
    const labels = q.value.options.map((o) => o.label);
    const unknown = choices.filter((c) => !labels.includes(c));
    if (choices.length === 0 || unknown.length > 0) {
      return err(
        MetatorError.usage(
          `choose from: ${labels.join(", ")}`,
          "Give --choice <label>, or --text for Other.",
        ),
      );
    }
    if (!q.value.multiSelect && choices.length > 1)
      return err(MetatorError.usage("this question takes one choice"));
    if (choices.includes(OTHER) && !input.text) return err(MetatorError.usage(`${OTHER} needs --text`));
    const answered: Question = {
      ...q.value,
      answer: {
        choices,
        ...(input.text ? { text: input.text } : {}),
        by: input.by,
        at: this.clock.now().toISOString(),
      },
    };
    const saved = await this.save(answered);
    if (saved.isErr()) return err(saved.error);
    const logged = await this.record(runId, {
      type: "answer",
      stage: q.value.stage,
      text: `${id}: ${choices.join(", ")}${input.text ? ` (${input.text})` : ""} · ${input.by}`,
    });
    if (logged.isErr()) return err(logged.error);
    return ok(answered);
  }

  /** Waits until the question has an answer; the answer comes from another process or this one. */
  async waitFor(
    runId: string,
    id: string,
    timer: Timer,
    pollMs: number,
  ): Promise<Result<QuestionAnswer, MetatorError>> {
    const file = this.questionFile(runId, id);
    for (;;) {
      const q = await this.load(file);
      if (q.isErr()) return err(q.error);
      if (q.value.answer) return ok(q.value.answer);
      await timer.sleep(pollMs);
    }
  }

  private async load(file: string): Promise<Result<Question, MetatorError>> {
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file).andThen((raw) => QuestionDocument.parse(raw, file));
  }

  private save(q: Question): Promise<Result<void, MetatorError>> {
    return this.fs.write(this.questionFile(q.runId, q.id), serializeJsonDocument(QuestionDocument.stamp(q)));
  }
}

export interface DriveInput {
  readonly runId?: string;
  /** The AI host that runs the agents (`claude`, `copilot`, `scenario`). */
  readonly host: string;
  /** A safety net against endless loops; the workflow's own loop limits come first. */
  readonly maxSteps?: number;
  readonly pollMs?: number;
}

export interface DriveReport {
  readonly runId: string;
  readonly status: string;
  readonly stage: string;
  readonly steps: number;
}

type Outcome = RunEvent | { readonly type: "STOP"; readonly reason: string };

/** Why the drive stopped on a host limit, and how the person carries on. */
const limitReason = (agent: string, limit: string) =>
  `the AI host is out of capacity for ${agent} (${limit}); the run waits at this stage: continue it when the limit resets (metator run continue)`;

export interface DriveDependencies {
  readonly catalog: WorkflowCatalog;
  readonly repo: RunRepository;
  readonly journal: RunJournal;
  readonly advance: Pick<AdvanceRun, "execute">;
  readonly approve: Pick<ApproveRun, "execute">;
  readonly close: Pick<CloseRun, "execute">;
  readonly hosts: ReadonlyMap<string, AgentHost>;
  readonly process: ProcessRunner;
  readonly fs: FileSystem;
  readonly timer: Timer;
  /** Absolute repository root. */
  readonly root: string;
  /** How scripts call MetatorAI (`hosts.metatorCommand`). */
  readonly metatorCommand: string;
  /** What agents must know about the directory they work in (dependencies not installed). */
  readonly notes?: (cwd: string) => Promise<readonly string[]>;
  /** The repository's answer policies (P5): a question one of them answers never waits. */
  readonly policies?: () => Promise<Result<readonly AnswerPolicy[], MetatorError>>;
  /** A shell command run when a question waits for a person (`notify.command`). */
  readonly notifyCommand?: string;
  /** Messages other runs sent this run (D2): its agents read them as data. */
  readonly messages?: (runId: string) => Promise<Result<readonly RunMessage[], MetatorError>>;
  /** Where gate reports are (`paths.gates`); the default when absent. */
  readonly gatesDir?: string;
  /** The worktree registry, for the ports a run's worktree holds (the card's cost of delay). */
  readonly worktrees?: Pick<WorktreeRegistry, "get">;
}

/**
 * `run drive` (F8.3): the CLI carries a run stage by stage. Scripts run as processes, agents
 * through an AI host, HITL stages and questions wait for a person's answer; the state machine
 * (`run advance`) still decides every transition, loop and escalation.
 */
export class DriveRun {
  constructor(private readonly d: DriveDependencies) {}

  async execute(input: DriveInput): Promise<Result<DriveReport, MetatorError>> {
    const host = this.d.hosts.get(input.host);
    if (!host) {
      return err(
        MetatorError.usage(`unknown AI host ${input.host}`, `Hosts: ${[...this.d.hosts.keys()].join(", ")}.`),
      );
    }
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    const say = (entry: ActivityInput) => this.d.journal.record(runId, entry);
    await say({ type: "drive", text: `driving with ${host.id}` });

    let steps = 0;
    let retry: string | undefined;
    let retryFrom: string | undefined;
    // A later stage that failed and sent the run back: every stage until it is reached again hears it.
    let sentBack: { readonly from: string; readonly reason: string } | undefined;
    for (; steps < (input.maxSteps ?? 200); steps++) {
      const record = await this.d.repo.load(runId);
      if (record.isErr()) return err(record.error);
      if (record.value.state.status !== "active") break;
      const entry = await this.d.catalog.get(record.value.workflow.id);
      if (entry.isErr()) return err(entry.error);
      const stage = entry.value.spec.stages.find((s) => s.id === record.value.state.stage);
      if (!stage)
        return err(new MetatorError("INTERNAL", `stage ${record.value.state.stage} is not in the workflow`));
      await say({ type: "stage", stage: stage.id, text: stage.description ?? stage.id });
      if (sentBack?.from === stage.id) sentBack = undefined;
      const why =
        sentBack && retryFrom !== stage.id
          ? { retry: sentBack.reason, retryFrom: sentBack.from }
          : retry
            ? { retry, ...(retryFrom ? { retryFrom } : {}) }
            : {};

      const cwd = record.value.worktree ? `${this.d.root}/${record.value.worktree.path}` : this.d.root;
      // Through the run's worktree when it has one (the worktree links the run directory in): a
      // path into the checkout would be outside the root the agent's metator commands read from.
      const runsIn = cwd;
      const ctx: StageContext = {
        runId,
        task: record.value.task,
        stage,
        host,
        cwd,
        runDir: `${runsIn}/${this.d.repo.runDir(runId)}`,
        ...why,
        ...(await this.decisions(runId)),
        ...(record.value.hostSession ? { resume: record.value.hostSession } : {}),
        since: record.value.updatedAt,
        autonomy: record.value.autonomy,
        done: passedStages(record.value.state.context.history),
        ...lastEventOf(record.value.state.context.history),
        stages: entry.value.spec.stages,
        loops: record.value.state.context.loops,
        loopLimits: entry.value.spec.loops ?? {},
        children: record.value.children ?? [],
        ...(await this.ports(record.value.worktree?.id)),
        pollMs: input.pollMs ?? 500,
        inputs: record.value.inputs ?? {},
      };
      const outcome = stage.hitl ? await this.humanGate(ctx) : await this.work(ctx);
      if (outcome.isErr()) {
        await say({ type: "error", stage: stage.id, text: outcome.error.message });
        return err(outcome.error);
      }
      if (outcome.value.type === "STOP") {
        await say({ type: "drive", stage: stage.id, text: `stopped: ${outcome.value.reason}` });
        break;
      }
      // Someone moved the run while the stage worked (an agent, a person in another terminal):
      // this outcome was for a stage the run has left, so sending it would skip the next one.
      const now = await this.d.repo.load(runId);
      if (now.isErr()) return err(now.error);
      if (now.value.state.stage !== stage.id || now.value.state.status !== "active") {
        await say({
          type: "drive",
          stage: stage.id,
          text: `the run moved on while ${stage.id} worked (now ${now.value.state.stage}, ${now.value.state.status}); its outcome is not sent`,
        });
        retry = undefined;
        continue;
      }
      const moved =
        outcome.value.type === "APPROVE"
          ? await this.d.approve.execute({
              runId,
              gate: stage.id,
              by: outcome.value.by,
              ...(outcome.value.choice ? { choice: outcome.value.choice } : {}),
            })
          : await this.d.advance.execute({ runId, event: outcome.value });
      if (moved.isErr()) {
        await say({ type: "error", stage: stage.id, text: moved.error.message });
        return err(moved.error);
      }
      retry = outcome.value.type === "FAIL" ? outcome.value.reason : undefined;
      retryFrom = outcome.value.type === "FAIL" ? stage.id : undefined;
      if (outcome.value.type === "FAIL") sentBack = { from: stage.id, reason: outcome.value.reason ?? "" };
      await say({
        type: "advance",
        stage: stage.id,
        text: outcome.value.type === "FAIL" ? `FAIL: ${outcome.value.reason ?? ""}` : outcome.value.type,
      });
    }

    const final = await this.d.repo.load(runId);
    if (final.isErr()) return err(final.error);
    const { status, stage } = final.value.state;
    if (isTerminal(status)) {
      const closed = await this.d.close.execute({ runId });
      if (closed.isErr()) return err(closed.error);
    }
    const at = stoppedAt(stage, status, final.value.state.context.history);
    await say({
      type: "drive",
      text: at === status ? `finished: ${status}` : `finished: ${status} at ${at}`,
    });
    return ok({ runId, status, stage, steps });
  }

  /** A HITL stage: the person approves, or rejects with a reason (FAIL). */
  private async humanGate(ctx: StageContext): Promise<Result<Outcome, MetatorError>> {
    const q = await this.ask(
      ctx.runId,
      {
        stage: ctx.stage.id,
        source: "gate",
        prompt: `${ctx.stage.description ?? ctx.stage.id}: approve to continue`,
        options: [
          { label: "Approve", description: "Continue with the next stage" },
          { label: "Reject", description: "Send the run back, with your reason" },
        ],
        multiSelect: false,
        // The stage before passed its checks: the evidence points to approving. A gate that grants
        // an external action (the push) starts something approving cannot take back.
        card: await this.card(ctx, {
          ...(ctx.lastEvent === "PASS" ? { recommended: "Approve" } : {}),
          reversible: (ctx.stage.grants ?? []).length === 0,
        }),
      },
      ctx.since,
    );
    if (q.isErr()) return err(q.error);
    const answer = await this.d.journal.waitFor(ctx.runId, q.value.id, this.d.timer, ctx.pollMs);
    if (answer.isErr()) return err(answer.error);
    const a = answer.value;
    if (a.choices.includes("Approve"))
      return ok({ type: "APPROVE", by: a.by, ...(a.text ? { choice: a.text } : {}) });
    return ok({ type: "FAIL", reason: a.text ?? `rejected by ${a.by}` });
  }

  /** A working stage: scripts, then agents in order, then parallel workers, then artifacts and gates. */
  private async work(ctx: StageContext): Promise<Result<Outcome, MetatorError>> {
    const work = stageWork(ctx.stage);
    for (const script of work.scripts) {
      const r = await this.script(ctx, script);
      if (r.isErr()) return err(r.error);
      if (!r.value.ok) return ok({ type: "FAIL", reason: `\`${script}\` failed: ${r.value.tail}` });
    }
    for (const agent of work.agents) {
      const r = await this.agent(ctx, agent, work.skills);
      if (r.isErr()) return err(r.error);
      if (r.value.type !== "PASS") return ok(r.value);
    }
    if (work.parallel.length > 0) {
      const results = await Promise.all(work.parallel.map((a) => this.agent(ctx, a, work.skills)));
      for (const r of results) {
        if (r.isErr()) return err(r.error);
        if (r.value.type !== "PASS") return ok(r.value);
      }
    }
    const missing: string[] = [];
    for (const artifact of ctx.stage.produces ?? []) {
      const path = `${this.d.repo.runDir(ctx.runId)}/${artifact}`;
      const there = (await this.d.fs.exists(path)) || (await this.d.fs.glob([`${path}/**`])).length > 0;
      if (!there) missing.push(artifact);
    }
    if (missing.length > 0) return ok({ type: "FAIL", reason: `missing artifacts: ${missing.join(", ")}` });
    // A stage that produces the review's verdict and can send the run back to fix it passes only on
    // an approval, whatever its critic says. Where the verdict is the deliverable (a PR review, no
    // way back), CHANGES_REQUIRED is an answer, not a failure.
    if ((ctx.stage.produces ?? []).includes("verdict.json") && ctx.stage.onFail) {
      const file = `${this.d.repo.runDir(ctx.runId)}/verdict.json`;
      const verdict = (await this.d.fs.read(file))
        .andThen((text) => parseJsonDocument(text, file))
        .andThen((raw) => VerdictDocument.parse(raw, file));
      if (verdict.isErr()) return ok({ type: "FAIL", reason: verdict.error.message });
      const blocks = verdictBlocks(verdict.value);
      if (blocks) return ok({ type: "FAIL", reason: blocks });
    }

    const gate = ctx.stage.gate;
    if (gate?.script) {
      const r = await this.script(ctx, gate.script);
      if (r.isErr()) return err(r.error);
      if (!r.value.ok) return ok({ type: "FAIL", reason: `gate \`${gate.script}\`: ${r.value.tail}` });
      await this.d.journal.record(ctx.runId, {
        type: "gate",
        stage: ctx.stage.id,
        text: `${gate.script}: pass`,
      });
    }
    if (gate?.llm) {
      const r = await this.critic(ctx, gate.llm);
      if (r.isErr()) return err(r.error);
      if (r.value.type !== "PASS") return ok(r.value);
    }
    return ok({ type: "PASS" });
  }

  private async script(
    ctx: StageContext,
    script: string,
  ): Promise<Result<{ ok: boolean; tail: string }, MetatorError>> {
    // `{runDir}` is repository-relative: the same path in the checkout and in a run's worktree (it
    // links the run directory in), where an absolute path to the checkout would be outside the root.
    const filled = fillInputs(script, ctx.inputs);
    if (filled.isErr()) return err(filled.error);
    const words = parseShell(filled.value.replaceAll("{runDir}", this.d.repo.runDir(ctx.runId))).filter(
      (w) => typeof w === "string",
    );
    if (words[0] === "metator") {
      words.splice(0, 1, ...parseShell(this.d.metatorCommand).filter((w) => typeof w === "string"));
    }
    if (words.length === 0) return err(MetatorError.usage(`empty script in stage ${ctx.stage.id}`));
    await this.d.journal.record(ctx.runId, { type: "tool", stage: ctx.stage.id, text: `$ ${script}` });
    const r = await this.d.process.run(
      { argv: words, cwd: ctx.cwd, env: { METATOR_RUN: ctx.runId, METATOR_RUN_DIR: ctx.runDir } },
      { timeoutMs: 30 * 60_000 },
    );
    const tail =
      failedSteps(r.stdout) ?? `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-5).join("\n").slice(-800);
    return ok({ ok: r.exitCode === 0, tail });
  }

  /** One worker: runs until it reports done; a blocked worker asks a person, then continues. */
  private async agent(
    ctx: StageContext,
    agent: string,
    skills: readonly string[],
  ): Promise<Result<Outcome, MetatorError>> {
    // A drive that restarts continues where the last one stopped: the agent's question, answered
    // since (or answered now), goes back to it.
    const pending = await this.pendingAnswer(ctx, agent);
    if (pending.isErr()) return err(pending.error);
    let answer = pending.value;
    let resume = ctx.resume;
    // Up to three answers, and the agent always runs again with the last one.
    for (let answers = 0; ; answers++) {
      const prompt = stagePrompt({
        runId: ctx.runId,
        task: ctx.task,
        stage: ctx.stage,
        agent,
        skills,
        runDir: ctx.runDir,
        ...(answer ? { answer } : {}),
        ...(ctx.retry ? { retry: ctx.retry } : {}),
        ...(ctx.retryFrom ? { retryFrom: ctx.retryFrom } : {}),
        ...(ctx.decisions ? { decisions: ctx.decisions } : {}),
        ...(this.d.notes ? { notes: await this.d.notes(ctx.cwd) } : {}),
        ...(await this.messageLines(ctx.runId)),
      });
      const result = await this.runHost(ctx, agent, prompt, resume);
      if (result.isErr()) return err(result.error);
      resume = result.value.session ?? resume;
      if (!result.value.ok) {
        const limit = hostLimit(result.value.text);
        if (limit) return ok({ type: "STOP", reason: limitReason(agent, limit) });
        return ok({ type: "FAIL", reason: `${agent} failed: ${result.value.text.slice(-300)}` });
      }
      const status = parseStatus(result.value.text);
      if (status?.kind === "nothing") {
        const decided = await this.nothingToDo(ctx, agent, status.evidence, result.value.text);
        if (decided.isErr()) return err(decided.error);
        if (decided.value.type === "ABORT") return ok(decided.value);
        if (answers === MAX_ANSWERS)
          return ok({ type: "FAIL", reason: `${agent} found nothing to do after ${MAX_ANSWERS} answers` });
        answer = decided.value.answer;
        continue;
      }
      if (status?.kind !== "blocked") return ok({ type: "PASS" });
      if (answers === MAX_ANSWERS)
        return ok({ type: "FAIL", reason: `${agent} stayed blocked after ${MAX_ANSWERS} answers` });
      const q = await this.ask(
        ctx.runId,
        {
          stage: ctx.stage.id,
          source: "agent",
          agent,
          prompt: blockedPrompt(result.value.text, status.question),
          options: [{ label: OTHER, description: "Your answer goes back to the agent" }],
          multiSelect: false,
          card: await this.card(ctx, { reversible: true }),
        },
        ctx.since,
      );
      if (q.isErr()) return err(q.error);
      const a = await this.d.journal.waitFor(ctx.runId, q.value.id, this.d.timer, ctx.pollMs);
      if (a.isErr()) return err(a.error);
      answer = a.value.text ?? a.value.choices.join(", ");
    }
  }

  /**
   * A worker found the task already done (or asking for no change): one decision with two
   * answers instead of a question in prose. Headless (L2), the run ends with the evidence.
   */
  private async nothingToDo(
    ctx: StageContext,
    agent: string,
    evidence: string,
    text: string,
  ): Promise<
    Result<
      | { readonly type: "ABORT"; readonly reason: string }
      | { readonly type: "GO_ON"; readonly answer: string },
      MetatorError
    >
  > {
    const reason = `nothing to do: ${evidence}`;
    if (ctx.autonomy === "L2") return ok({ type: "ABORT", reason });
    const q = await this.ask(
      ctx.runId,
      {
        stage: ctx.stage.id,
        source: "agent",
        agent,
        prompt: blockedPrompt(text, `${agent} found nothing to do: ${evidence}`),
        options: [
          { label: CLOSE_RUN, description: "Nothing changes; the run ends as aborted, with this evidence" },
          { label: DO_IT, description: "The agent goes on with the task as written" },
        ],
        multiSelect: false,
        // The worker's evidence points to closing; a closed run does not come back.
        card: await this.card(ctx, { recommended: CLOSE_RUN, reversible: false }),
      },
      ctx.since,
    );
    if (q.isErr()) return err(q.error);
    const a = await this.d.journal.waitFor(ctx.runId, q.value.id, this.d.timer, ctx.pollMs);
    if (a.isErr()) return err(a.error);
    if (a.value.choices.includes(CLOSE_RUN)) return ok({ type: "ABORT", reason });
    return ok({
      type: "GO_ON",
      answer: a.value.text ?? "A person decided the task is not done yet: do it as written.",
    });
  }

  /** The port block of the run's worktree, when it has one and the registry knows it. */
  private async ports(worktree: string | undefined): Promise<{ ports?: { from: number; count: number } }> {
    if (!worktree || !this.d.worktrees) return {};
    const entry = await this.d.worktrees.get(worktree);
    return entry.isOk() ? { ports: entry.value.ports } : {};
  }

  /** What other runs told this one, as data for its agents; nothing when there is no reader or no message. */
  private async messageLines(runId: string): Promise<{ messages?: readonly string[] }> {
    if (!this.d.messages) return {};
    const got = await this.d.messages(runId);
    if (got.isErr() || got.value.length === 0) return {};
    return { messages: messageLines(got.value) };
  }

  /**
   * Asks a person, unless an answer policy answers at once (recorded under its name). A question
   * that waits for a person is announced through `notify.command`, once.
   */
  private async ask(
    runId: string,
    q: Parameters<RunJournal["ask"]>[1],
    pendingSince?: string,
  ): Promise<Result<Question, MetatorError>> {
    const asked = await this.d.journal.ask(runId, q, pendingSince);
    if (asked.isErr() || asked.value.answer) return asked;
    const policies = this.d.policies ? await this.d.policies() : ok([]);
    if (policies.isErr()) return err(policies.error);
    const policy = matchPolicy(policies.value, asked.value);
    if (policy) {
      const answered = await this.d.journal.answer(runId, asked.value.id, {
        choices: policy.answer.choices,
        ...(policy.answer.text ? { text: policy.answer.text } : {}),
        by: `policy:${policy.id}`,
      });
      return answered;
    }
    await this.notify(asked.value);
    return asked;
  }

  /** Runs `notify.command` for a question that now waits; a failure is logged, never fatal. */
  private async notify(q: Question): Promise<void> {
    if (!this.d.notifyCommand) return;
    const activity = await this.d.journal.activity(q.runId);
    const mark = `notified ${q.id}`;
    if (activity.isOk() && activity.value.some((a) => a.type === "drive" && a.text.startsWith(mark))) return;
    const r = await this.d.process.run(
      {
        argv: ["sh", "-c", this.d.notifyCommand],
        cwd: this.d.root,
        env: {
          METATOR_RUN: q.runId,
          METATOR_QUESTION_ID: q.id,
          METATOR_QUESTION_PROMPT: q.prompt,
          METATOR_QUESTION: serializeJsonDocument(QuestionDocument.stamp(q)),
        },
      },
      { timeoutMs: 30_000 },
    );
    await this.d.journal.record(q.runId, {
      type: r.exitCode === 0 ? "drive" : "error",
      stage: q.stage,
      text:
        r.exitCode === 0
          ? mark
          : `notify.command failed for ${q.id} (exit ${r.exitCode}): ${r.stderr.trim().slice(-300)}`,
    });
  }

  /**
   * The decision card of a question (P4, D5): the task, the stages passed, the artifacts written so
   * far, what the caller knows of the recommended option and whether it can be taken back, and
   * what the record, the activity, the gate reports and the plan scope say besides.
   */
  private async card(
    ctx: StageContext,
    known: { readonly recommended?: string; readonly reversible: boolean },
  ): Promise<DecisionCard> {
    const dir = this.d.repo.runDir(ctx.runId);
    const files = await this.d.fs.glob([`${dir}/*`]);
    const artifacts = files
      .map((f) => f.slice(dir.length + 1))
      .filter((f) => !RUN_BOOKKEEPING.has(f) && !f.endsWith(".jsonl"));
    const activity = await this.d.journal.activity(ctx.runId);
    const soFar = activity.isOk() ? sinceLastAnswer(activity.value) : [];
    const evidence = await this.evidence();
    const blastRadius = await this.blastRadius(dir);
    const costOfDelay = await this.costOfDelay(ctx);
    const group = await this.group(ctx.runId);
    return {
      task: ctx.task,
      done: [...ctx.done],
      artifacts,
      ...known,
      soFar,
      evidence,
      consequences: consequencesOf(ctx.stage, ctx.stages, ctx.loops, ctx.loopLimits),
      ...(blastRadius ? { blastRadius } : {}),
      costOfDelay,
      ...(group ? { group } : {}),
    };
  }

  /** Each gate report as one line: the gate, whether it passed, every step's outcome. */
  private async evidence(): Promise<string[]> {
    const out: string[] = [];
    for (const file of await this.d.fs.glob([`${this.d.gatesDir ?? ".metator/gates"}/*.json`])) {
      const text = await this.d.fs.read(file);
      if (text.isErr()) continue;
      const report = parseJsonDocument(text.value, file).andThen((raw) =>
        GateReportDocument.parse(raw, file),
      );
      if (report.isErr()) continue;
      const steps = report.value.steps.map(
        (s) => `${s.id} ${s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : s.status}`,
      );
      out.push(`${report.value.gate}: ${report.value.passed ? "passed" : "failed"} (${steps.join(", ")})`);
    }
    return out;
  }

  /** The plan's files, and the top-level areas (first path segment) they are in. */
  private async blastRadius(dir: string): Promise<DecisionCard["blastRadius"]> {
    const file = `${dir}/plan-scope.json`;
    if (!(await this.d.fs.exists(file))) return undefined;
    const text = await this.d.fs.read(file);
    if (text.isErr()) return undefined;
    const scope = parseJsonDocument(text.value, file).andThen((raw) => PlanScopeDocument.parse(raw, file));
    if (scope.isErr()) return undefined;
    const areas = [...new Set(scope.value.edit.map((f) => f.split("/")[0] ?? f))].sort();
    return { files: scope.value.edit.length, areas };
  }

  /** What waiting costs: ports the worktree holds, loops used, children waiting on this run. */
  private async costOfDelay(ctx: StageContext): Promise<string[]> {
    const out: string[] = [];
    if (ctx.ports) out.push(`holds ports ${ctx.ports.from}–${ctx.ports.from + ctx.ports.count - 1}`);
    for (const [loop, used] of Object.entries(ctx.loops))
      if (used > 0) out.push(`loop ${loop}: ${used} of ${ctx.loopLimits[loop] ?? "?"} used`);
    if (ctx.children.length > 0) out.push(`${ctx.children.length} child run(s) depend on this run`);
    return out;
  }

  /** The feature group: the parent run, and this run's place among its children. */
  private async group(runId: string): Promise<DecisionCard["group"]> {
    const record = await this.d.repo.load(runId);
    if (record.isErr() || !record.value.parent) return undefined;
    const parent = await this.d.repo.load(record.value.parent);
    const siblings = parent.isOk() ? (parent.value.children ?? []) : [];
    const at = siblings.indexOf(runId);
    return { parent: record.value.parent, step: at >= 0 ? at + 1 : 1, of: Math.max(siblings.length, 1) };
  }

  /**
   * What a person said in this run, in their own words (an answer with text), latest last: the
   * decisions later agents follow and critics do not count as defects.
   */
  private async decisions(runId: string): Promise<{ decisions?: readonly string[] }> {
    const all = await this.d.journal.questions(runId);
    if (all.isErr()) return {};
    const said = all.value
      .filter((q) => q.answer?.text)
      .slice(-MAX_DECISIONS)
      // The question itself: its last paragraph, after any explanation the agent wrote before it.
      .map(
        (q) =>
          `${q.stage}: ${(
            q.prompt
              .trim()
              .split(/\n\s*\n/)
              .at(-1) ?? ""
          ).slice(0, 160)} → ${(q.answer?.text ?? "").slice(0, 400)}`,
      );
    return said.length > 0 ? { decisions: said } : {};
  }

  /**
   * The answer to the question this agent stopped on, when the stage's last question is its own
   * and no drive has acted on the answer yet; an open one is waited for.
   */
  private async pendingAnswer(
    ctx: StageContext,
    agent: string,
  ): Promise<Result<string | undefined, MetatorError>> {
    const all = await this.d.journal.questions(ctx.runId);
    if (all.isErr()) return err(all.error);
    const last = all.value.filter((q) => q.stage === ctx.stage.id).at(-1);
    if (last?.source !== "agent" || last.agent !== agent) return ok(undefined);
    if (last.answer && last.answer.at <= ctx.since) return ok(undefined);
    const a = last.answer
      ? ok(last.answer)
      : await this.d.journal.waitFor(ctx.runId, last.id, this.d.timer, ctx.pollMs);
    if (a.isErr()) return err(a.error);
    return ok(a.value.text ?? a.value.choices.join(", "));
  }

  private async critic(ctx: StageContext, agent: string): Promise<Result<Outcome, MetatorError>> {
    const prompt = gatePrompt({
      runId: ctx.runId,
      task: ctx.task,
      stage: ctx.stage,
      agent,
      runDir: ctx.runDir,
      ...(this.d.notes ? { notes: await this.d.notes(ctx.cwd) } : {}),
      ...(ctx.retry ? { retry: ctx.retry } : {}),
      ...(ctx.retryFrom ? { retryFrom: ctx.retryFrom } : {}),
      ...(ctx.decisions ? { decisions: ctx.decisions } : {}),
    });
    const result = await this.runHost(ctx, agent, prompt, undefined);
    if (result.isErr()) return err(result.error);
    const limit = result.value.ok ? undefined : hostLimit(result.value.text);
    if (limit) return ok({ type: "STOP", reason: limitReason(agent, limit) });
    const verdict = parseCriticVerdict(result.value.text);
    await this.d.journal.record(ctx.runId, {
      type: "gate",
      stage: ctx.stage.id,
      agent,
      text: verdict.pass ? "PASS" : `FAIL: ${verdict.reason}`,
    });
    return ok(verdict.pass ? { type: "PASS" } : { type: "FAIL", reason: `${agent}: ${verdict.reason}` });
  }

  private async runHost(
    ctx: StageContext,
    agent: string,
    prompt: string,
    resume: string | undefined,
  ): Promise<Result<{ ok: boolean; text: string; session?: string }, MetatorError>> {
    const say = (entry: ActivityInput) => this.d.journal.record(ctx.runId, entry);
    await say({ type: "agent", stage: ctx.stage.id, agent, text: `${agent} started` });
    const ask = async (q: AgentQuestion): Promise<AgentAnswer> => {
      const asked = await this.ask(
        ctx.runId,
        {
          stage: ctx.stage.id,
          source: q.source,
          agent,
          prompt: q.prompt,
          options: q.options.map((o) => ({
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
          })),
          multiSelect: q.multiSelect,
          card: await this.card(ctx, { reversible: true }),
        },
        ctx.since,
      );
      if (asked.isErr()) return { choices: [], text: asked.error.message };
      const a = await this.d.journal.waitFor(ctx.runId, asked.value.id, this.d.timer, ctx.pollMs);
      return a.isOk()
        ? { choices: a.value.choices, ...(a.value.text ? { text: a.value.text } : {}) }
        : { choices: [] };
    };
    // What a person approved so far (the push, after the delivery gate): the host lets the agent do it.
    const record = await this.d.repo.load(ctx.runId);
    const approved = record.isOk()
      ? (APPROVAL_ACTIONS as readonly string[]).filter((a) => record.value.approvals[a] !== undefined)
      : [];
    let text = "";
    let session: string | undefined;
    let okResult = false;
    let usage: HostUsage | undefined;
    const started = this.d.journal.now().getTime();
    try {
      for await (const event of ctx.host.run(
        {
          agent,
          prompt,
          cwd: ctx.cwd,
          projectRoot: this.d.root,
          runDir: ctx.runDir,
          driven: true,
          ...(approved.length > 0 ? { approved } : {}),
          ...(resume ? { resume } : {}),
        },
        ask,
      )) {
        if (event.type === "session") {
          session = event.id;
          const saved = await this.rememberSession(ctx, event.id);
          if (saved.isErr()) return err(saved.error);
        } else if (event.type === "text") {
          text = `${text}\n${event.text}`.slice(-20_000);
          await say({ type: "text", stage: ctx.stage.id, agent, text: event.text.slice(0, 600) });
        } else if (event.type === "tool") {
          await say({
            type: "tool",
            stage: ctx.stage.id,
            agent,
            text: `${event.name} ${event.summary}`.slice(0, 300),
          });
        } else {
          okResult = event.ok;
          usage = event.usage;
          if (event.text) text = `${text}\n${event.text}`.slice(-20_000);
        }
      }
    } catch (e) {
      return ok({ ok: false, text: `${ctx.host.id} failed: ${(e as Error).message}` });
    }
    await say({
      type: "agent",
      stage: ctx.stage.id,
      agent,
      text: `${agent} ${okResult ? "finished" : "failed"}`,
    });
    const measured = await this.d.journal.recordUsage(ctx.runId, {
      stage: ctx.stage.id,
      agent,
      ok: okResult,
      durationMs: Math.max(0, this.d.journal.now().getTime() - started),
      ...usage,
    });
    if (measured.isErr()) return err(measured.error);
    return ok({ ok: okResult, text: text.trim(), ...(session ? { session } : {}) });
  }

  /** The host session goes into the run, so `run continue` can resume the agent where it was. */
  private async rememberSession(ctx: StageContext, session: string): Promise<Result<void, MetatorError>> {
    const record = await this.d.repo.load(ctx.runId);
    if (record.isErr()) return err(record.error);
    return this.d.repo.save({ ...record.value, host: ctx.host.id, hostSession: session });
  }
}

interface StageContext {
  readonly runId: string;
  readonly task: string;
  readonly stage: StageSpec;
  readonly host: AgentHost;
  readonly cwd: string;
  readonly runDir: string;
  readonly retry?: string;
  readonly retryFrom?: string;
  readonly decisions?: readonly string[];
  readonly resume?: string;
  /** When the run last changed: answers given after it are still to be acted on. */
  readonly since: string;
  readonly pollMs: number;
  /** The run's inputs, for `{name}` in its scripts. */
  readonly inputs: Readonly<Record<string, string>>;
  /** L2 is headless: what a person would decide in one click is decided by the evidence. */
  readonly autonomy: string;
  /** Stages the run passed, in order (each once). */
  readonly done: readonly string[];
  /** The run's last transition (PASS, FAIL, APPROVE), when it has one. */
  readonly lastEvent?: string;
  /** The workflow's stages, the loops used so far and their limits: what each option would do. */
  readonly stages: readonly StageSpec[];
  readonly loops: Readonly<Record<string, number>>;
  readonly loopLimits: Readonly<Record<string, number>>;
  readonly children: readonly string[];
  /** The worktree's port block, when the run has one. */
  readonly ports?: { readonly from: number; readonly count: number };
}

/** Transitions and tool calls since a person last answered (the whole run before any answer). */
export function sinceLastAnswer(activity: readonly RunActivity[]): string[] {
  const last = activity.map((a) => a.type).lastIndexOf("answer");
  const after = activity.slice(last + 1);
  const out = after.filter((a) => a.type === "advance").map((a) => `${a.stage ?? "?"} ${a.text}`);
  const tools = after.filter((a) => a.type === "tool").length;
  if (tools > 0) out.push(`${tools} tool call(s)`);
  return out;
}

/** What each answer to a gate does, from the workflow: the next stage, or where a FAIL sends the run. */
export function consequencesOf(
  stage: StageSpec,
  stages: readonly StageSpec[],
  loops: Readonly<Record<string, number>>,
  limits: Readonly<Record<string, number>>,
): Record<string, string> {
  const at = stages.findIndex((s) => s.id === stage.id);
  const next = stages[at + 1];
  const out: Record<string, string> = { Approve: next ? `the run goes on to ${next.id}` : "the run is done" };
  if (stage.onFail) {
    const used = loops[stage.onFail.loop] ?? 0;
    const limit = limits[stage.onFail.loop];
    out.Reject = `back to ${stage.onFail.goto} with your reason (loop ${stage.onFail.loop}: ${used + 1}${limit ? ` of ${limit}` : ""}; past the limit the run escalates)`;
  } else out.Reject = "the run escalates with your reason: it waits for a person to resume it";
  return out;
}

/** The run's own files, which no decision rests on. */
const RUN_BOOKKEEPING = new Set(["state.json", "log.md", "driver.json", "summary.json"]);

const passedStages = (history: readonly { readonly stage: string; readonly event: string }[]): string[] => [
  ...new Set(history.filter((h) => h.event === "PASS" || h.event === "APPROVE").map((h) => h.stage)),
];

const lastEventOf = (history: readonly { readonly event: string }[]) => {
  const last = history.at(-1);
  return last ? { lastEvent: last.event } : {};
};
