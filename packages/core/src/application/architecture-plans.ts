import { analyzeArchitecture } from "../domain/architecture.ts";
import {
  type ArchCaseScore,
  type ArchEvalCase,
  ArchEvalCaseDocument,
  failedArchCase,
  scoreArchCase,
  summarizeArchEval,
} from "../domain/architecture-eval.ts";
import {
  describeMove,
  lintRefactorPlan,
  nextWave,
  type PlanGoal,
  planDigest,
  plannerPrompt,
  type RefactorPlan,
  RefactorPlanDocument,
  type RefactorPlanProblem,
  replayPlan,
  simulatePlan,
} from "../domain/architecture-plan.ts";
import type { AgentAnswer, AgentEvent, AgentQuestion } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { planId } from "../domain/ids.ts";
import { progressOf } from "../domain/plan-progress.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseYamlDocument } from "../domain/versioned.ts";
import type { AgentHost, Clock, FileSystem, Sandbox } from "../ports/index.ts";
import type { AnalyzeArchitecture, ArchitectureFacts } from "./architecture.ts";
import { DocumentStore, runAgent } from "./document-store.ts";
import type { RunRepository } from "./run-repository.ts";
import type { InitRun } from "./runs.ts";

export const ARCH_PLANNER_AGENT = "mt-arch-planner";
/** The workflow each move runs in: W3, refactor that keeps behavior. */
export const PLAN_WORKFLOW = "mt-refactor";

/** Refactor plans as versioned YAML documents in `metator/arch/plans/`. */
export class RefactorPlanStore extends DocumentStore<RefactorPlan> {
  constructor(fs: FileSystem, dir: string) {
    super(fs, dir, RefactorPlanDocument, {
      noun: "refactor plan",
      listHint: "`metator arch plan list` shows the plans.",
      comment:
        "A refactor plan (metator arch plan). Effects and the result are written by `arch plan simulate`.",
    });
  }
}

/** `arch plan new`: an empty draft with its goal. */
export class CreateRefactorPlan {
  constructor(private readonly store: RefactorPlanStore) {}

  async execute(input: {
    readonly title: string;
    readonly goal: PlanGoal;
    readonly by?: string;
  }): Promise<Result<RefactorPlan, MetatorError>> {
    const id = planId(input.title);
    if (await this.store.exists(id))
      return err(
        MetatorError.usage(
          `refactor plan ${id} already exists`,
          `Edit ${this.store.file(id)}, or pick another title.`,
        ),
      );
    const plan: RefactorPlan = {
      id,
      title: input.title,
      goal: input.goal,
      status: "draft",
      ...(input.by ? { createdBy: input.by } : {}),
      moves: [],
    };
    const saved = await this.store.save(plan);
    return saved.isErr() ? err(saved.error) : ok(plan);
  }
}

/** `arch plan simulate`: writes every move's effect and the whole result into the plan. */
export class SimulateRefactorPlan {
  constructor(
    private readonly facts: Pick<ArchitectureFacts, "gather">,
    private readonly store: RefactorPlanStore,
  ) {}

  async execute(id: string): Promise<Result<RefactorPlan, MetatorError>> {
    const plan = await this.store.load(id);
    if (plan.isErr()) return err(plan.error);
    const facts = await this.facts.gather();
    if (facts.isErr()) return err(facts.error);
    const simulated = simulatePlan(facts.value, plan.value);
    const saved = await this.store.save(simulated);
    return saved.isErr() ? err(saved.error) : ok(simulated);
  }
}

export interface LintedPlan {
  readonly plan: RefactorPlan;
  readonly problems: readonly RefactorPlanProblem[];
}

/** `arch plan lint`: the plan against the current repository (E1). */
export class LintRefactorPlan {
  constructor(
    private readonly facts: Pick<ArchitectureFacts, "gather">,
    private readonly store: RefactorPlanStore,
    private readonly fs: FileSystem,
  ) {}

  async execute(id: string): Promise<Result<LintedPlan, MetatorError>> {
    const plan = await this.store.load(id);
    if (plan.isErr()) return err(plan.error);
    const facts = await this.facts.gather();
    if (facts.isErr()) return err(facts.error);
    const cited = [
      ...new Set(plan.value.moves.flatMap((m) => m.citations.map((c) => c.replace(/:\d+(-\d+)?$/, "")))),
    ];
    const present = new Set<string>();
    for (const c of cited) if (await this.fs.exists(c)) present.add(c);
    return ok({
      plan: plan.value,
      problems: lintRefactorPlan(plan.value, facts.value, (p) => present.has(p)),
    });
  }
}

/** `arch plan approve`: a person approves exactly these moves; lint must be clean. */
export class ApproveRefactorPlan {
  constructor(
    private readonly lint: Pick<LintRefactorPlan, "execute">,
    private readonly store: RefactorPlanStore,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly id: string;
    readonly by: string;
  }): Promise<Result<RefactorPlan, MetatorError>> {
    const linted = await this.lint.execute(input.id);
    if (linted.isErr()) return err(linted.error);
    const errors = linted.value.problems.filter((p) => p.severity === "error");
    const { plan } = linted.value;
    // A stale approval is exactly what re-approving fixes; every other error blocks it.
    const blocking = errors.filter((p) => p.code !== "stale-approval");
    if (blocking.length > 0)
      return err(
        new MetatorError(
          "CHECK_FAILED",
          `${input.id}: ${blocking.length} lint error(s); fix them before approving`,
          {
            hint: "`metator arch plan lint` lists them.",
            details: { problems: blocking },
          },
        ),
      );
    if (plan.status === "running" || plan.status === "done")
      return err(MetatorError.usage(`${input.id} is ${plan.status}; it cannot be approved again`));
    const approved: RefactorPlan = {
      ...plan,
      status: "approved",
      approval: { by: input.by, at: this.clock.now().toISOString(), digest: planDigest(plan) },
    };
    const saved = await this.store.save(approved);
    return saved.isErr() ? err(saved.error) : ok(approved);
  }
}

export interface ProposeInput {
  readonly title: string;
  readonly goal: PlanGoal;
  readonly host: string;
  readonly by: string;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly onEvent?: (e: AgentEvent) => void;
  readonly ask?: (q: AgentQuestion) => Promise<AgentAnswer>;
}

const DENY: AgentAnswer = {
  choices: ["Deny"],
  text: "mt-arch-planner writes the plan only; no code changes.",
};

/**
 * `arch plan propose` (H5): a fresh report, a draft plan, and mt-arch-planner on the person's AI
 * host filling it with moves it tried; then the tool simulates and lints what it wrote. What the
 * agent writes is a draft: an approval it wrote itself is dropped.
 */
export class ProposeRefactorPlan {
  constructor(
    private readonly hosts: ReadonlyMap<string, AgentHost>,
    private readonly analyze: Pick<AnalyzeArchitecture, "execute">,
    private readonly store: RefactorPlanStore,
    private readonly create: Pick<CreateRefactorPlan, "execute">,
    private readonly simulate: Pick<SimulateRefactorPlan, "execute">,
    private readonly lint: Pick<LintRefactorPlan, "execute">,
  ) {}

  async execute(input: ProposeInput): Promise<Result<LintedPlan, MetatorError>> {
    const host = this.hosts.get(input.host);
    if (!host)
      return err(
        MetatorError.usage(`unknown host ${input.host}`, `Hosts: ${[...this.hosts.keys()].join(", ")}.`),
      );
    const analyzed = await this.analyze.execute();
    if (analyzed.isErr()) return err(analyzed.error);
    const id = planId(input.title);
    if (!(await this.store.exists(id))) {
      const created = await this.create.execute({ title: input.title, goal: input.goal, by: input.by });
      if (created.isErr()) return err(created.error);
    }
    const planned = await runAgent({
      host,
      hostName: input.host,
      task: {
        agent: ARCH_PLANNER_AGENT,
        prompt: plannerPrompt({
          plan: this.store.file(id),
          goal: input.goal,
          report: analyzed.value.files.markdown,
        }),
        cwd: input.cwd,
        projectRoot: input.projectRoot,
        runDir: `${input.projectRoot}/${this.store.dir}`,
      },
      deny: DENY,
      hint: `The draft is kept in ${this.store.file(id)}; run \`metator arch plan propose\` again or edit it.`,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      ...(input.ask ? { ask: input.ask } : {}),
    });
    if (planned.isErr()) return err(planned.error);
    const written = await this.store.load(id);
    if (written.isErr()) return err(written.error);
    if (written.value.approval || written.value.status !== "draft") {
      const { approval: _, ...draft } = written.value;
      const kept = await this.store.save({ ...draft, status: "draft" });
      if (kept.isErr()) return err(kept.error);
    }
    const simulated = await this.simulate.execute(id);
    if (simulated.isErr()) return err(simulated.error);
    return this.lint.execute(id);
  }
}

export interface StartedMove {
  readonly move: string;
  readonly run: string;
  readonly task: string;
}

/** `arch plan run`: the next wave of an approved plan, one W3 run per move, each in its worktree. */
export class RunRefactorPlan {
  constructor(
    private readonly store: RefactorPlanStore,
    private readonly init: Pick<InitRun, "execute">,
  ) {}

  async execute(input: {
    readonly id: string;
    readonly base?: string;
  }): Promise<
    Result<
      { readonly plan: RefactorPlan; readonly wave: number | null; readonly started: readonly StartedMove[] },
      MetatorError
    >
  > {
    const loaded = await this.store.load(input.id);
    if (loaded.isErr()) return err(loaded.error);
    let plan = loaded.value;
    if (plan.status === "draft" || !plan.approval)
      return err(
        MetatorError.usage(
          `${plan.id} is not approved`,
          `A person approves it: \`metator arch plan approve ${plan.id} --by <name>\`.`,
        ),
      );
    if (plan.approval.digest !== planDigest(plan))
      return err(
        MetatorError.usage(
          `the moves of ${plan.id} changed after ${plan.approval.by} approved them`,
          "Approve the plan again.",
        ),
      );
    const next = nextWave(plan);
    if (!next) return ok({ plan, wave: null, started: [] });
    if (next.moves.length === 0 && next.blocked.length > 0)
      return err(
        MetatorError.usage(
          `wave ${next.wave} of ${plan.id} is blocked: ${next.blocked.map((m) => `${m.id} (${m.note ?? "blocked"})`).join(", ")}`,
          `Finish or fix the move by hand, then set its status to pending (to run it again) or done in ${this.store.file(plan.id)}.`,
        ),
      );
    const started: StartedMove[] = [];
    for (const m of next.moves) {
      const task = `${describeMove(m.move)}. Why: ${m.why} (refactor plan ${plan.id}, move ${m.id}; evidence: ${m.citations.join(", ")})`;
      const run = await this.init.execute({
        workflow: PLAN_WORKFLOW,
        task,
        worktree: input.base ? { base: input.base } : {},
      });
      if (run.isErr()) return err(run.error);
      started.push({ move: m.id, run: run.value.runId, task });
      plan = {
        ...plan,
        status: "running",
        moves: plan.moves.map((x) => (x.id === m.id ? { ...x, status: "running", run: run.value.runId } : x)),
      };
      const saved = await this.store.save(plan);
      if (saved.isErr()) return err(saved.error);
    }
    return ok({ plan, wave: next.wave, started });
  }
}

/** `arch plan status`: the moves' runs read back into the plan (done, blocked) and the plan's state. */
export class SyncRefactorPlan {
  constructor(
    private readonly store: RefactorPlanStore,
    private readonly runs: Pick<RunRepository, "load">,
  ) {}

  async execute(id: string): Promise<Result<RefactorPlan, MetatorError>> {
    const loaded = await this.store.load(id);
    if (loaded.isErr()) return err(loaded.error);
    const moves = [];
    for (const m of loaded.value.moves) {
      if (m.status !== "running" || !m.run) {
        moves.push(m);
        continue;
      }
      const run = await this.runs.load(m.run);
      if (run.isErr()) return err(run.error);
      const status = progressOf(run.value.state.status, m.status);
      moves.push(
        status === "blocked"
          ? { ...m, status, note: `run ${m.run} ${run.value.state.status}` }
          : { ...m, status },
      );
    }
    const plan: RefactorPlan = {
      ...loaded.value,
      moves,
      ...(moves.length > 0 && moves.every((m) => m.status === "done") ? { status: "done" as const } : {}),
    };
    const saved = await this.store.save(plan);
    return saved.isErr() ? err(saved.error) : ok(plan);
  }
}

/** The tools of one sandbox repository, built for its root (the CLI makes a container there). */
export interface ArchEvalWorkspace {
  readonly propose: Pick<ProposeRefactorPlan, "execute">;
  readonly facts: Pick<ArchitectureFacts, "gather">;
}

/** `arch eval run` (H7): every golden case in a fresh repository, planned by the host, scored. */
export class RunArchEvals {
  constructor(
    private readonly fs: FileSystem,
    private readonly dir: string,
    private readonly sandbox: Sandbox,
    private readonly workspaceAt: (root: string) => ArchEvalWorkspace,
    /** Files every sandbox gets besides the case's (the planner's host agent definitions). */
    private readonly extraFiles: () => Promise<Readonly<Record<string, string>>> = async () => ({}),
  ) {}

  async cases(): Promise<Result<readonly ArchEvalCase[], MetatorError>> {
    const out: ArchEvalCase[] = [];
    for (const file of await this.fs.glob([`${this.dir}/*.yml`])) {
      const text = await this.fs.read(file);
      if (text.isErr()) return err(text.error);
      const parsed = parseYamlDocument(text.value, file).andThen((raw) =>
        ArchEvalCaseDocument.parse(raw, file),
      );
      if (parsed.isErr()) return err(parsed.error);
      out.push(parsed.value);
    }
    return ok(out.sort((a, b) => a.id.localeCompare(b.id)));
  }

  async execute(input: {
    readonly host: string;
    readonly by: string;
    readonly only?: string;
  }): Promise<
    Result<
      { readonly summary: ReturnType<typeof summarizeArchEval>; readonly cases: readonly ArchCaseScore[] },
      MetatorError
    >
  > {
    const cases = await this.cases();
    if (cases.isErr()) return err(cases.error);
    const selected = cases.value.filter((c) => !input.only || c.id === input.only);
    if (selected.length === 0)
      return err(
        MetatorError.notFound(input.only ? `arch eval case ${input.only}` : `arch eval cases in ${this.dir}`),
      );
    const scores: ArchCaseScore[] = [];
    const extra = await this.extraFiles();
    for (const c of selected) {
      const box = await this.sandbox.create({ ...extra, ...c.files });
      if (box.isErr()) return err(box.error);
      try {
        scores.push(await this.scoreCase(c, box.value.root, input));
      } finally {
        await box.value.dispose();
      }
    }
    return ok({ summary: summarizeArchEval(scores), cases: scores });
  }

  private async scoreCase(
    c: ArchEvalCase,
    root: string,
    input: { readonly host: string; readonly by: string },
  ) {
    const ws = this.workspaceAt(root);
    const facts = await ws.facts.gather();
    if (facts.isErr()) return failedArchCase(c.id, facts.error.message);
    const proposed = await ws.propose.execute({
      title: c.id,
      goal: c.goal,
      host: input.host,
      by: input.by,
      cwd: root,
      projectRoot: root,
    });
    if (proposed.isErr()) return failedArchCase(c.id, proposed.error.message);
    // A move that cannot run leaves nothing to score: its simulated result would be fiction.
    const replayed = replayPlan(facts.value, proposed.value.plan);
    if (replayed.problems.length > 0)
      return failedArchCase(
        c.id,
        `impossible moves: ${replayed.problems.map((p) => `${p.move}: ${p.message}`).join("; ")}`,
      );
    return scoreArchCase({
      case: c,
      plan: proposed.value.plan,
      problems: proposed.value.problems,
      before: analyzeArchitecture(facts.value),
      after: analyzeArchitecture(replayed.state),
    });
  }
}
