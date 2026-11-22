import { analyzeArchitecture } from "../domain/architecture.ts";
import {
  type ArchCaseScore,
  type ArchEvalCase,
  ArchEvalCaseDocument,
  failedArchCase,
  scoreArchCase,
  summarizeArchEval,
} from "../domain/architecture-eval.ts";
import { replayPlan } from "../domain/architecture-plan.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, type Result } from "../domain/result.ts";
import type { FileSystem, Sandbox } from "../ports/index.ts";
import type { ArchitectureFacts } from "./architecture.ts";
import type { ProposeRefactorPlan } from "./architecture-plans.ts";
import { loadGoldenCases, runGoldenCases } from "./golden-cases.ts";

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

  cases(): Promise<Result<readonly ArchEvalCase[], MetatorError>> {
    return loadGoldenCases(this.fs, this.dir, ArchEvalCaseDocument);
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
    const scores = await runGoldenCases({
      cases: cases.value,
      ...(input.only ? { only: input.only } : {}),
      noun: "arch eval",
      dir: this.dir,
      sandbox: this.sandbox,
      extra: this.extraFiles,
      score: (c, root) => this.scoreCase(c, root, input),
    });
    return scores.map((s) => ({ summary: summarizeArchEval(s), cases: s }));
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
