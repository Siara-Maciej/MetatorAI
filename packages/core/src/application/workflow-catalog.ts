import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { lintWorkflow, type WorkflowProblem } from "../domain/workflow-lint.ts";
import { parseWorkflowYaml, type WorkflowSpec } from "../domain/workflow-spec.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";
import type { AgentCatalog } from "./agents.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SkillCatalog } from "./skills.ts";

export interface CatalogEntry {
  readonly spec: WorkflowSpec;
  readonly source: string;
}

export interface CatalogProblem {
  readonly source: string;
  readonly error: MetatorError;
}

export interface CatalogScan {
  readonly workflows: readonly CatalogEntry[];
  readonly problems: readonly CatalogProblem[];
}

/** Workflow specs declared in the repository as YAML (one workflow per file). */
export class WorkflowCatalog {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async scan(): Promise<CatalogScan> {
    const files = await this.fs.glob([`${this.paths.workflows}/*.yml`, `${this.paths.workflows}/*.yaml`]);
    const workflows: CatalogEntry[] = [];
    const problems: CatalogProblem[] = [];
    for (const source of files) {
      const parsed = await this.parse(source);
      if (parsed.isOk()) workflows.push(parsed.value);
      else problems.push({ source, error: parsed.error });
    }
    const seen = new Map<string, string>();
    for (const entry of workflows) {
      const first = seen.get(entry.spec.id);
      if (first) {
        problems.push({
          source: entry.source,
          error: new MetatorError(
            "INVALID_CONFIG",
            `Workflow id "${entry.spec.id}" is already defined in ${first}`,
          ),
        });
      } else seen.set(entry.spec.id, entry.source);
    }
    return { workflows: workflows.filter((w) => seen.get(w.spec.id) === w.source), problems };
  }

  async get(id: string): Promise<Result<CatalogEntry, MetatorError>> {
    const { workflows, problems } = await this.scan();
    const entry = workflows.find((w) => w.spec.id === id);
    if (entry) return ok(entry);
    const broken = problems.find((p) => p.source.includes(id));
    if (broken) return err(broken.error);
    return err(
      new MetatorError("NOT_FOUND", `Workflow "${id}" not found`, {
        hint: `Known workflows: ${workflows.map((w) => w.spec.id).join(", ") || "none"}. Specs live in ${this.paths.workflows}/*.yml.`,
      }),
    );
  }

  async parse(source: string): Promise<Result<CatalogEntry, MetatorError>> {
    const text = await this.fs.read(source);
    if (text.isErr()) return err(text.error);
    return parseWorkflowYaml(text.value, source).map((spec) => ({ spec, source }));
  }
}

/** `workflow lint`: every workflow spec against the anatomy and the canonical agents and skills. */
export class LintWorkflows {
  constructor(
    private readonly catalog: Pick<WorkflowCatalog, "scan">,
    private readonly agents: Pick<AgentCatalog, "scan">,
    private readonly skills: Pick<SkillCatalog, "scan">,
  ) {}

  async execute(): Promise<
    Result<
      {
        readonly workflows: number;
        readonly problems: readonly (WorkflowProblem & {
          readonly source: string;
          readonly workflow?: string;
        })[];
      },
      MetatorError
    >
  > {
    const scan = await this.catalog.scan();
    const ctx = {
      agents: new Set((await this.agents.scan()).agents.map((a) => a.agent.id)),
      skills: new Set((await this.skills.scan()).skills.map((s) => s.skill.name)),
      maxParallel: 6,
    };
    const problems = [
      ...scan.problems.map((p) => ({
        source: p.source,
        severity: "error" as const,
        message: p.error.message,
      })),
      ...scan.workflows.flatMap((w) =>
        lintWorkflow(w.spec, ctx).map((p) => ({ ...p, source: w.source, workflow: w.spec.id })),
      ),
    ];
    return ok({ workflows: scan.workflows.length, problems });
  }
}
