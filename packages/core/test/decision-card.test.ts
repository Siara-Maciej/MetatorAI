import { expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import {
  costOfDelay,
  type DecisionCardContext,
  type DecisionCardSources,
  decisionCard,
} from "../src/application/decision-card.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { RunRecord } from "../src/domain/run-record.ts";
import type { StageSpec } from "../src/domain/workflow-spec.ts";

const stage = { id: "review", hitl: true } as unknown as StageSpec;
const ctx: DecisionCardContext = {
  runId: "r2",
  task: "Add a flag",
  stage,
  done: ["plan"],
  stages: [stage],
  loops: { fix: 2, review: 0 },
  loopLimits: { fix: 3 },
  children: ["c1"],
  ports: { from: 4100, count: 10 },
};

function sources(fs: InMemoryFileSystem, records: Record<string, Partial<RunRecord>>): DecisionCardSources {
  return {
    fs,
    repo: {
      runDir: (id) => `runs/${id}`,
      load: async (id) =>
        records[id] ? ok(records[id] as RunRecord) : err(new MetatorError("NOT_FOUND", "no run")),
    },
    journal: { activity: async () => ok([]) },
    gatesDir: "gates",
  };
}

test("waiting costs the ports held, the loops used and the children that wait; an unused loop costs nothing", () => {
  expect(costOfDelay(ctx)).toEqual([
    "its worktree keeps ports 4100–4109 busy",
    "loop fix: 2 of 3 used",
    "1 child run(s) depend on this run",
  ]);
  expect(costOfDelay({ loops: { fix: 0 }, loopLimits: {}, children: [] })).toEqual([]);
});

test("a card lists the artifacts, the gate reports, the plan's blast radius and the run's place in its group", async () => {
  const fs = new InMemoryFileSystem({
    "runs/r2/plan.md": "the plan",
    "runs/r2/state.json": "{}",
    "runs/r2/plan-scope.json":
      '{"kind":"PlanScope","schemaVersion":1,"plan":"p","edit":["src/a.ts","src/b.ts","docs/x.md"],"shards":[]}',
    "gates/broken.json": "{",
  });
  const card = await decisionCard(
    sources(fs, { r2: { parent: "r0" }, r0: { children: ["r1", "r2", "r3"] } }),
    ctx,
    { reversible: true },
  );
  expect(card.artifacts).toContain("plan.md");
  expect(card.artifacts).not.toContain("state.json");
  expect(card.group).toEqual({ parent: "r0", step: 2, of: 3 });
  expect([card.task, card.done, card.reversible, card.evidence]).toEqual(["Add a flag", ["plan"], true, []]);
  expect(card.costOfDelay).toHaveLength(3);
  expect(card.blastRadius).toEqual({ files: 3, areas: ["docs", "src"] });
});

test("a run without a parent has no group; one its parent does not list is the first of one", async () => {
  const fs = new InMemoryFileSystem();
  const alone = await decisionCard(sources(fs, { r2: {} }), ctx, { reversible: false });
  expect(alone.group).toBeUndefined();
  const unlisted = await decisionCard(sources(fs, { r2: { parent: "r0" }, r0: {} }), ctx, {
    reversible: false,
  });
  expect(unlisted.group).toEqual({ parent: "r0", step: 1, of: 1 });
});
