/** `workflow lint` end to end: the real `metator` process on real workflow and agent files. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const AGENT = (id: string) => `---
kind: Agent
schemaVersion: 1
id: ${id}
role: worker
description: Does one stage of the workflow and nothing else.
tier: standard
capabilities: [read]
---
# Input
x
# Procedure
x
# Output
x
# Stop conditions
x
`;
const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: mt-feature
entry: { prompt: mt-feature }
input: { oneOf: [task_ref, task_text] }
preconditions: [clean-tree]
limits: { parallel: 2 }
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json]
  - id: plan-gate
    owner: "script:metator plan lint"
    gate: { script: metator plan lint, llm: mt-plan-critic }
    onFail: { goto: plan, loop: plan }
  - id: approval
    hitl: true
    skipAt: [L1]
loops: { plan: 2 }
escalation: { onLoopExhausted: report open issues and options, onAmbiguity: stop and ask }
autonomy: [L0, L1]
permissions: { edit: plan-scope, external: [push] }
done: [plan approved]
recovery: [retry the gate once, then escalate]
resume: metator run status
telemetry: [stage_duration, loops]
report: plan with its risks
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("metator/agents/mt-planner.md", AGENT("mt-planner"));
  await repo.write("metator/agents/mt-plan-critic.md", AGENT("mt-plan-critic"));
  await repo.write(".github/metator/workflows/mt-feature.yml", WORKFLOW);
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator workflow lint (real CLI)", () => {
  test("a workflow with the whole anatomy and canonical owners passes", async () => {
    const r = await metator(["workflow", "lint"], repo.root);
    expect([r.code, r.json.data]).toEqual([0, { workflows: 1, problems: [] }]);
  });

  test("missing sections and unknown owners fail with each problem named", async () => {
    await repo.write(
      ".github/metator/workflows/mt-feature.yml",
      WORKFLOW.replace("owner: mt-planner", "owner: mt-ghost").replace(/^report:.*\n/m, ""),
    );
    try {
      const r = await metator(["workflow", "lint"], repo.root);
      expect(r.code).toBe(1);
      const messages = (
        r.json.error as { details: { problems: { message: string }[] } }
      ).details.problems.map((p) => p.message);
      expect(messages).toEqual([
        "report: describe the final report",
        "plan: mt-ghost is not a canonical agent",
      ]);
    } finally {
      await repo.write(".github/metator/workflows/mt-feature.yml", WORKFLOW);
    }
  });

  test("a v1 workflow still runs (it migrates) but lint names its missing anatomy", async () => {
    await repo.write(
      ".github/metator/workflows/old.yml",
      "kind: Workflow\nschemaVersion: 1\nid: old\nstages:\n  - id: a\n",
    );
    expect((await metator(["run", "init", "--workflow", "old", "--task", "t"], repo.root)).code).toBe(0);
    const r = await metator(["workflow", "lint"], repo.root);
    const old = (r.json.error as { details: { problems: { workflow?: string }[] } }).details.problems.filter(
      (p) => p.workflow === "old",
    );
    expect(old.length).toBeGreaterThan(10);
  });

  test("dogfood: the reference example names what a minimal workflow lacks", async () => {
    const example = await ScratchRepo.create();
    try {
      await example.write(
        ".github/metator/workflows/feature.yml",
        await Bun.file(join(SELF, "examples/workflows/feature.yml")).text(),
      );
      const r = await metator(["workflow", "lint"], example.root);
      expect(r.code).toBe(1);
    } finally {
      await example.dispose();
    }
  });
});
