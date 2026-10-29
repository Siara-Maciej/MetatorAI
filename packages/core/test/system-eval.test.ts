import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { RunSystemEvals, type SystemEvalWorkspace } from "../src/application/system-evals.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import {
  failedSystemCase,
  type SystemEvalCase,
  SystemEvalCaseSchema,
  scoreSystemCase,
  summarizeSystemEval,
} from "../src/domain/system-eval.ts";
import type { SystemAnalysis, SystemPlan } from "../src/domain/system-plan.ts";

const CASE: SystemEvalCase = SystemEvalCaseSchema.parse({
  id: "rename",
  task: "Rename refunds",
  input: { breaking: ["billing-api"] },
  files: { "docs/metator/system.yml": "x" },
  expect: {
    applications: ["billing", "web", "mail"],
    contracts: { "billing-api": "breaking" },
    steps: ["billing-expand", "web-migrate", "billing-contract"],
    order: [
      ["billing-expand", "web-migrate"],
      ["web-migrate", "billing-contract"],
    ],
  },
});
const analysis = (apps: string[], change: "breaking" | "compatible" = "breaking"): SystemAnalysis => ({
  task: "Rename refunds",
  map: "m",
  base: null,
  contracts: [{ id: "billing-api", owner: "billing", change, consumers: [] }],
  applications: apps.map((id) => ({ id, roles: ["consumer"], owners: [], files: [] })),
});
const step = (id: string, dependsOn: string[] = []) => ({
  id,
  app: id.split("-")[0] as string,
  summary: id,
  contracts: [],
  dependsOn,
  status: "pending" as const,
});
const PLAN: SystemPlan = {
  id: "rename-refunds",
  task: "Rename refunds",
  status: "draft",
  strategies: [],
  steps: [
    step("billing-expand"),
    step("web-migrate", ["billing-expand"]),
    step("billing-contract", ["web-migrate"]),
  ],
};

describe("system eval scoring", () => {
  test("a plan that finds every application, gets every change right and keeps the order scores 1", () => {
    const s = scoreSystemCase({
      case: CASE,
      analysis: analysis(["billing", "web", "mail"]),
      plan: PLAN,
      problems: [],
    });
    expect(s).toEqual({
      id: "rename",
      plan: "rename-refunds",
      impactRecall: 1,
      impactPrecision: 1,
      contracts: 1,
      lintClean: true,
      stepsRecall: 1,
      order: 1,
      passed: true,
      score: 1,
    });
  });

  test("each check costs its share: missed and extra applications, a wrong change, lint, steps, order", () => {
    const reversed = {
      ...PLAN,
      steps: [step("billing-expand", ["web-migrate"]), step("web-migrate"), step("billing-contract")],
    };
    const s = scoreSystemCase({
      case: CASE,
      analysis: analysis(["billing", "web", "search", "admin"], "compatible"),
      plan: { ...reversed, steps: reversed.steps.slice(0, 2) },
      problems: [{ severity: "error", message: "x" }],
    });
    expect([s.impactRecall, s.impactPrecision, s.contracts, s.lintClean, s.stepsRecall, s.order]).toEqual([
      0.67,
      0.5,
      0,
      false,
      0.67,
      0,
    ]);
    expect([s.passed, s.score]).toEqual([false, 0.31]);
    const warnings = scoreSystemCase({
      case: CASE,
      analysis: analysis(["billing", "web", "mail"]),
      plan: PLAN,
      problems: [{ severity: "warning", message: "w" }],
    });
    expect(warnings.passed).toBe(true);
  });

  test("nothing expected counts as kept; a failed case scores 0; the summary averages", () => {
    const bare = SystemEvalCaseSchema.parse({ ...CASE, expect: { applications: ["billing"] } });
    expect(
      scoreSystemCase({ case: bare, analysis: analysis(["billing"]), plan: PLAN, problems: [] }).score,
    ).toBe(1);
    const failed = failedSystemCase("x", "boom");
    expect([failed.score, failed.error, failed.plan]).toEqual([0, "boom", null]);
    const good = scoreSystemCase({ case: bare, analysis: analysis(["billing"]), plan: PLAN, problems: [] });
    expect(summarizeSystemEval([good, failed])).toEqual({
      cases: 2,
      passed: 1,
      score: 0.5,
      impactRecall: 0.5,
    });
    expect(summarizeSystemEval([])).toEqual({ cases: 0, passed: 0, score: 0, impactRecall: 0 });
  });
});

const YAML = (id: string) =>
  `kind: SystemEvalCase\nschemaVersion: 1\nid: ${id}\ntask: Rename refunds\ninput: { breaking: [billing-api] }\nfiles: { a.txt: a }\nexpect:\n  applications: [billing, web, mail]\n  contracts: { billing-api: breaking }\n`;

function runner(
  ws: Partial<SystemEvalWorkspace>,
  files: Record<string, string> = { "evals/b.yml": YAML("b"), "evals/a.yml": YAML("a") },
) {
  const created: Record<string, string>[] = [];
  let disposed = 0;
  const sandbox = {
    create: async (f: Readonly<Record<string, string>>) => {
      created.push({ ...f });
      return ok({ root: `/box${created.length}`, dispose: async () => void disposed++ });
    },
  };
  const full: SystemEvalWorkspace = {
    create: { execute: async () => ok(PLAN) },
    propose: { execute: async () => ok({ plan: PLAN, problems: [] }) },
    lint: { execute: async () => ok({ plan: PLAN, problems: [] }) },
    store: { loadAnalysis: async () => ok(analysis(["billing", "web", "mail"])) },
    ...ws,
  };
  const r = new RunSystemEvals(
    new InMemoryFileSystem(files),
    "evals",
    sandbox,
    () => full,
    async () => ({ ".claude/agents/s.md": "s" }),
  );
  return { r, created, disposed: () => disposed };
}

describe("RunSystemEvals", () => {
  test("every case in its own sandbox, without agents by default; the host's agents only with --host", async () => {
    const w = runner({});
    const r = (await w.r.execute({ by: "ana" }))._unsafeUnwrap();
    expect([r.cases.map((c) => [c.id, c.score]), r.summary.passed, w.disposed()]).toEqual([
      [
        ["a", 1],
        ["b", 1],
      ],
      2,
      2,
    ]);
    expect(w.created[0]).toEqual({ "a.txt": "a" });
    const proposed: unknown[] = [];
    const hosted = runner({
      propose: {
        execute: async (input) => {
          proposed.push(input);
          return ok({ plan: PLAN, problems: [] });
        },
      },
    });
    await hosted.r.execute({ by: "ana", host: "claude", only: "a" });
    expect(proposed).toEqual([
      {
        task: "Rename refunds",
        breaking: ["billing-api"],
        host: "claude",
        by: "ana",
        cwd: "/box1",
        projectRoot: "/box1",
      },
    ]);
    expect(hosted.created[0]).toEqual({ ".claude/agents/s.md": "s", "a.txt": "a" });
  });

  test("a case that cannot be planned scores 0 with the reason; an unknown case is NOT_FOUND", async () => {
    const broken = runner({ create: { execute: async () => err(new MetatorError("USAGE", "no map")) } });
    const r = (await broken.r.execute({ by: "ana", only: "a" }))._unsafeUnwrap();
    expect([r.cases[0]?.score, r.cases[0]?.error]).toEqual([0, "no map"]);
    const missing = runner({ store: { loadAnalysis: async () => ok(undefined) } });
    expect((await missing.r.execute({ by: "ana", only: "a" }))._unsafeUnwrap().cases[0]?.error).toBe(
      "no analysis was written",
    );
    expect((await broken.r.execute({ by: "ana", only: "zzz" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    const invalid = runner({}, { "evals/x.yml": "kind: SystemEvalCase\nschemaVersion: 1\nid: x\n" });
    expect((await invalid.r.cases())._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });
});
