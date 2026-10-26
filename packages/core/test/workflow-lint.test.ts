import { describe, expect, test } from "bun:test";
import { lintWorkflow } from "../src/domain/workflow-lint.ts";
import { type WorkflowSpecInput, WorkflowSpecSchema } from "../src/domain/workflow-spec.ts";

const COMPLETE: WorkflowSpecInput = {
  id: "mt-feature",
  entry: { prompt: "mt-feature" },
  input: { oneOf: ["task_ref", "task_text"] },
  preconditions: ["clean-tree"],
  limits: { parallel: 3 },
  stages: [
    { id: "context", parallel: ["mt-scout", "mt-rule-curator"], produces: ["analysis.json"] },
    { id: "plan", owner: "mt-planner", produces: ["plan.json"] },
    {
      id: "plan-gate",
      owner: "script:metator plan lint",
      gate: { script: "metator plan lint", llm: "mt-plan-critic" },
      onFail: { goto: "plan", loop: "plan" },
    },
    { id: "approval", hitl: true, skipAt: ["L1"] },
    { id: "build", owner: ["mt-test-author", "skill:mt-find-patterns"] },
    { id: "delivery", hitl: true, neverSkip: true },
  ],
  loops: { plan: 2 },
  escalation: { onLoopExhausted: "report open issues", onAmbiguity: "stop and ask" },
  autonomy: ["L0", "L1"],
  permissions: { edit: "plan-scope", external: ["push"] },
  done: ["gates pass"],
  recovery: ["retry once, then escalate"],
  resume: "metator run status",
  telemetry: ["stage_duration"],
  report: "fixed report with links",
};
const CTX = {
  agents: new Set(["mt-scout", "mt-rule-curator", "mt-planner", "mt-plan-critic", "mt-test-author"]),
  skills: new Set(["mt-find-patterns"]),
  maxParallel: 6,
};
const lint = (spec: WorkflowSpecInput) =>
  lintWorkflow(WorkflowSpecSchema.parse(spec), CTX).map((p) => p.message);

describe("lintWorkflow", () => {
  test("a workflow with every anatomy section and known owners has no problems", () => {
    expect(lint(COMPLETE)).toEqual([]);
  });

  test("each missing section is named", () => {
    const bare = lint({ id: "x", stages: [{ id: "a", owner: "mt-planner" }] });
    expect(bare.map((m) => m.split(":")[0])).toEqual([
      "entry",
      "input",
      "preconditions",
      "artifacts",
      "gates",
      "parallelism",
      "escalation",
      "autonomy",
      "permissions",
      "done",
      "recovery",
      "resume",
      "telemetry",
      "report",
    ]);
  });

  test("owners, workers and critics must be canonical; scripts are free", () => {
    const spec = {
      ...COMPLETE,
      stages: [
        { id: "a", owner: "mt-ghost", produces: ["x"], gate: { llm: "mt-nobody" } },
        { id: "b", parallel: ["mt-scout", "skill:mt-none"] },
        { id: "c", owner: "script:anything at all" },
        { id: "d" },
      ],
    };
    expect(lint(spec)).toEqual([
      "stages: d has no owner",
      "a: mt-ghost is not a canonical agent",
      "a: mt-nobody is not a canonical agent",
      "b: skill:mt-none is not a canonical skill",
    ]);
  });

  test("limits and human gates: parallel caps, skipAt only on hitl, never on neverSkip, known levels", () => {
    const spec = {
      ...COMPLETE,
      limits: { parallel: 1 },
      stages: [
        { id: "a", parallel: ["mt-scout", "mt-planner"], produces: ["x"] },
        { id: "b", owner: "mt-planner", skipAt: ["L1" as const] },
        { id: "c", hitl: true, neverSkip: true, skipAt: ["L2" as const] },
      ],
    };
    expect(lint(spec)).toEqual([
      "parallelism: a starts more workers than limits.parallel",
      "b: skipAt only applies to a human gate (hitl)",
      "c: a stage marked neverSkip cannot be skipped",
      "c: skips at L2, which the workflow does not support",
    ]);
    expect(lint({ ...COMPLETE, limits: { parallel: 9 } })).toEqual([
      "parallelism: limits.parallel 9 exceeds 6",
    ]);
  });

  test("a loop back without a limit is a loops problem (the schema already rejects an unknown loop)", () => {
    const parsed = WorkflowSpecSchema.safeParse({ ...COMPLETE, loops: {} });
    expect(parsed.success).toBe(false);
  });
});

describe("LintWorkflows", () => {
  test("owners are checked against the repository's canonical agents and skills", async () => {
    const { InMemoryFileSystem } = await import("@metator/testing");
    const { AgentCatalog } = await import("../src/application/agents.ts");
    const { SkillCatalog } = await import("../src/application/skills.ts");
    const { LintWorkflows, WorkflowCatalog } = await import("../src/application/workflow-catalog.ts");
    const { DEFAULT_PATHS } = await import("../src/application/paths.ts");
    const { stringify } = await import("yaml");
    const spec = {
      kind: "Workflow",
      schemaVersion: 2,
      ...COMPLETE,
      stages: [{ id: "a", owner: "skill:mt-find-patterns", produces: ["x"], gate: { script: "s" } }],
    };
    const fs = new InMemoryFileSystem({
      ".github/metator/workflows/w.yml": stringify(spec),
      "metator/skills/mt-find-patterns/SKILL.md":
        "---\nkind: Skill\nschemaVersion: 1\nname: mt-find-patterns\ndescription: Use when you need an exemplar. Do not use for search.\n---\n# When\n",
    });
    const run = new LintWorkflows(
      new WorkflowCatalog(fs, DEFAULT_PATHS),
      new AgentCatalog(fs, DEFAULT_PATHS),
      new SkillCatalog(fs, DEFAULT_PATHS),
    );
    expect((await run.execute())._unsafeUnwrap()).toEqual({ workflows: 1, problems: [] });
    await fs.write(".github/metator/workflows/broken.yml", "kind: Workflow\nschemaVersion: 2\nid: [x]\n");
    const report = (await run.execute())._unsafeUnwrap();
    expect(report.problems.map((p) => p.source)).toEqual([".github/metator/workflows/broken.yml"]);
  });
});
