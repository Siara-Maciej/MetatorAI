/**
 * `metator arch plan` end to end (H5, H6): mt-arch-planner (the scenario host) fills a plan on a
 * real monorepo; the tool simulates and lints it; a person approves it; `arch plan run` starts
 * the wave as a W3 run in its own worktree, and `arch plan status` reads the run back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const PLAN = "metator/arch/plans/break-the-cycle.yml";
const PLAN_TEXT = `kind: RefactorPlan
schemaVersion: 1
id: break-the-cycle
title: Break the cycle
goal: no-cycles
moves:
  - id: rules-to-cart
    move: { type: move, files: [packages/pricing/src/rules.ts], to: "@shop/cart" }
    why: The rules read the cart; they are cart behavior, so pricing no longer needs cart.
    citations: ["packages/pricing/src/rules.ts:1"]
    wave: 1
`;

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);
type Plan = {
  id: string;
  status: string;
  approval?: { by: string };
  result?: { before: { cycles: number }; after: { cycles: number } };
  moves: { id: string; status: string; run?: string; note?: string; effect?: { fixed: string[] } }[];
};

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\nscenario.yml\n");
  await repo.write("package.json", json({ name: "shop", private: true, workspaces: ["packages/*"] }));
  await repo.write(
    "packages/cart/package.json",
    json({ name: "@shop/cart", private: true, main: "src/index.ts", dependencies: { "@shop/pricing": "*" } }),
  );
  await repo.write(
    "packages/cart/src/index.ts",
    'import { price } from "@shop/pricing";\nexport const cart = [price];\n',
  );
  await repo.write(
    "packages/pricing/package.json",
    json({ name: "@shop/pricing", private: true, main: "src/index.ts", dependencies: { "@shop/cart": "*" } }),
  );
  await repo.write("packages/pricing/src/index.ts", "export const price = 1;\n");
  await repo.write(
    "packages/pricing/src/rules.ts",
    'import { cart } from "@shop/cart";\nexport const rules = cart;\n',
  );
  await repo.write(
    ".github/metator/workflows/mt-refactor.yml",
    await Bun.file(join(import.meta.dir, "..", ".github/metator/workflows/mt-refactor.yml")).text(),
  );
  // The planner writes the plan file, as an agent on a real host would with its edit tool.
  await repo.write(
    "scenario.yml",
    `kind: AgentScenario\nschemaVersion: 1\nagents:\n  mt-arch-planner:\n    - - write: { path: ${PLAN}, text: ${JSON.stringify(PLAN_TEXT)} }\n      - say: "One move: the rules go to cart."\n`,
  );
  await repo.commit("init");
  env = {
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_USER: "maciej",
    METATOR_HOST: "scenario",
  };
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator arch plan (real CLI, scenario host)", () => {
  test("propose: the planner fills the plan; the tool writes the effects and lints it clean", async () => {
    const run = await mt("arch", "plan", "propose", "Break", "the", "cycle", "--goal", "no-cycles");
    expect(run.code).toBe(0);
    const { plan, problems } = run.json.data as { plan: Plan; problems: unknown[] };
    expect(problems).toEqual([]);
    expect(plan.result).toMatchObject({ before: { cycles: 1 }, after: { cycles: 0 } });
    expect(plan.moves[0]?.effect?.fixed).toEqual(["cycle:@shop/cart,@shop/pricing"]);
    expect(await repo.read(PLAN)).toContain("effect:");
    expect((await mt("arch", "plan", "lint", "break-the-cycle")).code).toBe(0);
    const list = (await mt("arch", "plan", "list")).json.data as { plans: { id: string; status: string }[] };
    expect(list.plans).toEqual([
      expect.objectContaining({ id: "break-the-cycle", status: "draft", moves: 1, done: 0 }),
    ]);
  }, 90_000);

  test("run refuses a draft; a person approves; an edit after approval needs a new approval", async () => {
    const draft = await mt("arch", "plan", "run", "break-the-cycle");
    expect((draft.json.error as { message: string }).message).toBe("break-the-cycle is not approved");
    const approved = await mt("arch", "plan", "approve", "break-the-cycle");
    expect((approved.json.data as Plan).approval?.by).toBe("maciej");

    const text = await repo.read(PLAN);
    await repo.write(PLAN, text.replace("wave: 1", "wave: 2"));
    const lint = await mt("arch", "plan", "lint", "break-the-cycle");
    expect(JSON.stringify(lint.json.error)).toContain("the moves changed after maciej approved them");
    expect(
      ((await mt("arch", "plan", "run", "break-the-cycle")).json.error as { message: string }).message,
    ).toBe("the moves of break-the-cycle changed after maciej approved them");
    await repo.write(PLAN, text);
  }, 90_000);

  test("run starts the wave as a W3 run in its own worktree; status reads it back", async () => {
    const started = await mt("arch", "plan", "run", "break-the-cycle");
    expect(started.code).toBe(0);
    const r = started.json.data as {
      wave: number;
      started: { move: string; run: string; task: string }[];
      plan: Plan;
    };
    expect([r.wave, r.started.length, r.plan.status]).toEqual([1, 1, "running"]);
    const runId = r.started[0]?.run as string;
    expect(r.started[0]?.task).toStartWith(
      "Move packages/pricing/src/rules.ts to @shop/cart. Why: The rules read the cart",
    );
    expect(await repo.exists(`.metator/wt/${runId}/packages/pricing/src/rules.ts`)).toBe(true);
    const status = (await mt("run", "status", "--run", runId)).json.data as { workflow: string };
    expect(JSON.stringify(status)).toContain("mt-refactor");

    await mt("run", "close", "--run", runId, "--aborted", "--reason", "needs a port first");
    const synced = (await mt("arch", "plan", "status", "break-the-cycle")).json.data as Plan;
    expect([synced.moves[0]?.status, synced.moves[0]?.note]).toEqual(["blocked", `run ${runId} aborted`]);
    await mt("worktree", "rm", runId, "--force");
  }, 120_000);

  test("new, show, simulate and schema", async () => {
    const created = (await mt("arch", "plan", "new", "Layers", "first", "--goal", "fewer-violations")).json
      .data as Plan;
    expect([created.id, created.status]).toEqual(["layers-first", "draft"]);
    expect(((await mt("arch", "plan", "show", "layers-first")).json.data as Plan).moves).toEqual([]);
    const simulated = (await mt("arch", "plan", "simulate", "layers-first")).json.data as Plan;
    expect(simulated.result?.before.cycles).toBe(1);
    const lint = await mt("arch", "plan", "lint", "layers-first");
    expect(JSON.stringify(lint.json.error)).toContain("the plan has no moves");
    const schema = (await mt("arch", "plan", "schema")).json.data as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain("moves");
  }, 90_000);
});
