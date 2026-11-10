import type { MetatorError } from "../domain/errors.ts";
import { type QuarterlyReview, QuarterlyReviewDocument, reviewActions } from "../domain/quarterly-review.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import type { DocsInventory } from "./docs.ts";
import type { CompareEvals } from "./evals.ts";
import type { MemoryBudget } from "./memory.ts";
import type { MetatorPaths } from "./paths.ts";
import type { MeasureRuleCoverage } from "./rules.ts";

export interface QuarterlyReviewDependencies {
  readonly coverage: Pick<MeasureRuleCoverage, "execute">;
  readonly budget: Pick<MemoryBudget, "execute">;
  readonly inventory: Pick<DocsInventory, "execute">;
  readonly compare: Pick<CompareEvals, "execute">;
  readonly fs: FileSystem;
  readonly paths: Pick<MetatorPaths, "lessons" | "rules" | "reviews">;
  readonly clock: Clock;
}

/**
 * `metator meta quarterly` (F6): the quarterly review as one document from the tools that
 * already exist: rule coverage and dead rules, memory budgets, documents untouched for a season,
 * lessons nobody promoted, the review evals against their baseline. Written under `paths.reviews`.
 */
export class RunQuarterlyReview {
  constructor(private readonly d: QuarterlyReviewDependencies) {}

  async execute(input: {
    readonly staleDays?: number;
    /** An EvalReport of the baseline and one of the current state; both needed for a comparison. */
    readonly baseline?: string;
    readonly report?: string;
    readonly tolerance?: number;
  }): Promise<Result<QuarterlyReview & { readonly output: string }, MetatorError>> {
    const staleDays = input.staleDays ?? 90;
    const coverage = await this.d.coverage.execute();
    if (coverage.isErr()) return err(coverage.error);
    const budget = await this.d.budget.execute();
    if (budget.isErr()) return err(budget.error);
    const inventory = await this.d.inventory.execute();
    if (inventory.isErr()) return err(inventory.error);
    const now = this.d.clock.now();
    const lessonFiles = await this.d.fs.glob([`${this.d.paths.lessons}/*.md`]);
    const ruleFiles = await this.d.fs.glob([`${this.d.paths.rules}/*.yml`]);
    let canon = "";
    for (const f of ruleFiles) canon += (await this.d.fs.read(f)).unwrapOr("");
    const unpromoted: { id: string; ageDays: number }[] = [];
    for (const f of lessonFiles) {
      const id = f.slice(f.lastIndexOf("/") + 1).replace(/\.md$/, "");
      const row = inventory.value.documents.find((d) => d.path === f);
      const ageDays = row?.ageDays ?? 0;
      if (ageDays >= staleDays && !canon.includes(id)) unpromoted.push({ id, ageDays });
    }
    let evals: QuarterlyReview["evals"] = {
      status: "no-baseline",
      hint: "pass --baseline <EvalReport> and --report <EvalReport> from `metator eval run`",
    };
    if (
      input.baseline &&
      input.report &&
      (await this.d.fs.exists(input.baseline)) &&
      (await this.d.fs.exists(input.report))
    ) {
      const compared = await this.d.compare.execute({
        before: input.baseline,
        after: input.report,
        tolerance: input.tolerance ?? 0.02,
      });
      evals = compared.isOk()
        ? { status: "compared", regressions: [...compared.value.regressions] }
        : { status: "no-baseline", hint: compared.error.message };
    }
    const body: Omit<QuarterlyReview, "actions"> = {
      generatedAt: now.toISOString(),
      staleDays,
      rules: {
        active: coverage.value.total.active,
        e1: coverage.value.total.E1,
        e1Percent: coverage.value.total.e1Percent,
        dead: [...coverage.value.dead],
        e1WithoutTest: [...coverage.value.e1WithoutTest],
        e1Disabled: [...coverage.value.e1Disabled],
      },
      memory: {
        items: budget.value.items.length,
        overBudget: budget.value.items.flatMap((i) =>
          i.over.map((o) => ({ item: i.id, path: o.path, over: [...o.over] })),
        ),
      },
      docs: {
        total: inventory.value.documents.length,
        stale: inventory.value.documents
          .filter((d) => (d.ageDays ?? 0) >= staleDays)
          .map((d) => ({ path: d.path, ageDays: d.ageDays ?? 0 }))
          .sort((a, b) => b.ageDays - a.ageDays),
        deadLinks: inventory.value.documents.reduce((n, d) => n + d.deadLinks, 0),
      },
      lessons: { total: lessonFiles.length, unpromoted },
      evals,
    };
    const review: QuarterlyReview = { ...body, actions: reviewActions(body) };
    const output = `${this.d.paths.reviews}/quarterly-${now.toISOString().slice(0, 10)}.json`;
    const saved = await this.d.fs.write(output, serializeJsonDocument(QuarterlyReviewDocument.stamp(review)));
    if (saved.isErr()) return err(saved.error);
    return ok({ ...review, output });
  }
}
