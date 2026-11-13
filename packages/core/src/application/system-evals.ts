import type { MetatorError } from "../domain/errors.ts";
import { planId } from "../domain/ids.ts";
import { err, type Result } from "../domain/result.ts";
import {
  failedSystemCase,
  type SystemCaseScore,
  type SystemEvalCase,
  SystemEvalCaseDocument,
  scoreSystemCase,
  summarizeSystemEval,
} from "../domain/system-eval.ts";
import type { FileSystem, Sandbox } from "../ports/index.ts";
import { loadGoldenCases, runGoldenCases } from "./golden-cases.ts";
import type { CreateSystemPlan, LintSystemPlan, ProposeSystemPlan, SystemPlanStore } from "./system-plans.ts";

/** The system tools of one sandbox repository, built for its root (the CLI makes a container there). */
export interface SystemEvalWorkspace {
  readonly create: Pick<CreateSystemPlan, "execute">;
  readonly propose: Pick<ProposeSystemPlan, "execute">;
  readonly lint: Pick<LintSystemPlan, "execute">;
  readonly store: Pick<SystemPlanStore, "loadAnalysis">;
}

/**
 * `system eval run` (F7.7): every golden case in a fresh repository, analyzed and planned by the
 * tool alone, or with the system agents on a host (`--host`), and scored.
 */
export class RunSystemEvals {
  constructor(
    private readonly fs: FileSystem,
    private readonly dir: string,
    private readonly sandbox: Sandbox,
    private readonly workspaceAt: (root: string) => SystemEvalWorkspace,
    /** Files every sandbox gets besides the case's (the system agents' host definitions). */
    private readonly extraFiles: () => Promise<Readonly<Record<string, string>>> = async () => ({}),
  ) {}

  cases(): Promise<Result<readonly SystemEvalCase[], MetatorError>> {
    return loadGoldenCases(this.fs, this.dir, SystemEvalCaseDocument);
  }

  async execute(input: {
    /** With a host, mt-system-scout and mt-system-planner refine what the tool drafts. */
    readonly host?: string;
    readonly by: string;
    readonly only?: string;
  }): Promise<
    Result<
      {
        readonly summary: ReturnType<typeof summarizeSystemEval>;
        readonly cases: readonly SystemCaseScore[];
      },
      MetatorError
    >
  > {
    const cases = await this.cases();
    if (cases.isErr()) return err(cases.error);
    const scores = await runGoldenCases({
      cases: cases.value,
      ...(input.only ? { only: input.only } : {}),
      noun: "system eval",
      dir: this.dir,
      sandbox: this.sandbox,
      // The agents' host definitions are needed only when a host refines the plan.
      extra: input.host ? this.extraFiles : async () => ({}),
      score: (c, root) => this.scoreCase(c, root, input),
    });
    return scores.map((s) => ({ summary: summarizeSystemEval(s), cases: s }));
  }

  private async scoreCase(
    c: SystemEvalCase,
    root: string,
    input: { readonly host?: string; readonly by: string },
  ): Promise<SystemCaseScore> {
    const ws = this.workspaceAt(root);
    const task = {
      task: c.task,
      ...(c.input.contracts ? { contracts: c.input.contracts } : {}),
      ...(c.input.breaking ? { breaking: c.input.breaking } : {}),
    };
    const linted = input.host
      ? await ws.propose.execute({ ...task, host: input.host, by: input.by, cwd: root, projectRoot: root })
      : await (async () => {
          const created = await ws.create.execute({ ...task, by: input.by });
          return created.isErr() ? err(created.error) : ws.lint.execute(created.value.id);
        })();
    if (linted.isErr()) return failedSystemCase(c.id, linted.error.message);
    const analysis = await ws.store.loadAnalysis(planId(c.task));
    if (analysis.isErr()) return failedSystemCase(c.id, analysis.error.message);
    if (!analysis.value) return failedSystemCase(c.id, "no analysis was written");
    return scoreSystemCase({
      case: c,
      analysis: analysis.value,
      plan: linted.value.plan,
      problems: linted.value.problems,
    });
  }
}
