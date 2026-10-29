/**
 * `metator system eval` end to end (F7.7): the shipped golden cases in a real repository, each
 * analyzed and planned in a fresh git repository and scored; a case the tool gets wrong lowers
 * the score and fails `--min`; with `--host` the system agents run on the scenario host.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SHIPPED = join(import.meta.dir, "..", "docs/metator/evals/system");

interface Score {
  id: string;
  score: number;
  passed: boolean;
  impactRecall: number;
  impactPrecision: number;
}
type Report = {
  summary: { cases: number; passed: number; score: number; impactRecall: number };
  cases: Score[];
};

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nscenario.yml\n");
  for (const file of await readdir(SHIPPED))
    await repo.write(`docs/metator/evals/system/${file}`, await Bun.file(join(SHIPPED, file)).text());
  await repo.write(
    "scenario.yml",
    'kind: AgentScenario\nschemaVersion: 1\nagents:\n  mt-system-scout:\n    - - say: "The analysis holds."\n  mt-system-planner:\n    - - say: "The draft holds."\n',
  );
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_USER: "ana", METATOR_HOST: "scenario" };
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator system eval (real CLI, shipped golden cases)", () => {
  test("the tool alone analyzes and plans every shipped case right", async () => {
    const list = (await mt("system", "eval", "list")).json.data as { cases: { id: string }[] };
    expect(list.cases.map((c) => c.id)).toEqual(["add-credits", "rename-refunds", "versioned-prices"]);
    const run = await mt("system", "eval", "run", "--min", "1");
    expect(run.code).toBe(0);
    const r = run.json.data as Report;
    expect(r.summary).toEqual({ cases: 3, passed: 3, score: 1, impactRecall: 1 });
  }, 120_000);

  test("a case whose expectations the plan misses scores below 1 and fails --min", async () => {
    const text = await repo.read("docs/metator/evals/system/rename-refunds.yml");
    await repo.write(
      "docs/metator/evals/system/rename-refunds.yml",
      text.replace("applications: [billing, web, mail]", "applications: [billing, web, mail, search]"),
    );
    const one = (await mt("system", "eval", "run", "--case", "rename-refunds")).json.data as Report;
    expect(one.cases.map((c) => [c.id, c.passed, c.impactRecall, c.impactPrecision])).toEqual([
      ["rename-refunds", false, 0.75, 1],
    ]);
    const min = await mt("system", "eval", "run", "--case", "rename-refunds", "--min", "1");
    expect([min.code, (min.json.error as { code: string }).code]).toEqual([1, "CHECK_FAILED"]);
    await repo.write("docs/metator/evals/system/rename-refunds.yml", text);
  }, 120_000);

  test("with --host the system agents run on the host and the plan is scored the same way", async () => {
    const run = await mt("system", "eval", "run", "--host", "scenario", "--case", "versioned-prices");
    expect(run.code).toBe(0);
    expect((run.json.data as Report).cases.map((c) => [c.id, c.score])).toEqual([["versioned-prices", 1]]);
    const schema = (await mt("system", "eval", "schema")).json.data as { properties: object };
    expect(Object.keys(schema.properties)).toContain("expect");
  }, 120_000);
});
