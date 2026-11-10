import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  err,
  MetatorError,
  ok,
  QuarterlyReviewDocument,
  RunQuarterlyReview,
  reviewActions,
} from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const coverage = (over: Partial<{ dead: string[]; e1WithoutTest: string[]; e1Percent: number }> = {}) => ({
  total: { area: "all", active: 20, E1: 20, E2: 0, E3: 0, e1Percent: over.e1Percent ?? 100 },
  byArea: [],
  e1WithoutTest: over.e1WithoutTest ?? [],
  e1Unverified: [],
  e1Disabled: [],
  dead: over.dead ?? [],
  e2WithoutExamples: [],
});

describe("quarterly review", () => {
  test("the actions follow the numbers: nothing to do when everything holds", () => {
    const base = {
      generatedAt: "2026-11-10T00:00:00.000Z",
      staleDays: 90,
      rules: { active: 20, e1: 20, e1Percent: 100, dead: [], e1WithoutTest: [], e1Disabled: [] },
      memory: { items: 24, overBudget: [] },
      docs: { total: 299, stale: [], deadLinks: 0 },
      lessons: { total: 3, unpromoted: [] },
      evals: { status: "compared" as const, regressions: [] },
    };
    expect(reviewActions(base)).toEqual(["nothing to retire, raise or promote this quarter"]);
    const busy = reviewActions({
      ...base,
      rules: { ...base.rules, dead: ["MT-CODE-009"], e1Percent: 95 },
      docs: { total: 299, stale: [{ path: "docs/old.md", ageDays: 120 }], deadLinks: 2 },
      lessons: { total: 3, unpromoted: [{ id: "old-lesson", ageDays: 100 }] },
      evals: { status: "no-baseline", hint: "x" },
    });
    expect(busy).toEqual([
      "retire or re-scope 1 rule(s) that apply to no file: MT-CODE-009",
      "raise E1 coverage from 95%: every rule a tool can decide, a tool decides",
      "read 1 document(s) untouched for 90+ days: still true, or drift?",
      "fix 2 dead link(s)",
      "promote to a rule or retire 1 lesson(s) older than 90 days",
      "commit an eval baseline so the next quarter compares against it",
    ]);
  });

  test("the review reads coverage, budgets, the inventory, the lessons and the evals, and writes one document", async () => {
    const fs = new InMemoryFileSystem({
      "docs/metator/lessons/old-lesson.md": "# old",
      "docs/metator/lessons/promoted-lesson.md": "# promoted",
      "docs/metator/lessons/new-lesson.md": "# new",
      "docs/metator/rules/code.yml": "rules:\n  - id: MT-CODE-010\n    from: promoted-lesson\n",
      "before.json": "{}",
      "after.json": "{}",
    });
    const clock = new FixedClock(new Date("2026-11-10T12:00:00.000Z"));
    const review = new RunQuarterlyReview({
      coverage: { execute: async () => ok(coverage({ dead: ["MT-CODE-009"] })) },
      budget: {
        execute: async () =>
          ok({
            items: [
              {
                id: "t0.agents",
                files: 2,
                over: [
                  {
                    path: "AGENTS.md",
                    size: { chars: 5000, lines: 90, tokens: 1250 },
                    over: ["chars 5000 > 4000"],
                  },
                ],
              },
              { id: "t1.adr", files: 82, over: [] },
            ],
            tiers: [],
            overBudget: 1,
          } as never),
      },
      inventory: {
        execute: async () =>
          ok({
            documents: [
              {
                path: "docs/metator/lessons/old-lesson.md",
                lines: 3,
                ageDays: 120,
                owners: [],
                links: 0,
                deadLinks: 0,
              },
              {
                path: "docs/metator/lessons/promoted-lesson.md",
                lines: 3,
                ageDays: 200,
                owners: [],
                links: 0,
                deadLinks: 0,
              },
              {
                path: "docs/metator/lessons/new-lesson.md",
                lines: 3,
                ageDays: 2,
                owners: [],
                links: 0,
                deadLinks: 0,
              },
              { path: "docs/old.md", lines: 10, ageDays: 95, owners: [], links: 2, deadLinks: 1 },
              { path: "README.md", lines: 10, ageDays: 1, owners: [], links: 0, deadLinks: 0 },
            ],
          }),
      },
      compare: {
        execute: async (input) =>
          input.before === "before.json"
            ? ok({ before: {} as never, after: {} as never, regressions: ["recall 0.9 -> 0.8"] })
            : err(new MetatorError("NOT_FOUND", "no report")),
      },
      fs,
      paths: DEFAULT_PATHS,
      clock,
    });
    const r = (
      await review.execute({ staleDays: 90, baseline: "before.json", report: "after.json" })
    )._unsafeUnwrap();
    expect(r.rules).toMatchObject({ active: 20, e1: 20, e1Percent: 100, dead: ["MT-CODE-009"] });
    expect(r.memory).toEqual({
      items: 2,
      overBudget: [{ item: "t0.agents", path: "AGENTS.md", over: ["chars 5000 > 4000"] }],
    });
    expect(r.docs).toEqual({
      total: 5,
      stale: [
        { path: "docs/metator/lessons/promoted-lesson.md", ageDays: 200 },
        { path: "docs/metator/lessons/old-lesson.md", ageDays: 120 },
        { path: "docs/old.md", ageDays: 95 },
      ],
      deadLinks: 1,
    });
    // The promoted lesson is cited by the canon; the new one is too young; the old one waits for a decision.
    expect(r.lessons).toEqual({ total: 3, unpromoted: [{ id: "old-lesson", ageDays: 120 }] });
    expect(r.evals).toEqual({ status: "compared", regressions: ["recall 0.9 -> 0.8"] });
    expect(r.actions[0]).toContain("MT-CODE-009");
    expect(r.actions.at(-1)).toContain("recall 0.9 -> 0.8");
    expect(r.output).toBe(".metator/reviews/quarterly-2026-11-10.json");
    const written = JSON.parse((await fs.read(r.output))._unsafeUnwrap());
    expect(QuarterlyReviewDocument.parse(written, r.output).isOk()).toBe(true);
    // Without reports there is no comparison, only the hint.
    const bare = (await review.execute({}))._unsafeUnwrap();
    expect(bare.evals.status).toBe("no-baseline");
    expect(bare.staleDays).toBe(90);
  });
});
