import { planId } from "../domain/architecture-plan.ts";
import type { ContractStatus } from "../domain/contract-diff.ts";
import type { AgentAnswer, AgentEvent, AgentQuestion } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  analysisFrom,
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
import type { SystemImpactQuery, SystemLocation } from "./system-sources.ts";

export const SYSTEM_SCOUT_AGENT = "mt-system-scout";
export const SYSTEM_PLANNER_AGENT = "mt-system-planner";

/** System plans and their analyses as versioned YAML documents in `metator/system/plans/`. */
export class SystemPlanStore {
  constructor(
    private readonly fs: FileSystem,
    readonly dir: string,
  ) {}

  file(id: string): string {
    return `${this.dir}/${id}.yml`;
  }

  analysisFile(id: string): string {
    return `${this.dir}/${id}.analysis.yml`;
  }

  async exists(id: string): Promise<boolean> {
    return this.fs.exists(this.file(id));
  }

  async load(id: string): Promise<Result<SystemPlan, MetatorError>> {
    const file = this.file(id);
    if (!(await this.fs.exists(file)))
      return err(
        MetatorError.notFound(`system plan ${id}`, { hint: "`metator system plan list` shows the plans." }),
      );
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const plan = parseYamlDocument(text.value, file).andThen((raw) => SystemPlanDocument.parse(raw, file));
    if (plan.isOk() && plan.value.id !== id)
      return err(new MetatorError("INVALID_CONFIG", `${file}: its id is ${plan.value.id}, not ${id}`));
    return plan;
  }

  async loadAnalysis(id: string): Promise<Result<SystemAnalysis | undefined, MetatorError>> {
    const file = this.analysisFile(id);
    if (!(await this.fs.exists(file))) return ok(undefined);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseYamlDocument(text.value, file).andThen((raw) => SystemAnalysisDocument.parse(raw, file));
  }

  async save(plan: SystemPlan): Promise<Result<void, MetatorError>> {
    const doc: DocumentHeader & Record<string, unknown> = { ...SystemPlanDocument.stamp(plan) };
    return this.fs.write(
      this.file(plan.id),
      renderYamlDocument(
        doc,
        "A system plan (metator system plan): steps per application, approved by a person.",
      ),
    );
  }

  async saveAnalysis(id: string, analysis: SystemAnalysis): Promise<Result<void, MetatorError>> {
    const doc: DocumentHeader & Record<string, unknown> = { ...SystemAnalysisDocument.stamp(analysis) };
    return this.fs.write(
      this.analysisFile(id),
      renderYamlDocument(doc, "What a task touches across the system (metator system analyze)."),
    );
  }

  async list(): Promise<Result<readonly SystemPlan[], MetatorError>> {
    const out: SystemPlan[] = [];
    for (const f of await this.fs.glob([`${this.dir}/*.yml`])) {
      if (f.endsWith(".analysis.yml")) continue;
      const plan = await this.load(f.slice(f.lastIndexOf("/") + 1, -".yml".length));
      if (plan.isErr()) return err(plan.error);
      out.push(plan.value);
    }
    return ok(out.sort((a, b) => a.id.localeCompare(b.id)));
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
    const id = planId(input.task);
    const saved = await this.store.saveAnalysis(id, analysis);
    return saved.isErr() ? err(saved.error) : ok({ id, file: this.store.analysisFile(id), analysis });
  }
}

/** `system plan new`: the analysis (kept when one exists) and a first draft by the map's policy. */
export class CreateSystemPlan {
  constructor(
    private readonly analyze: Pick<AnalyzeSystem, "execute">,
    private readonly location: Pick<SystemLocation, "load">,
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
    const map = await this.location.load();
    if (map.isErr()) return err(map.error);
    if (!map.value) return err(MetatorError.notFound("a system map"));
    let analysis = await this.store.loadAnalysis(id);
    if (analysis.isErr()) return err(analysis.error);
    if (!analysis.value) {
      const made = await this.analyze.execute(input);
      if (made.isErr()) return err(made.error);
      analysis = ok(made.value.analysis);
    }
    const plan = draftSystemPlan({
      id,
      analysis: analysis.value as SystemAnalysis,
      map: map.value,
      ...(input.by ? { by: input.by } : {}),
    });
    const saved = await this.store.save(plan);
    return saved.isErr() ? err(saved.error) : ok(plan);
  }
}

export interface LintedSystemPlan {
  readonly plan: SystemPlan;
  readonly problems: readonly SystemPlanProblem[];
}

/** `system plan lint`: the plan against the map and its saved analysis (E1). */
export class LintSystemPlan {
  constructor(
    private readonly location: Pick<SystemLocation, "load">,
    private readonly store: SystemPlanStore,
  ) {}

  async execute(id: string): Promise<Result<LintedSystemPlan, MetatorError>> {
    const plan = await this.store.load(id);
    if (plan.isErr()) return err(plan.error);
    const map = await this.location.load();
    if (map.isErr()) return err(map.error);
    if (!map.value) return err(MetatorError.notFound("a system map"));
    const analysis = await this.store.loadAnalysis(id);
    if (analysis.isErr()) return err(analysis.error);
    const problems = lintSystemPlan(plan.value, map.value, analysis.value);
    if (!analysis.value)
      problems.push({
        severity: "warning",
        message: `no analysis (${this.store.analysisFile(id)}): breaking changes are not checked`,
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
    const blocking = linted.value.problems.filter(
      (p) => p.severity === "error" && !p.message.includes("approve the plan again"),
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
 * and mt-system-planner refining the plan on the person's AI host; then the tool lints it.
 */
export class ProposeSystemPlan {
  constructor(
    private readonly hosts: ReadonlyMap<string, AgentHost>,
    private readonly analyze: Pick<AnalyzeSystem, "execute">,
    private readonly create: Pick<CreateSystemPlan, "execute">,
    private readonly lint: Pick<LintSystemPlan, "execute">,
    private readonly store: SystemPlanStore,
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
    const analysis = await this.store.loadAnalysis(id);
    if (analysis.isErr()) return err(analysis.error);
    if (!analysis.value) {
      const made = await this.analyze.execute(input);
      if (made.isErr()) return err(made.error);
    }
    const agent = async (name: string, prompt: string): Promise<Result<void, MetatorError>> => {
      let failure: string | undefined;
      for await (const e of host.run(
        {
          agent: name,
          prompt,
          cwd: input.cwd,
          projectRoot: input.projectRoot,
          runDir: `${input.projectRoot}/${this.store.dir}`,
        },
        input.ask ?? (async () => DENY),
      )) {
        input.onEvent?.(e);
        if (e.type === "result" && !e.ok) failure = e.text || `${name} stopped without a result`;
      }
      return failure === undefined
        ? ok(undefined)
        : err(
            new MetatorError("COMMAND_FAILED", `${input.host}: ${failure}`, {
              hint: `What was written is kept in ${this.store.dir}; run \`metator system plan propose\` again or edit it.`,
            }),
          );
    };
    const scouted = await agent(
      SYSTEM_SCOUT_AGENT,
      systemScoutPrompt({ analysis: this.store.analysisFile(id) }),
    );
    if (scouted.isErr()) return err(scouted.error);
    if (!(await this.store.exists(id))) {
      const created = await this.create.execute({ ...input, by: input.by });
      if (created.isErr()) return err(created.error);
    }
    const planned = await agent(
      SYSTEM_PLANNER_AGENT,
      systemPlannerPrompt({ plan: this.store.file(id), analysis: this.store.analysisFile(id) }),
    );
    if (planned.isErr()) return err(planned.error);
    return this.lint.execute(id);
  }
}

/**
 * The gate's exception (ADR-0070): a breaking change is allowed when an approved system plan
 * has a strategy for the contract and the step that breaks it (`bump`, or `contract` once its
 * migrations are done) is next.
 */
export class PlannedBreakingChanges implements BreakingAllowance {
  constructor(private readonly store: SystemPlanStore) {}

  async allows(contract: string): Promise<Result<string | undefined, MetatorError>> {
    const plans = await this.store.list();
    if (plans.isErr()) return err(plans.error);
    for (const plan of plans.value) {
      if (plan.status !== "approved" && plan.status !== "running") continue;
      if (!plan.approval || plan.approval.digest !== systemPlanDigest(plan)) continue;
      if (!plan.strategies.some((s) => s.contract === contract)) continue;
      const done = new Set(plan.steps.filter((s) => s.status === "done").map((s) => s.id));
      const step = plan.steps.find(
        (s) =>
          s.contracts.some((c) => c.id === contract && (c.role === "bump" || c.role === "contract")) &&
          s.dependsOn.every((d) => done.has(d)),
      );
      if (step)
        return ok(`planned in system plan ${plan.id} (step ${step.id}, approved by ${plan.approval.by})`);
    }
    return ok(undefined);
  }
}
