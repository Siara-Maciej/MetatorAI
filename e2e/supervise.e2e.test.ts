/**
 * `metator supervise` end to end (D4, ADR-0077): the real supervisor starts a drive again after
 * its process was killed, gives up after the policy's attempts and says so, and `run init` warns
 * when more runs wait for a person than the attention budget allows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
  - id: approval
    hitl: true
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-planner:
    - - say: "STATUS: done"
`;
const CONFIG = `kind: MetatorConfig
schemaVersion: 7
supervisor:
  wipLimit: 1
  respawn: { enabled: true, maxAttempts: 1 }
`;

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const driver = async (runId: string) =>
  (data(await mt("run", "activity", "--run", runId)) as { driver: { pid: number; alive: boolean } | null })
    .driver;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("metator.config.yml", CONFIG);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
});
afterAll(async () => {
  await mt("run", "stop");
  await repo.dispose();
});

describe("metator supervise (real CLI)", () => {
  test("a killed drive is started again once; the second death is where the policy gives up", async () => {
    const runId = data(
      await mt("run", "init", "--workflow", "demo", "--task", "Add the discount to the invoice"),
    ).runId as string;
    await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
    const first = await until("the gate", async () => {
      const d = await driver(runId);
      const qs = (data(await mt("run", "questions", "--run", runId)) as { questions: unknown[] }).questions;
      return d?.alive && qs.length > 0 ? d : undefined;
    });
    expect((data(await mt("supervise", "--once")) as { revived: unknown[] }).revived).toEqual([]);
    process.kill(first.pid, "SIGKILL");
    await until("the drive to die", async () => ((await driver(runId))?.alive === false ? true : undefined));
    const tick = data(await mt("supervise", "--once")) as {
      revived: { runId: string; stage: string; attempt: number }[];
      attention: Data;
    };
    expect(tick.revived).toEqual([{ runId, stage: "approval", attempt: 1 }]);
    expect(tick.attention).toEqual({ waiting: 1, limit: 1, over: false });
    const second = await until("the drive to come back", async () => {
      const d = await driver(runId);
      return d?.alive && d.pid !== first.pid ? d : undefined;
    });
    process.kill(second.pid, "SIGKILL");
    await until("the drive to die again", async () =>
      (await driver(runId))?.alive === false ? true : undefined,
    );
    const gaveUp = data(await mt("supervise", "--once")) as { revived: unknown[]; gaveUp: string[] };
    expect([gaveUp.revived, gaveUp.gaveUp]).toEqual([[], [runId]]);
    const activity = (
      data(await mt("run", "activity", "--run", runId)) as { entries: { type: string; text: string }[] }
    ).entries;
    expect(activity.filter((e) => e.type === "restart").length).toBe(1);
    expect(activity.at(-1)?.text).toContain("gave up");
  }, 60_000);

  test("run init warns when the attention budget is used up", async () => {
    const r = await mt("run", "init", "--workflow", "demo", "--task", "Add the second flag to the CLI");
    expect(r.code).toBe(0);
    expect((r.json.warnings as string[])[0]).toContain(
      "attention: 1 run(s) already wait for a person (limit 1)",
    );
  });
});
