/**
 * Workflow inputs end to end: `run init --input base=main` keeps the value on the run (RunRecord
 * v5) and the drive fills `{base}` in the workflow's scripts; without it `{base|HEAD}` falls back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: diffcheck
input:
  optional: [base]
stages:
  - id: check
    owner: "script:test {base|HEAD} = main"
`;

let repo: ScratchRepo;
const mt = (...args: string[]) =>
  metator(args, repo.root, { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") });
type Data = Record<string, unknown>;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/diffcheck.yml", WORKFLOW);
  await repo.write("scenario.yml", "kind: AgentScenario\nschemaVersion: 1\nagents: {}\n");
  await repo.commit("init");
}, 60_000);
afterAll(async () => {
  await repo.dispose();
});

describe("workflow inputs (real CLI)", () => {
  test("the run keeps --input and its script reads it as {base}", async () => {
    const init = await mt(
      "run",
      "init",
      "--workflow",
      "diffcheck",
      "--task",
      "with base",
      "--input",
      "base=main",
    );
    expect(init.code).toBe(0);
    const id = (init.json.data as Data).runId as string;
    const state = JSON.parse(await repo.read(`.metator/runs/${id}/state.json`));
    expect([state.schemaVersion, state.inputs]).toEqual([5, { base: "main" }]);
    const drive = await mt("run", "drive", "--run", id, "--host", "scenario");
    expect((drive.json.data as Data).status).toBe("done");
  });

  test("without the input the default is used, so the same script fails", async () => {
    const id = ((await mt("run", "init", "--workflow", "diffcheck", "--task", "no base")).json.data as Data)
      .runId as string;
    const drive = await mt("run", "drive", "--run", id, "--host", "scenario");
    expect((drive.json.data as Data).status).toBe("escalated");
  });

  test("an input the workflow does not declare, or one without a value, is a usage error", async () => {
    const unknown = await mt("run", "init", "--workflow", "diffcheck", "--task", "t", "--input", "bse=main");
    expect([unknown.code, (unknown.json.error as Data).message]).toEqual([
      64,
      "workflow diffcheck has no input `bse`",
    ]);
    const bare = await mt("run", "init", "--workflow", "diffcheck", "--task", "t", "--input", "base");
    expect([bare.code, (bare.json.error as Data).code]).toEqual([64, "USAGE"]);
  });
});
