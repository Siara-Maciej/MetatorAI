/**
 * `run drive|stop|questions|answer|activity` end to end: the real `metator` drives a run in the
 * background on a real repository, agents are played by the scenario host, a person answers
 * from another process, and the run ends with its code in the run's worktree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.md]
  - id: approval
    hitl: true
  - id: build
    owner: mt-implementer
  - id: check
    gate: { script: "test -f {runDir}/plan.md", llm: mt-plan-critic }
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-planner:
    - - say: Planning the change
      - write: { path: "{runDir}/plan.md", text: "# Plan\\n" }
      - say: "STATUS: done"
  mt-implementer:
    - - ask: { question: "Round half up or half even?", options: [half-up, half-even] }
      - write: { path: src/discount.ts, text: "export const discount = 1;\\n" }
      - say: "STATUS: done"
  mt-plan-critic:
    - - say: "VERDICT: PASS"
`;

interface Q {
  id: string;
  source: string;
  prompt: string;
  stage: string;
}
interface Activity {
  driver: { pid: number; alive: boolean } | null;
  entries: { type: string; text: string; stage?: string }[];
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
const openQuestion = (stage: string) =>
  until(`a question at ${stage}`, async () => {
    const qs = ((await mt("run", "questions")).json.data as { questions: Q[] }).questions;
    return qs.find((q) => q.stage === stage);
  });
const activity = async () => (await mt("run", "activity")).json.data as Activity;

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

describe("metator run drive (real CLI, scenario host)", () => {
  test("a run driven in the background: a gate and an agent's question answered from another process", async () => {
    const init = await mt("run", "init", "--workflow", "demo", "--task", "Add discount", "--worktree");
    const runId = (init.json.data as { runId: string }).runId;
    const started = await mt("run", "drive", "--host", "scenario", "--detach");
    expect([started.code, (started.json.data as { detached: boolean }).detached]).toEqual([0, true]);

    const gate = await openQuestion("approval");
    expect([gate.id, gate.source]).toEqual(["q001", "gate"]);
    // A second driver for the same run is refused while the first is alive.
    const second = await mt("run", "drive", "--host", "scenario");
    expect([second.code, (second.json.error as { message: string }).message]).toEqual([
      64,
      `run ${runId} is already driven by process ${(await activity()).driver?.pid}`,
    ]);
    const wrong = await mt("run", "answer", "q001", "--choice", "Maybe", "--by", "maciej");
    expect((wrong.json.error as { message: string }).message).toBe("choose from: Approve, Reject, Other");
    expect((await mt("run", "answer", "q001", "--choice", "Approve", "--by", "maciej")).code).toBe(0);

    const asked = await openQuestion("build");
    expect([asked.source, asked.prompt]).toEqual(["agent", "Round half up or half even?"]);
    await mt("run", "answer", asked.id, "--choice", "half-even", "--by", "maciej");

    const done = await until("the run to finish", async () => {
      const s = (await mt("run", "status")).json.data as { status: string };
      return s.status === "done" ? s : undefined;
    });
    expect(done.status).toBe("done");
    const a = await until("the driver to leave", async () => {
      const x = await activity();
      return x.driver === null && x.entries.at(-1)?.text.startsWith("finished") ? x : undefined;
    });
    expect(a.entries.filter((e) => e.type === "advance").map((e) => `${e.stage} ${e.text}`)).toEqual([
      "plan PASS",
      "approval APPROVE",
      "build PASS",
      "check PASS",
    ]);
    // The code landed in the run's worktree, not in the person's working tree.
    expect(await repo.read(`.metator/wt/${runId}/src/discount.ts`)).toBe("export const discount = 1;\n");
    expect(await repo.exists("src/discount.ts")).toBe(false);
    expect(await repo.exists(`.metator/runs/${runId}/summary.json`)).toBe(true);
    const all = ((await mt("run", "questions", "--all")).json.data as { questions: Q[] }).questions;
    expect(all.map((q) => q.id)).toEqual(["q001", "q002"]);
    expect(
      // Skipped: the person's code (worktree), the agent's own artifact, and the activity log
      // (JSON lines, each a document; checked in the last test).
      (await findUnversioned(repo.root, [".metator"], [".metator/wt/**", "**/plan.md", "**/*.jsonl"]))
        .unversioned,
    ).toEqual([]);
  }, 60_000);

  test("stop leaves the run waiting where it was; driving again asks the same question once", async () => {
    await mt("run", "init", "--workflow", "demo", "--task", "Second change");
    await mt("run", "drive", "--host", "scenario", "--detach");
    const gate = await openQuestion("approval");
    const stopped = await mt("run", "stop");
    expect((stopped.json.data as { stopped: number | null }).stopped).toBeGreaterThan(0);
    expect((await activity()).driver).toBeNull();
    expect(((await mt("run", "status")).json.data as { stage: string }).stage).toBe("approval");

    await mt("run", "drive", "--host", "scenario", "--detach");
    await until("the drive to come back", async () =>
      (await activity()).entries.filter((e) => e.text === "driving with scenario").length === 2
        ? true
        : undefined,
    );
    const open = ((await mt("run", "questions")).json.data as { questions: Q[] }).questions;
    expect(open.map((q) => q.id)).toEqual([gate.id]);
    await mt("run", "answer", gate.id, "--choice", "Reject", "--text", "not now", "--by", "maciej");
    const s = await until("the run to end", async () => {
      const x = (await mt("run", "status")).json.data as { status: string };
      return x.status !== "active" ? x : undefined;
    });
    expect(s.status).toBe("escalated");
  }, 60_000);

  test("every log line of the activity is a versioned document", async () => {
    const runs = ((await mt("run", "list")).json.data as { runId: string }[]).map((r) => r.runId);
    for (const runId of runs) {
      const text = await repo.read(`.metator/runs/${runId}/activity.jsonl`);
      for (const line of text.trim().split("\n"))
        expect(JSON.parse(line)).toMatchObject({ kind: "RunActivity", schemaVersion: 1 });
    }
    expect(CLI_ENTRY.endsWith("main.ts")).toBe(true);
  });
});
