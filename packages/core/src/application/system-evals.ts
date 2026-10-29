import { MetatorError } from "../domain/errors.ts";
import { planId } from "../domain/ids.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  failedSystemCase,
  type SystemCaseScore,
  type SystemEvalCase,
  SystemEvalCaseDocument,
  scoreSystemCase,
  summarizeSystemEval,
} from "../domain/system-eval.ts";
import { parseYamlDocument } from "../domain/versioned.ts";
import type { FileSystem, Sandbox } from "../ports/index.ts";
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

  async cases(): Promise<Result<readonly SystemEvalCase[], MetatorError>> {
    const out: SystemEvalCase[] = [];
    for (const file of await this.fs.glob([`${this.dir}/*.yml`])) {
      const text = await this.fs.read(file);
      if (text.isErr()) return err(text.error);
      const parsed = parseYamlDocument(text.value, file).andThen((raw) =>
        SystemEvalCaseDocument.parse(raw, file),
      );
      if (parsed.isErr()) return err(parsed.error);
      out.push(parsed.value);
    }
    return ok(out.sort((a, b) => a.id.localeCompare(b.id)));
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
    const selected = cases.value.filter((c) => !input.only || c.id === input.only);
    if (selected.length === 0)
      return err(
        MetatorError.notFound(
          input.only ? `system eval case ${input.only}` : `system eval cases in ${this.dir}`,
        ),
      );
    const extra = input.host ? await this.extraFiles() : {};
    const scores: SystemCaseScore[] = [];
    for (const c of selected) {
      const box = await this.sandbox.create({ ...extra, ...c.files });
      if (box.isErr()) return err(box.error);
      try {
        scores.push(await this.scoreCase(c, box.value.root, input));
      } finally {
        await box.value.dispose();
      }
    }
    return ok({ summary: summarizeSystemEval(scores), cases: scores });
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
