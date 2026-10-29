/**
 * The interactive run end to end (F8.4): the real `metator` in a pseudo-terminal asks for a new
 * run, drives it in the background, shows it live and asks its questions in place; `run continue`
 * picks a stopped run up again. Agents are played by the scenario host.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { inTerminal, KEY } from "./helpers/terminal.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
description: Plan, approve, build
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.md]
  - id: approval
    hitl: true
  - id: build
    owner: mt-implementer
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
`;

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write(
    "metator.config.yml",
    "kind: MetatorConfig\nschemaVersion: 2\nhosts:\n  targets: [claude]\n",
  );
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_USER: "maciej" };
});
afterAll(async () => {
  for (const r of ((await mt("run", "list")).json.data as { runId: string }[]) ?? [])
    await mt("run", "stop", "--run", r.runId);
  await repo.dispose();
}, 60_000);

interface Followed {
  runId: string;
  status: string;
  stage: string;
  detached: boolean;
}

describe("metator run in a terminal", () => {
  test("a new run: the wizard, the live view, the gate and the agent's question asked in place", async () => {
    const r = await inTerminal(
      ["run"],
      repo.root,
      [
        { waitFor: "Which workflow?", keys: KEY.enter },
        { waitFor: "What is the task?", keys: `Add discount${KEY.enter}` },
        { waitFor: "Autonomy", keys: KEY.enter },
        // claude (default), copilot, scenario
        { waitFor: "Which AI host", keys: `${KEY.down}${KEY.down}${KEY.enter}` },
        { waitFor: "own git worktree", keys: KEY.enter },
        { waitFor: "approve to continue", keys: KEY.enter }, // Approve
        { waitFor: "Round half up or half even?", keys: `${KEY.down}${KEY.enter}` }, // half-even
      ],
      60_000,
      env,
    );
    const data = r.json.data as Followed;
    expect([r.code, data.status, data.detached]).toEqual([0, "done", false]);
    // The live view showed the stages and the transitions as they happened.
    for (const line of ["▸ plan", "Planning the change", "✓ PASS", "▸ approval", "✓ APPROVE", "▸ build"])
      expect(r.screen).toContain(line);
    const questions = (
      (await mt("run", "questions", "--run", data.runId, "--all")).json.data as {
        questions: { answer: { choices: string[]; by: string } }[];
      }
    ).questions;
    expect(questions.map((q) => [q.answer.choices, q.answer.by])).toEqual([
      [["Approve"], "maciej"],
      [["half-even"], "maciej"],
    ]);
    expect(await repo.read(`.metator/wt/${data.runId}/src/discount.ts`)).toBe("export const discount = 1;\n");
  }, 90_000);

  test("run continue: pick a stopped run, drive it again, answer, done", async () => {
    await mt("run", "init", "--workflow", "demo", "--task", "Second change");
    await mt("run", "drive", "--host", "scenario", "--detach");
    for (let i = 0; i < 100; i++) {
      const qs = ((await mt("run", "questions")).json.data as { questions: unknown[] }).questions;
      if (qs.length > 0) break;
      await Bun.sleep(100);
    }
    await mt("run", "stop");
    const r = await inTerminal(
      ["run", "continue"],
      repo.root,
      [
        { waitFor: "Which run?", keys: KEY.enter },
        { waitFor: "approve to continue", keys: KEY.enter },
        { waitFor: "Round half up or half even?", keys: KEY.enter },
      ],
      60_000,
      env,
    );
    expect(r.screen).toContain("waits for you (1)");
    const data = r.json.data as Followed;
    expect([data.status, data.detached]).toEqual(["done", false]);
  }, 90_000);

  test("Ctrl+C leaves the view; the run goes on and waits for the answer", async () => {
    const init = await mt("run", "init", "--workflow", "demo", "--task", "Third change");
    const runId = (init.json.data as { runId: string }).runId;
    const r = await inTerminal(
      ["run", "continue", runId, "--host", "scenario"],
      repo.root,
      [{ waitFor: "approve to continue", keys: KEY.ctrlC }],
      60_000,
      env,
    );
    expect([(r.json.data as Followed).detached, (r.json.data as Followed).stage]).toEqual([true, "approval"]);
    const a = (await mt("run", "activity", "--run", runId)).json.data as {
      driver: { alive: boolean } | null;
    };
    expect(a.driver?.alive).toBe(true);
    const open = ((await mt("run", "questions", "--run", runId)).json.data as { questions: unknown[] })
      .questions;
    expect(open.length).toBe(1);
    await mt("run", "stop", "--run", runId);
  }, 90_000);

  test("without a terminal, `metator run` says what to use instead; continue starts the drive", async () => {
    const bare = await mt("run");
    expect([bare.code, (bare.json.error as { hint: string }).hint]).toEqual([
      64,
      "Without one, use `metator run init` and `metator run drive`; `metator help` lists every command.",
    ]);
    const init = await mt("run", "init", "--workflow", "demo", "--task", "Fourth change");
    const runId = (init.json.data as { runId: string }).runId;
    const c = await mt("run", "continue", runId, "--host", "scenario");
    expect([c.code, (c.json.data as { driver: { alive: boolean } }).driver.alive]).toEqual([0, true]);
    await mt("run", "stop", "--run", runId);
    const done = await mt("run", "continue", "20991231-demo-nope");
    expect(done.code).not.toBe(0);
  }, 60_000);
});
