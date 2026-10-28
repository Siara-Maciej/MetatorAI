/**
 * `metator status` end to end (G4): the real CLI sums up the work. A run driven to its human gate
 * waits for you, a run nobody drives is stopped, a conversation is listed; in a folder of
 * repositories, the same for each repository.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: intake
    owner: mt-scout
  - id: approval
    hitl: true
  - id: build
    owner: mt-implementer
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-scout:
    - - say: "STATUS: done"
  mt-guide:
    - - say: "It is in src/a.ts:1."
`;

let folder: string;
let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);

interface RunRow {
  runId: string;
  attention: string;
  stage: string;
  stages: { id: string; state: string; hitl: boolean }[];
  questions: { prompt: string; source: string }[];
  driving: boolean;
  task: string;
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
  const gated = await mt("run", "init", "--workflow", "demo", "--task", "Add discount");
  const runId = (gated.json.data as { runId: string }).runId;
  await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
  for (let i = 0; i < 100; i++) {
    const qs = (await mt("run", "questions", "--run", runId)).json.data as { questions: unknown[] };
    if (qs.questions.length > 0) break;
    await Bun.sleep(100);
  }
  await mt("run", "stop", "--run", runId);
  await mt("run", "init", "--workflow", "demo", "--task", "Fix rounding");
  await mt("ask", "Where is a?", "--host", "scenario");
}, 60_000);
afterAll(async () => {
  await repo.dispose();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe("metator status (real CLI)", () => {
  test("each run with its stages and who must act; the conversations; the counts", async () => {
    const r = await mt("status");
    expect(r.code).toBe(0);
    const o = r.json.data as {
      runs: RunRow[];
      conversations: { title: string; turns: number }[];
      counts: Record<string, number>;
    };
    expect(o.runs.map((x) => [x.task, x.attention, x.stage])).toEqual([
      ["Add discount", "you", "approval"],
      ["Fix rounding", "stopped", "intake"],
    ]);
    const gated = o.runs[0] as RunRow;
    expect(gated.stages.map((s) => `${s.id}:${s.state}`)).toEqual([
      "intake:done",
      "approval:waiting",
      "build:next",
    ]);
    expect(gated.questions.map((q) => q.source)).toEqual(["gate"]);
    expect(o.conversations.map((c) => [c.title, c.turns])).toEqual([["Where is a?", 1]]);
    expect(o.counts).toMatchObject({ you: 1, driving: 0, stopped: 1, questions: 1 });
  }, 30_000);

  test("in a folder of repositories: every repository's overview and the sums", async () => {
    folder = await mkdtemp(join(tmpdir(), "metator-status-folder-"));
    const moved = join(folder, "shop");
    await rename(repo.root, moved);
    (repo as unknown as { root: string }).root = moved;
    const r = await metator(["status"], folder, env);
    const o = r.json.data as { repos: { name: string; runs: RunRow[] }[]; counts: Record<string, number> };
    expect(o.repos.map((x) => [x.name, x.runs.length])).toEqual([["shop", 2]]);
    expect(o.counts).toMatchObject({ you: 1, stopped: 1, questions: 1 });
  }, 30_000);
});
