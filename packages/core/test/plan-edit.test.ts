import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { PlanBoard } from "../src/application/plan-board.ts";
import {
  PlanRevisions,
  planReadOnlyBecause,
  planStages,
  RunPlanApprovals,
  type RunPlanApprovalsDependencies,
  RunPlans,
} from "../src/application/plan-edit.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AllGateApprovals, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { lintPlan, type Plan, PlanDocument } from "../src/domain/plan.ts";
import { changeSummary, documentDigest, documentFromBody, itemChanges } from "../src/domain/plan-edit.ts";
import { ok } from "../src/domain/result.ts";
import { serializeJsonDocument } from "../src/domain/versioned.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json, plan-scope.json]
  - id: plan-approval
    hitl: true
  - id: build
    owner: mt-implementer
    produces: [build-log.md]
`;

const PLAN: Plan = {
  task: "Add a discount",
  scope: ["src/**"],
  steps: [
    {
      id: "S1",
      action: "create",
      path: "src/invoice.test.ts",
      intent: "tests",
      rules: [],
      testsFirst: [],
      dependsOn: [],
    },
    {
      id: "S2",
      action: "modify",
      path: "src/invoice.ts",
      intent: "discount()",
      rules: [],
      testsFirst: ["src/invoice.test.ts"],
      dependsOn: ["S1"],
    },
  ],
};

async function world(options: { plan?: Plan; scope?: boolean } = {}) {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/demo.yml": WORKFLOW,
    "src/invoice.ts": "export const x = 1;\n",
  });
  const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const run = (
    await new InitRun(catalog, repo, clock).execute({ workflow: "demo", task: "Add a discount" })
  )._unsafeUnwrap();
  const dir = repo.runDir(run.runId);
  if (options.plan)
    await fs.write(`${dir}/plan.json`, serializeJsonDocument(PlanDocument.stamp(options.plan)));
  if (options.scope) await fs.write(`${dir}/plan-scope.json`, "{}");
  const scoped: string[] = [];
  const plans = new RunPlans({
    fs,
    repo,
    journal,
    catalog,
    lint: {
      check: async (plan) =>
        ok(
          lintPlan(plan, {
            files: new Set(["src/invoice.ts"]),
            patterns: new Map(),
            rules: new Set(),
            imports: [],
            testGlobs: ["**/*.test.ts"],
          }),
        ),
    },
    scope: {
      execute: async (input) => {
        scoped.push(input.file);
        return ok({ plan: input.file, edit: [], shards: [] });
      },
    },
  });
  const moveTo = (stage: string, status: "active" | "escalated" | "done" = "active") =>
    repo.update(run.runId, (r) => ok({ ...r, state: { ...r.state, stage, status } }));
  return { fs, repo, journal, run, dir, plans, scoped, moveTo };
}

describe("the run's plan in the app", () => {
  test("the view: the plan, its digest and lint, editable before the approval gate, the workflow's artifacts", async () => {
    const w = await world({ plan: PLAN });
    const view = (await w.plans.view(w.run.runId))._unsafeUnwrap();
    expect(view.plan).toEqual(PLAN);
    expect(view.digest).toBe(documentDigest(PLAN));
    expect([view.editable, view.stage, view.approvalStage]).toEqual([true, "plan", "plan-approval"]);
    expect(view.artifactsOfWorkflow).toEqual(["plan.json", "plan-scope.json", "build-log.md"]);
    expect(view.lint.problems).toEqual([]);
    expect(view.file).toBe(`${w.dir}/plan.json`);
    const none = await world();
    const empty = (await none.plans.view(none.run.runId))._unsafeUnwrap();
    expect([empty.plan, empty.digest, empty.lint.problems]).toEqual([null, null, []]);
  });

  test("past the approval gate the plan is read-only with the reason; an escalated run before it may still change it", async () => {
    const w = await world({ plan: PLAN });
    await w.moveTo("build");
    const view = (await w.plans.view(w.run.runId))._unsafeUnwrap();
    expect(view.editable).toBe(false);
    expect(view.readOnlyBecause).toContain("passed plan-approval");
    await w.moveTo("plan-approval", "escalated");
    expect((await w.plans.view(w.run.runId))._unsafeUnwrap().editable).toBe(true);
    await w.moveTo("plan-approval", "done");
    expect((await w.plans.view(w.run.runId))._unsafeUnwrap().readOnlyBecause).toBe("the run is done");
  });

  test("the open question of the approval gate is named: its card is about this plan", async () => {
    const w = await world({ plan: PLAN });
    await w.moveTo("plan-approval");
    const asked = (
      await w.journal.ask(w.run.runId, {
        stage: "plan-approval",
        source: "gate",
        prompt: "Approve the plan?",
        options: [{ label: "Approve" }, { label: "Reject" }],
        multiSelect: false,
      })
    )._unsafeUnwrap();
    const view = (await w.plans.view(w.run.runId))._unsafeUnwrap();
    expect([view.editable, view.question]).toEqual([true, asked.id]);
  });

  test("lint without writing: schema problems by field, else the plan lint", async () => {
    const w = await world({ plan: PLAN });
    const schema = (await w.plans.lint(w.run.runId, { task: "x", scope: [], steps: [] }))._unsafeUnwrap();
    expect(schema.problems.map((p) => p.field)).toEqual(["scope", "steps"]);
    const missing = {
      ...PLAN,
      steps: [{ ...(PLAN.steps[1] as object), path: "src/gone.ts", testsFirst: [], dependsOn: [] }],
    };
    const linted = (await w.plans.lint(w.run.runId, missing))._unsafeUnwrap();
    expect(linted.problems.map((p) => p.message)).toContain("src/gone.ts does not exist");
    expect((await w.plans.lint(w.run.runId, PlanDocument.stamp(PLAN)))._unsafeUnwrap().problems).toEqual([]);
    expect((await w.plans.lint(w.run.runId, [1]))._unsafeUnwrap().problems[0]?.field).toBe("(root)");
  });
});

describe("where a plan freezes", () => {
  const stages = [{ id: "plan", produces: ["plan.json"] }, { id: "gate", hitl: true }, { id: "build" }];
  test("the stage that writes plan.json and the first person's gate after it", () => {
    expect(planStages(stages)).toEqual({ plan: 0, approval: 1 });
    expect(planStages([{ id: "plan", produces: ["plan.json"] }, { id: "build" }])).toEqual({ plan: 0 });
    expect(planStages([{ id: "build" }])).toBeUndefined();
  });
  test("why a plan is read-only: no plan in the workflow, the run over, or past the gate (or the plan stage)", () => {
    const record = (stage: string, status: "active" | "done" | "aborted" | "escalated" = "active") =>
      ({
        workflow: { id: "w", revision: 1, digest: "d" },
        state: { stage, status, context: { loops: {}, history: [] } },
      }) as unknown as Parameters<typeof planReadOnlyBecause>[0];
    expect(planReadOnlyBecause(record("gate"), stages)).toBeUndefined();
    expect(planReadOnlyBecause(record("build"), stages)).toContain("passed gate");
    expect(planReadOnlyBecause(record("plan", "aborted"), stages)).toBe("the run is aborted");
    expect(
      planReadOnlyBecause(record("build"), [{ id: "plan", produces: ["plan.json"] }, { id: "build" }]),
    ).toContain("past plan");
    expect(planReadOnlyBecause(record("plan"), [{ id: "plan" }])).toContain("no stage writes plan.json");
  });
});

describe("what changed", () => {
  test("items added, removed, changed by field, reordered", () => {
    const a = [
      { id: "A", x: 1 },
      { id: "B", x: 1 },
      { id: "C", x: 1 },
    ];
    const b = [
      { id: "C", x: 1 },
      { id: "B", x: 2 },
      { id: "D", x: 1 },
    ];
    expect(itemChanges("step", a, b)).toEqual([
      "step added: D",
      "step removed: A",
      "step B changed: x",
      "steps reordered",
    ]);
    expect(changeSummary(itemChanges("step", a, a))).toBe("nothing changed");
  });
  test("a body with or without the header is the document; what does not fit is problems by field", () => {
    expect(documentFromBody(PlanDocument, PLAN, "p")).toEqual({ ok: true, value: PLAN });
    expect(documentFromBody(PlanDocument, { kind: "Other", schemaVersion: 1 }, "p")).toMatchObject({
      ok: false,
      problems: [{ field: "(root)" }],
    });
  });
});

describe("the plan board of a system run (defect 10)", () => {
  test("a run whose workflow works on `system plan` carries its task's plan; the board shows it", async () => {
    const WF = `kind: Workflow\nschemaVersion: 2\nid: sys\nstages:\n  - id: plan-gate\n    owner: "script:metator system plan lint --run {runDir}"\n`;
    const fs = new InMemoryFileSystem({ ".github/metator/workflows/sys.yml": WF });
    const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
    const repo = new RunRepository(fs, DEFAULT_PATHS);
    const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
    const run = (
      await new InitRun(catalog, repo, clock).execute({ workflow: "sys", task: "Add currency" })
    )._unsafeUnwrap();
    const asked: string[] = [];
    const board = new PlanBoard({
      fs,
      repo,
      journal: new RunJournal(fs, repo, clock),
      catalog,
      conductor: { workers: async () => ok([]) },
      paths: DEFAULT_PATHS,
      systemPlans: {
        view: async (id) => {
          asked.push(id);
          return ok({
            plan: { id, task: "Add currency", status: "draft", strategies: [], steps: [] },
            digest: "d",
            status: "draft",
            lint: { problems: [] },
            waves: [],
            steps: [],
            editable: true,
            file: "f",
          });
        },
      },
    });
    const view = (await board.execute({ runId: run.runId }))._unsafeUnwrap();
    expect(asked).toEqual(["add-currency"]);
    expect(view.system).toMatchObject({ id: "add-currency", status: "draft", steps: [] });
  });
});

describe("RunActivity v3", () => {
  test("a v2 line reads as it was; v3 adds plan-edited", async () => {
    const { RunActivityDocument } = await import("../src/domain/drive.ts");
    const v2 = {
      kind: "RunActivity",
      schemaVersion: 2,
      at: "2026-11-01T09:00:00.000Z",
      type: "restart",
      text: "x",
    };
    expect(RunActivityDocument.parse(v2, "a")._unsafeUnwrap()).toEqual({
      at: v2.at,
      type: "restart",
      text: "x",
    });
    expect(RunActivityDocument.current).toBe(3);
    expect(RunActivityDocument.parse({ ...v2, schemaVersion: 2, type: "plan-edited" }, "a").isErr()).toBe(
      true,
    );
    expect(RunActivityDocument.parse({ ...v2, schemaVersion: 3, type: "plan-edited" }, "a").isOk()).toBe(
      true,
    );
  });
});

describe("the plan's gate refuses Approve while the plan has lint errors", () => {
  const BAD: Plan = {
    ...PLAN,
    steps: [
      {
        ...(PLAN.steps[1] as Plan["steps"][number]),
        id: "S1",
        path: "src/nowhere.ts",
        testsFirst: [],
        dependsOn: [],
      },
    ],
  };
  const approvals = (w: Awaited<ReturnType<typeof world>>) =>
    new RunPlanApprovals({
      fs: w.fs,
      repo: w.repo,
      catalog: new WorkflowCatalog(w.fs, DEFAULT_PATHS),
      lint: (w.plans as unknown as { d: { lint: RunPlanApprovalsDependencies["lint"] } }).d.lint,
    });

  test("at the gate that approves the plan: the errors, by message, with the way to fix them", async () => {
    const w = await world({ plan: BAD });
    await w.moveTo("plan-approval");
    const refused = (await approvals(w).refusal(w.run.runId, "plan-approval"))._unsafeUnwrap();
    expect(refused?.code).toBe("CHECK_FAILED");
    expect(refused?.message).toBe(
      `the plan of run ${w.run.runId} has 1 lint error: S1: src/nowhere.ts does not exist`,
    );
    expect(refused?.hint).toContain("metator plan lint");
    // Another stage, a plan without errors, no plan at all: nothing is refused.
    expect((await approvals(w).refusal(w.run.runId, "build"))._unsafeUnwrap()).toBeUndefined();
    const good = await world({ plan: PLAN });
    expect((await approvals(good).refusal(good.run.runId, "plan-approval"))._unsafeUnwrap()).toBeUndefined();
    const none = await world();
    expect((await approvals(none).refusal(none.run.runId, "plan-approval"))._unsafeUnwrap()).toBeUndefined();
    expect((await approvals(w).approve(w.run.runId, "plan-approval", "ana")).isOk()).toBe(true);
  });

  test("several gates' rules: the first refusal wins; an approval runs each", async () => {
    const said: string[] = [];
    const gate = (name: string, why?: string) => ({
      refusal: async () => ok(why ? MetatorError.usage(why) : undefined),
      approve: async (_r: string, _s: string, by: string) => {
        said.push(`${name} ${by}`);
        return ok(undefined);
      },
    });
    const all = new AllGateApprovals([gate("system"), gate("plan", "plan errors"), gate("x", "later")]);
    expect((await all.refusal("r", "s"))._unsafeUnwrap()?.message).toBe("plan errors");
    expect((await new AllGateApprovals([gate("a")]).refusal("r", "s"))._unsafeUnwrap()).toBeUndefined();
    (await all.approve("r", "s", "ana"))._unsafeUnwrap();
    expect(said).toEqual(["system ana", "plan ana", "x ana"]);
  });
});

describe("the planner's previous version (a person asked for changes)", () => {
  test("sent back to the plan stage, the plan it replaces is kept; the view shows it and what changed by step", async () => {
    const w = await world({ plan: PLAN });
    await w.moveTo("plan-approval");
    const revisions = new PlanRevisions({
      fs: w.fs,
      repo: w.repo,
      catalog: new WorkflowCatalog(w.fs, DEFAULT_PATHS),
      clock: new FixedClock(new Date("2026-11-18T12:00:00.000Z")),
    });
    // No previous version before any revision.
    expect((await w.plans.view(w.run.runId))._unsafeUnwrap().previous).toBeUndefined();
    (await revisions.keep(w.run.runId, "plan"))._unsafeUnwrap();
    // The planner revises: S2 gets another intent, S3 is added.
    const revised: Plan = {
      ...PLAN,
      steps: [
        PLAN.steps[0] as Plan["steps"][number],
        { ...(PLAN.steps[1] as Plan["steps"][number]), intent: "discount() capped in cents" },
        { ...(PLAN.steps[1] as Plan["steps"][number]), id: "S3", path: "src/cap.ts", action: "create" },
      ],
    };
    await w.fs.write(`${w.dir}/plan.json`, serializeJsonDocument(PlanDocument.stamp(revised)));
    const view = (await w.plans.view(w.run.runId))._unsafeUnwrap();
    expect(view.previous).toEqual({
      plan: PLAN,
      digest: documentDigest(PLAN),
      at: "2026-11-18T12:00:00.000Z",
    });
    expect(view.changes).toEqual(["step added: S3", "step S2 changed: intent"]);
    // A stage that does not write the plan keeps nothing.
    (await revisions.keep(w.run.runId, "build"))._unsafeUnwrap();
    expect((await w.plans.view(w.run.runId))._unsafeUnwrap().previous?.digest).toBe(documentDigest(PLAN));
  });

  test("a revision that changed nothing shows no previous version", async () => {
    const w = await world({ plan: PLAN });
    const revisions = new PlanRevisions({
      fs: w.fs,
      repo: w.repo,
      catalog: new WorkflowCatalog(w.fs, DEFAULT_PATHS),
      clock: new FixedClock(new Date("2026-11-18T12:00:00.000Z")),
    });
    (await revisions.keep(w.run.runId, "plan"))._unsafeUnwrap();
    const view = (await w.plans.view(w.run.runId))._unsafeUnwrap();
    expect([view.previous, view.changes]).toEqual([undefined, undefined]);
  });
});
