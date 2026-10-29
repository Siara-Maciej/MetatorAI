/**
 * `metator arch eval` end to end (H7): the shipped golden cases, each planned in a fresh
 * sandbox repository by mt-arch-planner (the scenario host plays a good plan for one case and a
 * plan that misses for the other) and scored by lint, simulation and the expected fixes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const plan = (id: string, goal: string, moves: string) =>
  `kind: RefactorPlan\nschemaVersion: 1\nid: ${id}\ntitle: ${id}\ngoal: ${goal}\nmoves:\n${moves}`;
// Alphabetical: banner-imports-app is planned first, rules-in-pricing second.
const BANNER = plan(
  "banner-imports-app",
  "no-errors",
  `  - id: title-to-banner
    move: { type: move, files: [apps/web/src/title.ts], to: "@shop/banner" }
    why: The title is what the banner shows; the application only uses the banner.
    citations: ["packages/banner/src/index.ts:1"]
    wave: 1
`,
);
// A plan that declares instead of fixing: lint and the score must see that it misses.
const RULES = plan(
  "rules-in-pricing",
  "no-cycles",
  `  - id: declare
    move: { type: declare, package: "@shop/cart", dependency: zod }
    why: Not a fix.
    citations: ["packages/cart/src/index.ts"]
    wave: 1
`,
);

let repo: ScratchRepo;
const write = (path: string, text: string) =>
  `      - write: { path: ${path}, text: ${JSON.stringify(text)} }\n`;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  for (const id of ["banner-imports-app", "rules-in-pricing"])
    await repo.write(
      `docs/metator/evals/arch/${id}.yml`,
      await Bun.file(join(import.meta.dir, "..", `docs/metator/evals/arch/${id}.yml`)).text(),
    );
  // Two starts of the planner: the first plays the first entry, the second the second.
  await repo.write(
    "scenario.yml",
    [
      "kind: AgentScenario",
      "schemaVersion: 1",
      "agents:",
      "  mt-arch-planner:",
      `    - - say: "planned"\n${write("metator/arch/plans/banner-imports-app.yml", BANNER)}`.trimEnd(),
      `    - - say: "planned"\n${write("metator/arch/plans/rules-in-pricing.yml", RULES)}`.trimEnd(),
      "",
    ].join("\n"),
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator arch eval (real CLI, sandboxes, scenario host)", () => {
  test("list shows the golden cases", async () => {
    const r = await metator(["arch", "eval", "list"], repo.root);
    expect((r.json.data as { cases: { id: string }[] }).cases.map((c) => c.id)).toEqual([
      "banner-imports-app",
      "rules-in-pricing",
    ]);
  });

  test("run scores each case: a good plan passes, a plan that misses does not; --min fails the run", async () => {
    const env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_HOST: "scenario" };
    const r = await metator(["arch", "eval", "run", "--min", "0.9"], repo.root, env);
    expect(r.code).toBe(1);
    const data = (r.json.error as { details: { summary: unknown; cases: Record<string, unknown>[] } })
      .details;
    expect(data.summary).toEqual({ cases: 2, passed: 1, score: 0.7 });
    expect(data.cases[0]).toMatchObject({
      id: "banner-imports-app",
      lintClean: true,
      goalMet: true,
      recall: 1,
      forbidden: [],
      passed: true,
      score: 1,
    });
    expect(data.cases[1]).toMatchObject({
      id: "rules-in-pricing",
      lintClean: false,
      goalMet: false,
      recall: 0,
      passed: false,
    });
    const schema = await metator(["arch", "eval", "schema"], repo.root);
    expect(Object.keys((schema.json.data as { properties: object }).properties)).toContain("expect");
  }, 180_000);
});
