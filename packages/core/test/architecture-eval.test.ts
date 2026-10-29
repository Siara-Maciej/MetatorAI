import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { RunArchEvals } from "../src/application/architecture-plans.ts";
import { type ArchitectureInput, analyzeArchitecture, manifestOf } from "../src/domain/architecture.ts";
import {
  ArchEvalCaseSchema,
  failedArchCase,
  scoreArchCase,
  summarizeArchEval,
} from "../src/domain/architecture-eval.ts";
import { applyMoves } from "../src/domain/architecture-moves.ts";
import { RefactorPlanSchema } from "../src/domain/architecture-plan.ts";
import { EMPTY_POLICY } from "../src/domain/architecture-policy.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

function input(): ArchitectureInput {
  return {
    files: ["packages/cart/src/index.ts", "packages/pricing/src/index.ts", "packages/pricing/src/rules.ts"],
    imports: [
      {
        from: "packages/cart/src/index.ts",
        to: "packages/pricing/src/index.ts",
        specifier: "@x/pricing",
        typeOnly: false,
      },
      {
        from: "packages/pricing/src/rules.ts",
        to: "packages/cart/src/index.ts",
        specifier: "@x/cart",
        typeOnly: false,
      },
    ],
    externals: [],
    unresolved: [],
    manifests: {
      packages: [
        manifestOf("packages/cart", {
          name: "@x/cart",
          private: true,
          main: "x",
          dependencies: { "@x/pricing": "*" },
        }),
        manifestOf("packages/pricing", {
          name: "@x/pricing",
          private: true,
          main: "x",
          dependencies: { "@x/cart": "*" },
        }),
      ],
    },
    policy: EMPTY_POLICY,
    policySource: null,
    today: "2026-10-29",
  };
}
const CASE = ArchEvalCaseSchema.parse({
  id: "rules",
  goal: "no-cycles",
  files: { "package.json": "{}" },
  expect: { fixed: ["cycle:@x/cart,@x/pricing"], forbidden: ["app-import:@x/a→@x/b"], maxMoves: 1 },
});
const move = { type: "move" as const, files: ["packages/pricing/src/rules.ts"], to: "@x/cart" };
const plan = (moves: unknown[]) =>
  RefactorPlanSchema.parse({ id: "rules", title: "rules", goal: "no-cycles", moves });
const pm = (id: string) => ({ id, move, why: "w", citations: ["c"], wave: 1 });

describe("scoreArchCase", () => {
  test("a plan that fixes what is expected, cleanly, in few moves, scores 1", () => {
    const after = analyzeArchitecture(applyMoves(input(), [move]).input);
    const s = scoreArchCase({
      case: CASE,
      plan: plan([pm("m1")]),
      problems: [],
      before: analyzeArchitecture(input()),
      after,
    });
    expect(s).toEqual({
      id: "rules",
      plan: "rules",
      moves: 1,
      lintClean: true,
      goalMet: true,
      recall: 1,
      forbidden: [],
      withinMoves: true,
      passed: true,
      score: 1,
    });
  });

  test("each miss costs a fifth: lint errors, the goal, recall, forbidden ids, too many moves", () => {
    const before = analyzeArchitecture(input());
    const s = scoreArchCase({
      case: { ...CASE, expect: { ...CASE.expect, forbidden: ["cycle:@x/cart,@x/pricing"] } },
      plan: plan([pm("a"), pm("b")]),
      problems: [{ severity: "error", message: "x" }],
      before,
      after: before,
    });
    expect(s).toMatchObject({
      lintClean: false,
      goalMet: false,
      recall: 0,
      forbidden: ["cycle:@x/cart,@x/pricing"],
      withinMoves: false,
      score: 0,
      passed: false,
    });
    const warned = scoreArchCase({
      case: CASE,
      plan: plan([pm("a"), pm("b")]),
      problems: [{ severity: "warning", message: "w" }],
      before,
      after: before,
    });
    expect([warned.lintClean, warned.score]).toEqual([true, 0.4]);
  });

  test("a failed case scores 0; the summary averages", () => {
    const failed = failedArchCase("x", "the host stopped");
    expect([failed.score, failed.error, failed.passed]).toEqual([0, "the host stopped", false]);
    expect(summarizeArchEval([failed, { ...failed, id: "y", score: 1, passed: true }])).toEqual({
      cases: 2,
      passed: 1,
      score: 0.5,
    });
    expect(summarizeArchEval([])).toEqual({ cases: 0, passed: 0, score: 0 });
  });

  test("a case needs files and an expected fix", () => {
    expect(() => ArchEvalCaseSchema.parse({ ...CASE, files: {} })).toThrow("a case needs files");
    expect(() => ArchEvalCaseSchema.parse({ ...CASE, expect: { fixed: [] } })).toThrow();
  });
});

describe("RunArchEvals", () => {
  const caseFile = (id: string) =>
    `kind: ArchEvalCase\nschemaVersion: 1\nid: ${id}\ngoal: no-cycles\nfiles:\n  package.json: "{}"\nexpect:\n  fixed: ["cycle:@x/cart,@x/pricing"]\n`;

  test("each case in its own sandbox with the planner files; proposals scored; sandboxes removed", async () => {
    const fs = new InMemoryFileSystem({ "evals/b.yml": caseFile("b"), "evals/a.yml": caseFile("a") });
    const created: Record<string, string>[] = [];
    let disposed = 0;
    const sandbox = {
      create: async (files: Readonly<Record<string, string>>) => {
        created.push({ ...files });
        return ok({ root: `/box${created.length}`, dispose: async () => void disposed++ });
      },
    };
    const roots: string[] = [];
    const workspaceAt = (root: string) => {
      roots.push(root);
      return {
        facts: { gather: async () => ok(input()) },
        propose: {
          execute: async () =>
            root === "/box1"
              ? ok({ plan: plan([pm("m1")]), problems: [] })
              : err(new MetatorError("COMMAND_FAILED", "scenario: no plan")),
        },
      };
    };
    const evals = new RunArchEvals(fs, "evals", sandbox, workspaceAt, async () => ({
      ".claude/agents/mt-arch-planner.md": "agent",
    }));
    const r = (await evals.execute({ host: "scenario", by: "maciej" }))._unsafeUnwrap();
    expect(r.cases.map((c) => [c.id, c.score, c.error])).toEqual([
      ["a", 1, undefined],
      ["b", 0, "scenario: no plan"],
    ]);
    expect(r.summary).toEqual({ cases: 2, passed: 1, score: 0.5 });
    expect(created[0]).toEqual({ ".claude/agents/mt-arch-planner.md": "agent", "package.json": "{}" });
    expect([roots, disposed]).toEqual([["/box1", "/box2"], 2]);

    const one = (await evals.execute({ host: "scenario", by: "m", only: "b" }))._unsafeUnwrap();
    expect(one.cases.map((c) => c.id)).toEqual(["b"]);
    expect((await evals.execute({ host: "scenario", by: "m", only: "zzz" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });

  test("a broken case file or a sandbox that cannot be made is the error", async () => {
    const broken = new RunArchEvals(
      new InMemoryFileSystem({ "evals/a.yml": "kind: ArchEvalCase\nschemaVersion: 1\nid: A\n" }),
      "evals",
      { create: async () => err(new MetatorError("INTERNAL", "no")) },
      () => {
        throw new Error("not reached");
      },
    );
    expect((await broken.cases())._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
    const noBox = new RunArchEvals(
      new InMemoryFileSystem({ "evals/a.yml": caseFile("a") }),
      "evals",
      { create: async () => err(new MetatorError("INTERNAL", "no sandbox")) },
      () => {
        throw new Error("not reached");
      },
    );
    expect((await noBox.execute({ host: "h", by: "m" }))._unsafeUnwrapErr().message).toBe("no sandbox");
    const failingFacts = new RunArchEvals(
      new InMemoryFileSystem({ "evals/a.yml": caseFile("a") }),
      "evals",
      { create: async () => ok({ root: "/b", dispose: async () => {} }) },
      () => ({
        facts: { gather: async () => err(new MetatorError("INVALID_CONFIG", "bad workspace")) },
        propose: { execute: async () => err(new MetatorError("INTERNAL", "not reached")) },
      }),
    );
    expect((await failingFacts.execute({ host: "h", by: "m" }))._unsafeUnwrap().cases[0]?.error).toBe(
      "bad workspace",
    );
  });
});
