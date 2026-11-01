import type { ContractStatus } from "../domain/contract-diff.ts";
import type { AgentAnswer, AgentEvent, AgentQuestion } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { planId } from "../domain/ids.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  analysisFrom,
  breakingAllowance,
  draftSystemPlan,
  lintSystemPlan,
  type SystemAnalysis,
  SystemAnalysisDocument,
  type SystemPlan,
  SystemPlanDocument,
  type SystemPlanProblem,
  systemPlanDigest,
  systemPlannerPrompt,
  systemScoutPrompt,
} from "../domain/system-plan.ts";
import { type DocumentHeader, parseYamlDocument, renderYamlDocument } from "../domain/versioned.ts";
import type { AgentHost, Clock, FileSystem } from "../ports/index.ts";
import type { BreakingAllowance, DiffContracts } from "./contract-diff.ts";
import { DocumentStore, runAgent } from "./document-store.ts";
import type { SystemImpactQuery, SystemLocation } from "./system-sources.ts";

const SYSTEM_SCOUT_AGENT = "mt-system-scout";
const SYSTEM_PLANNER_AGENT = "mt-system-planner";

/** System plans (`<id>.yml`) and their analyses (`<id>.analysis.yml`) in `metator/system/plans/`. */
export class SystemPlanStore extends DocumentStore<SystemPlan> {
  constructor(
    private readonly files: FileSystem,
    dir: string,
  ) {
    super(files, dir, SystemPlanDocument, {
      noun: "system plan",
      listHint: "`metator system plan list` shows the plans.",
      comment: "A system plan (metator system plan): steps per application, approved by a person.",
    });
  }

  analysisFile(id: string): string {
    return `${this.dir}/${id}.analysis.yml`;
  }

  async loadAnalysis(id: string): Promise<Result<SystemAnalysis | undefined, MetatorError>> {
    const file = this.analysisFile(id);
    if (!(await this.files.exists(file))) return ok(undefined);
    const text = await this.files.read(file);
    if (text.isErr()) return err(text.error);
    return parseYamlDocument(text.value, file).andThen((raw) => SystemAnalysisDocument.parse(raw, file));
  }

  async saveAnalysis(id: string, analysis: SystemAnalysis): Promise<Result<void, MetatorError>> {
    const doc: DocumentHeader & Record<string, unknown> = { ...SystemAnalysisDocument.stamp(analysis) };
    return this.files.write(
      this.analysisFile(id),
      renderYamlDocument(doc, "What a task touches across the system (metator system analyze)."),
    );
  }
}

export interface AnalyzeInput {
  readonly task: string;
  readonly base?: string;
  readonly files?: readonly string[];
  readonly contracts?: readonly string[];
  /** Contracts the task changes in a breaking way (decided before any code exists). */
  readonly breaking?: readonly string[];
}

/** The task names what it touches: then the saved analysis is made again from it. */
const namesContracts = (input: AnalyzeInput) =>
  (input.contracts?.length ?? 0) > 0 || (input.breaking?.length ?? 0) > 0 || input.files !== undefined;

/** `system analyze` (F7.5): the impact of a task and each contract's change, saved for the plan. */
export class AnalyzeSystem {
  constructor(
    private readonly impact: Pick<SystemImpactQuery, "execute">,
    private readonly diff: Pick<DiffContracts, "execute">,
    private readonly store: SystemPlanStore,
  ) {}

  async execute(
    input: AnalyzeInput,
  ): Promise<Result<{ id: string; file: string; analysis: SystemAnalysis }, MetatorError>> {
    const id = planId(input.task);
    // An approved plan was approved against this analysis: changing it under the plan is a new task.
    if (await this.store.exists(id)) {
      const plan = await this.store.load(id);
      if (plan.isErr()) return err(plan.error);
      if (plan.value.status !== "draft")
        return err(
          MetatorError.usage(
            `system plan ${id} is ${plan.value.status}; its analysis stays as approved`,
            "Analyze a new task, or remove the plan first.",
          ),
        );
    }
    const breaking = input.breaking ?? [];
    const named = [...new Set([...(input.contracts ?? []), ...breaking])];
    const impact = await this.impact.execute({
      ...(input.files ? { files: input.files } : { base: input.base ?? "HEAD" }),
      ...(named.length > 0 ? { contracts: named } : {}),
    });
    if (impact.isErr()) return err(impact.error);
    // Only contracts this repository provides can be compared here; the rest stay unknown.
    const diffs = new Map<string, ContractStatus>();
    if (!input.files) {
      const diffed = await this.diff.execute({ base: input.base ?? "HEAD" });
      if (diffed.isErr()) return err(diffed.error);
      for (const c of diffed.value.contracts) diffs.set(c.id, c.status);
    }
    const analysis = analysisFrom({
      task: input.task,
      map: impact.value.map,
      base: impact.value.base,
      impact: impact.value,
      diffs,
      breaking: new Set(breaking),
    });
    const saved = await this.store.saveAnalysis(id, analysis);
    return saved.isErr() ? err(saved.error) : ok({ id, file: this.store.analysisFile(id), analysis });
  }
}

/** `system plan new`: the analysis (kept, unless the task names what it touches) and a first draft. */
export class CreateSystemPlan {
  constructor(
    private readonly analyze: Pick<AnalyzeSystem, "execute">,
    private readonly location: Pick<SystemLocation, "require">,
    private readonly store: SystemPlanStore,
  ) {}

  async execute(input: AnalyzeInput & { readonly by?: string }): Promise<Result<SystemPlan, MetatorError>> {
    const id = planId(input.task);
    if (await this.store.exists(id))
      return err(
        MetatorError.usage(
          `system plan ${id} already exists`,
          `Edit ${this.store.file(id)}, or pick another task.`,
        ),
      );
    const map = await this.location.require();
    if (map.isErr()) return err(map.error);
    const analysis = await this.analysisFor(id, input);
    if (analysis.isErr()) return err(analysis.error);
    const plan = draftSystemPlan({
      id,
      analysis: analysis.value,
      map: map.value,
      ...(input.by ? { by: input.by } : {}),
    });
    const saved = await this.store.save(plan);
    return saved.isErr() ? err(saved.error) : ok(plan);
  }

  private async analysisFor(id: string, input: AnalyzeInput): Promise<Result<SystemAnalysis, MetatorError>> {
    if (!namesContracts(input)) {
      const saved = await this.store.loadAnalysis(id);
      if (saved.isErr() || saved.value) return saved as Result<SystemAnalysis, MetatorError>;
    }
    return (await this.analyze.execute(input)).map((made) => made.analysis);
  }
}

export interface LintedSystemPlan {
  readonly plan: SystemPlan;
  readonly problems: readonly SystemPlanProblem[];
}

/** `system plan lint`: the plan against the map and its saved analysis (E1). */
export class LintSystemPlan {
  constructor(
    private readonly location: Pick<SystemLocation, "require">,
    private readonly store: SystemPlanStore,
  ) {}

  async execute(id: string): Promise<Result<LintedSystemPlan, MetatorError>> {
    const plan = await this.store.load(id);
    if (plan.isErr()) return err(plan.error);
    const map = await this.location.require();
    if (map.isErr()) return err(map.error);
    const analysis = await this.store.loadAnalysis(id);
    if (analysis.isErr()) return err(analysis.error);
    const problems = lintSystemPlan(plan.value, map.value, analysis.value);
    // Without an analysis nobody said what breaks: nothing to approve against.
    if (!analysis.value)
      problems.push({
        severity: "error",
        message: `no analysis (${this.store.analysisFile(id)}): run \`metator system analyze\` for the task`,
      });
    return ok({ plan: plan.value, problems });
  }
}

/** `system plan approve`: a person approves exactly these steps; lint must be clean. */
export class ApproveSystemPlan {
  constructor(
    private readonly lint: Pick<LintSystemPlan, "execute">,
    private readonly store: SystemPlanStore,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly id: string;
    readonly by: string;
  }): Promise<Result<SystemPlan, MetatorError>> {
    const linted = await this.lint.execute(input.id);
    if (linted.isErr()) return err(linted.error);
    // A stale approval is exactly what approving again fixes; every other error blocks it.
    const blocking = linted.value.problems.filter(
      (p) => p.severity === "error" && p.code !== "stale-approval",
    );
    if (blocking.length > 0)
      return err(
        new MetatorError(
          "CHECK_FAILED",
          `${input.id}: ${blocking.length} lint error(s); fix them before approving`,
          {
            hint: "`metator system plan lint` lists them.",
            details: { problems: blocking },
          },
        ),
      );
    const { plan } = linted.value;
    if (plan.status === "running" || plan.status === "done")
      return err(MetatorError.usage(`${input.id} is ${plan.status}; it cannot be approved again`));
    const approved: SystemPlan = {
      ...plan,
      status: "approved",
      approval: { by: input.by, at: this.clock.now().toISOString(), digest: systemPlanDigest(plan) },
    };
    const saved = await this.store.save(approved);
    return saved.isErr() ? err(saved.error) : ok(approved);
  }
}

const DENY: AgentAnswer = { choices: ["Deny"], text: "System agents write the analysis and the plan only." };

/**
 * `system plan propose` (F7.5): the analysis and a draft, mt-system-scout checking the analysis
 * and mt-system-planner refining the plan on the person's AI host; then the tool lints it. What
 * an agent writes is a draft: an approval it wrote itself is dropped.
 */
export class ProposeSystemPlan {
  constructor(
    private readonly hosts: ReadonlyMap<string, AgentHost>,
    private readonly analyze: Pick<AnalyzeSystem, "execute">,
    private readonly create: Pick<CreateSystemPlan, "execute">,
    private readonly lint: Pick<LintSystemPlan, "execute">,
    private readonly store: SystemPlanStore,
    /** Where the map's applications' code is on this machine: the agents read other repositories there. */
    private readonly roots?: () => Promise<readonly string[]>,
  ) {}

  async execute(
    input: AnalyzeInput & {
      readonly host: string;
      readonly by: string;
      readonly cwd: string;
      readonly projectRoot: string;
      readonly onEvent?: (e: AgentEvent) => void;
      readonly ask?: (q: AgentQuestion) => Promise<AgentAnswer>;
    },
  ): Promise<Result<LintedSystemPlan, MetatorError>> {
    const host = this.hosts.get(input.host);
    if (!host)
      return err(
        MetatorError.usage(`unknown host ${input.host}`, `Hosts: ${[...this.hosts.keys()].join(", ")}.`),
      );
    const id = planId(input.task);
    const saved = await this.store.loadAnalysis(id);
    if (saved.isErr()) return err(saved.error);
    if (!saved.value || namesContracts(input)) {
      const made = await this.analyze.execute(input);
      if (made.isErr()) return err(made.error);
    }
    const elsewhere = [...new Set(this.roots ? await this.roots() : [])].filter(
      (r) => r !== input.projectRoot && r !== input.cwd,
    );
    const agent = (name: string, prompt: string) =>
      runAgent({
        host,
        hostName: input.host,
        task: {
          agent: name,
          prompt,
          cwd: input.cwd,
          projectRoot: input.projectRoot,
          runDir: `${input.projectRoot}/${this.store.dir}`,
          ...(elsewhere.length > 0 ? { dirs: elsewhere } : {}),
        },
        deny: DENY,
        hint: `What was written is kept in ${this.store.dir}; run \`metator system plan propose\` again or edit it.`,
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
        ...(input.ask ? { ask: input.ask } : {}),
      });
    const scouted = await agent(
      SYSTEM_SCOUT_AGENT,
      systemScoutPrompt({ analysis: this.store.analysisFile(id) }),
    );
    if (scouted.isErr()) return err(scouted.error);
    if (!(await this.store.exists(id))) {
      const created = await this.create.execute(input);
      if (created.isErr()) return err(created.error);
    }
    const planned = await agent(
      SYSTEM_PLANNER_AGENT,
      systemPlannerPrompt({ plan: this.store.file(id), analysis: this.store.analysisFile(id) }),
    );
    if (planned.isErr()) return err(planned.error);
    const written = await this.store.load(id);
    if (written.isErr()) return err(written.error);
    if (written.value.approval || written.value.status !== "draft") {
      const { approval: _, ...draft } = written.value;
      const kept = await this.store.save({ ...draft, status: "draft" });
      if (kept.isErr()) return err(kept.error);
    }
    return this.lint.execute(id);
  }
}

/** The gate's exception (ADR-0070): a breaking change an approved system plan covers, when its step is next. */
export class PlannedBreakingChanges implements BreakingAllowance {
  constructor(private readonly store: Pick<SystemPlanStore, "list">) {}

  async allows(contract: string, owner: string): Promise<Result<string | undefined, MetatorError>> {
    const plans = await this.store.list();
    if (plans.isErr()) return err(plans.error);
    for (const plan of plans.value) {
      const why = breakingAllowance(plan, contract, owner);
      if (why) return ok(why);
    }
    return ok(undefined);
  }
}
