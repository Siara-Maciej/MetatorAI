import { parse as parseShell } from "shell-quote";
import {
  type AgentAnswer,
  type AgentQuestion,
  gatePrompt,
  nextQuestionId,
  parseCriticVerdict,
  parseStatus,
  type Question,
  type QuestionAnswer,
  QuestionDocument,
  type RunActivity,
  RunActivityDocument,
  stagePrompt,
  stageWork,
} from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { RunEvent } from "../domain/run-machine.ts";
import { isTerminal } from "../domain/run-report.ts";
import { parseJsonDocument, serializeJsonDocument, serializeJsonLine } from "../domain/versioned.ts";
import type { StageSpec } from "../domain/workflow-spec.ts";
import type { AgentHost, Clock, FileSystem, ProcessRunner, Timer } from "../ports/index.ts";
import type { CloseRun } from "./run-close.ts";
import type { RunRepository } from "./run-repository.ts";
import type { AdvanceRun, ApproveRun } from "./runs.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

/** The free-text option every question has, so a person is never forced into a listed choice. */
export const OTHER = "Other";
/** How many times one worker may ask a person in a stage before the stage fails. */
const MAX_ANSWERS = 3;

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

      const ctx: StageContext = {
        runId,
        task: record.value.task,
        stage,
        host,
        cwd: record.value.worktree ? `${this.d.root}/${record.value.worktree.path}` : this.d.root,
        runDir: `${this.d.root}/${this.d.repo.runDir(runId)}`,
        ...(retry ? { retry } : {}),
        ...(record.value.hostSession ? { resume: record.value.hostSession } : {}),
        since: record.value.updatedAt,
        pollMs: input.pollMs ?? 500,
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
    await say({ type: "drive", text: `finished: ${status} at ${stage}` });
    return ok({ runId, status, stage, steps });
  }

  /** A HITL stage: the person approves, or rejects with a reason (FAIL). */
  private async humanGate(ctx: StageContext): Promise<Result<Outcome, MetatorError>> {
    const q = await this.d.journal.ask(
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
    const words = parseShell(script.replaceAll("{runDir}", this.d.repo.runDir(ctx.runId))).filter(
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
    const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-5).join("\n").slice(-800);
    return ok({ ok: r.exitCode === 0, tail });
  }

  /** One worker: runs until it reports done; a blocked worker asks a person, then continues. */
  private async agent(
    ctx: StageContext,
    agent: string,
    skills: readonly string[],
  ): Promise<Result<Outcome, MetatorError>> {
    let answer: string | undefined;
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
      });
      const result = await this.runHost(ctx, agent, prompt, resume);
      if (result.isErr()) return err(result.error);
      resume = result.value.session ?? resume;
      if (!result.value.ok)
        return ok({ type: "FAIL", reason: `${agent} failed: ${result.value.text.slice(-300)}` });
      const status = parseStatus(result.value.text);
      if (status?.kind !== "blocked") return ok({ type: "PASS" });
      if (answers === MAX_ANSWERS)
        return ok({ type: "FAIL", reason: `${agent} stayed blocked after ${MAX_ANSWERS} answers` });
      const q = await this.d.journal.ask(
        ctx.runId,
        {
          stage: ctx.stage.id,
          source: "agent",
          agent,
          prompt: status.question,
          options: [{ label: OTHER, description: "Your answer goes back to the agent" }],
          multiSelect: false,
        },
        ctx.since,
      );
      if (q.isErr()) return err(q.error);
      const a = await this.d.journal.waitFor(ctx.runId, q.value.id, this.d.timer, ctx.pollMs);
      if (a.isErr()) return err(a.error);
      answer = a.value.text ?? a.value.choices.join(", ");
    }
  }

  private async critic(ctx: StageContext, agent: string): Promise<Result<Outcome, MetatorError>> {
    const prompt = gatePrompt({
      runId: ctx.runId,
      task: ctx.task,
      stage: ctx.stage,
      agent,
      runDir: ctx.runDir,
    });
    const result = await this.runHost(ctx, agent, prompt, undefined);
    if (result.isErr()) return err(result.error);
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
      const asked = await this.d.journal.ask(
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
        },
        ctx.since,
      );
      if (asked.isErr()) return { choices: [], text: asked.error.message };
      const a = await this.d.journal.waitFor(ctx.runId, asked.value.id, this.d.timer, ctx.pollMs);
      return a.isOk()
        ? { choices: a.value.choices, ...(a.value.text ? { text: a.value.text } : {}) }
        : { choices: [] };
    };
    let text = "";
    let session: string | undefined;
    let okResult = false;
    try {
      for await (const event of ctx.host.run(
        {
          agent,
          prompt,
          cwd: ctx.cwd,
          projectRoot: this.d.root,
          runDir: ctx.runDir,
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
  readonly resume?: string;
  /** When the run last changed: answers given after it are still to be acted on. */
  readonly since: string;
  readonly pollMs: number;
}
