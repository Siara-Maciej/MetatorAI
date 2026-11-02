/**
 * A worker that finds the task already done (P3), end to end: the real `metator` drives the run,
 * the scenario agent finishes with `STATUS: nothing to do: <evidence>`, a person gets one decision
 * with two answers, and closing ends the run as aborted with the evidence in its log.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: intake
    owner: mt-orchestrator
  - id: build
    owner: mt-implementer
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "pTimeout already takes a signal"
      - say: "STATUS: nothing to do: index.js:41 passes options.signal to the timer"
`;

interface Q {
  id: string;
  prompt: string;
  options: { label: string }[];
}

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
});
afterAll(async () => {
  await mt("run", "stop");
  await repo.dispose();
});

describe("nothing to do (real CLI, scenario host)", () => {
  test("one decision instead of a question in prose; closing ends the run with the evidence", async () => {
    const init = await mt(
      "run",
      "init",
      "--workflow",
      "demo",
      "--task",
      "Add an AbortSignal option to pTimeout",
    );
    const runId = (init.json.data as { runId: string }).runId;
    await mt("run", "drive", "--host", "scenario", "--detach");
    const q = await until("the decision", async () => {
      const qs = ((await mt("run", "questions")).json.data as { questions: Q[] }).questions;
      return qs[0];
    });
    expect(q.options.map((o) => o.label)).toEqual(["Close the run", "Do it anyway", "Other"]);
    expect(q.prompt).toContain("mt-orchestrator found nothing to do: index.js:41 passes options.signal");
    await mt("run", "answer", q.id, "--choice", "Close the run", "--by", "maciej");
    const s = await until("the run to end", async () => {
      const x = (await mt("run", "status")).json.data as { status: string };
      return x.status !== "active" ? x : undefined;
    });
    expect(s.status).toBe("aborted");
    expect(await repo.read(`.metator/runs/${runId}/log.md`)).toContain(
      "nothing to do: index.js:41 passes options.signal to the timer",
    );
  }, 60_000);
});
