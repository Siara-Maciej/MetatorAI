import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { InitRun } from "../src/application/runs.ts";
import { SystemPlanApprovals } from "../src/application/system-runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const W13 = `kind: Workflow
schemaVersion: 2
id: w13
stages:
  - id: plan
  - id: plan-approval
    hitl: true
  - id: children
    owner: "script:metator system plan run --run {runDir}"
  - id: delivery
    hitl: true
`;
const W1 =
  "kind: Workflow\nschemaVersion: 2\nid: w1\nstages:\n  - id: plan\n  - id: approval\n    hitl: true\n  - id: build\n";

function world(
  o: {
    problems?: { severity: string; message: string; code?: string }[];
    plans?: string[];
    approveFails?: boolean;
  } = {},
) {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/w13.yml": W13,
    ".github/metator/workflows/w1.yml": W1,
  });
  const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const approved: string[] = [];
  const gates = new SystemPlanApprovals(
    repo,
    catalog,
    { exists: async (id: string) => (o.plans ?? ["add-currency-to-prices"]).includes(id) },
    { execute: async () => ok({ problems: o.problems ?? [] }) } as never,
    {
      execute: async (input: { id: string; by: string }) => {
        approved.push(`${input.id} by ${input.by}`);
        return o.approveFails ? err(MetatorError.usage("cannot")) : ok({});
      },
    } as never,
  );
  const start = async (workflow: string) =>
    (
      await new InitRun(catalog, repo, clock).execute({ workflow, task: "Add currency to prices" })
    )._unsafeUnwrap().runId;
  return { gates, approved, start };
}

describe("a system run's plan-approval approves its system plan (SystemPlanApprovals)", () => {
  test("the gate before the stage that starts the children: approving it approves the plan, by the person", async () => {
    const w = world();
    const runId = await w.start("w13");
    expect((await w.gates.refusal(runId, "plan-approval"))._unsafeUnwrap()).toBeUndefined();
    (await w.gates.approve(runId, "plan-approval", "ana"))._unsafeUnwrap();
    expect(w.approved).toEqual(["add-currency-to-prices by ana"]);
  });

  test("a plan with lint errors refuses the approval, naming them; a stale approval is no error", async () => {
    const w = world({
      problems: [
        { severity: "error", message: "shop-web consumes prices-api and has no step" },
        { severity: "error", code: "stale-approval", message: "approved before a change" },
        { severity: "warning", message: "no strategy" },
      ],
    });
    const runId = await w.start("w13");
    const refused = (await w.gates.refusal(runId, "plan-approval"))._unsafeUnwrap();
    expect([refused?.code, refused?.message]).toEqual([
      "CHECK_FAILED",
      "the system plan add-currency-to-prices has 1 lint error: shop-web consumes prices-api and has no step",
    ]);
    expect(refused?.hint).toContain("metator system plan lint add-currency-to-prices");
  });

  test("any other gate, a run of another workflow or a run without its plan: nothing to refuse or approve", async () => {
    const w = world({ problems: [{ severity: "error", message: "x" }] });
    const system = await w.start("w13");
    const feature = await w.start("w1");
    for (const [runId, stage] of [
      [system, "delivery"],
      [feature, "approval"],
    ] as const) {
      expect((await w.gates.refusal(runId, stage))._unsafeUnwrap()).toBeUndefined();
      (await w.gates.approve(runId, stage, "ana"))._unsafeUnwrap();
    }
    const none = world({ plans: [], problems: [{ severity: "error", message: "x" }] });
    const run = await none.start("w13");
    expect((await none.gates.refusal(run, "plan-approval"))._unsafeUnwrap()).toBeUndefined();
    expect([...w.approved, ...none.approved]).toEqual([]);
  });

  test("the plan's approval failing is the gate's failure", async () => {
    const w = world({ approveFails: true });
    const runId = await w.start("w13");
    expect((await w.gates.approve(runId, "plan-approval", "ana")).isErr()).toBe(true);
  });
});
