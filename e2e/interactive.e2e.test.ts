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
  env = {
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_USER: "maciej",
    METATOR_COPILOT_BIN: "metator-no-such-copilot",
  };
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
        // One workflow here: it is said, not asked.
        { waitFor: "What is the task?", keys: `Add discount${KEY.enter}` },
        { waitFor: "Autonomy", keys: KEY.enter },
        // claude (default), scenario; Copilot is not installed here, so it is not offered.
        { waitFor: "Which AI host", keys: `${KEY.down}${KEY.enter}` },
        { waitFor: "own git worktree", keys: KEY.enter },
        { waitFor: "approve to continue", keys: KEY.enter }, // Approve
        { waitFor: "Round half up or half even?", keys: `${KEY.down}${KEY.enter}` }, // half-even
      ],
      60_000,
      env,
    );
    const data = r.json.data as Followed;
    expect([r.code, data.status, data.detached]).toEqual([0, "done", false]);
    expect(r.screen).toContain("Workflow: demo");
    expect(r.screen).not.toContain("Which workflow?");
    expect(r.screen).not.toContain("GitHub Copilot");
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

  test("the wizard starts at mt-feature, offers only its autonomy levels, and does not ask what has one answer", async () => {
    const other = await ScratchRepo.create();
    try {
      await other.write(".gitignore", ".metator/\n");
      await other.write(".github/metator/workflows/demo.yml", WORKFLOW);
      await other.write(
        ".github/metator/workflows/mt-feature.yml",
        `${WORKFLOW.replace("id: demo", "id: mt-feature")}autonomy: [L0]\n`,
      );
      await other.commit("init");
      const r = await inTerminal(
        ["run"],
        other.root,
        [
          // demo comes first in the list; the cursor stands on mt-feature.
          { waitFor: "Which workflow?", keys: KEY.enter },
          { waitFor: "What is the task?", keys: `Add discount${KEY.enter}` },
          { waitFor: "own git worktree", keys: KEY.ctrlC },
        ],
        30_000,
        // No scenario: Claude Code is the only host left, and Copilot's program is not there.
        { METATOR_COPILOT_BIN: "metator-no-such-copilot", METATOR_USER: "maciej" },
      );
      expect(r.screen).toContain("Autonomy: L0 (the only level mt-feature runs at)");
      expect(r.screen).toContain("AI host: Claude Code (the only one installed here)");
      expect(r.screen).not.toContain("Which AI host");
      expect([r.code, (r.json.error as { message: string }).message]).toEqual([64, "no run started"]);
    } finally {
      await other.dispose();
    }
  }, 60_000);

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
      "Without one, use `metator run new` and `metator run drive`; `metator help` lists every command.",
    ]);
    const init = await mt("run", "init", "--workflow", "demo", "--task", "Fourth change");
    const runId = (init.json.data as { runId: string }).runId;
    const c = await mt("run", "continue", runId, "--host", "scenario");
    expect([c.code, (c.json.data as { driver: { alive: boolean } }).driver.alive]).toEqual([0, true]);
    await mt("run", "stop", "--run", runId);
    const done = await mt("run", "continue", "20991231-demo-nope");
    expect(done.code).not.toBe(0);
  }, 60_000);

  test("`metator run drive` in the foreground at a terminal says each stage as it happens, and the question's command", async () => {
    const init = await mt("run", "init", "--workflow", "demo", "--task", "Fifth change");
    const runId = (init.json.data as { runId: string }).runId;
    const answering = (async () => {
      for (let i = 0; i < 200; i++) {
        const qs = (
          (await mt("run", "questions", "--run", runId)).json.data as { questions: { id: string }[] }
        ).questions;
        // The name is not given: it comes from $METATOR_USER; the label is typed in lower case.
        if (qs[0]) return mt("run", "answer", qs[0].id, "--run", runId, "--choice", "reject", "--text", "no");
        await Bun.sleep(100);
      }
      throw new Error("the gate never asked");
    })();
    const r = await inTerminal(
      ["run", "drive", "--run", runId, "--host", "scenario"],
      repo.root,
      [],
      60_000,
      env,
    );
    expect((await answering).code).toBe(0);
    for (const line of ["▸ plan", "Planning the change", "✓ PASS", "▸ approval"])
      expect(r.screen).toContain(line);
    expect(r.screen).toContain("metator run answer q001 --choice <label>");
    expect(r.screen).toContain("✗ FAIL: no");
    expect((r.json.data as Followed).status).toBe("escalated");
  }, 90_000);

  test("a bare `metator` or `metator --help` at a terminal shows the verbs a person reaches for, and the one JSON line stays", async () => {
    const asked = await inTerminal(["--help"], repo.root, [], 20_000);
    expect([asked.code, asked.json.ok]).toEqual([0, true]);
    expect(asked.screen).toContain("Work on a task");
    const r = await inTerminal([], repo.root, [], 20_000);
    expect(r.code).toBe(0);
    expect(r.screen).toContain("MetatorAI 0.0.0: survey first, prove everything.");
    expect(r.screen).toContain("Work on a task");
    expect(r.screen).toContain("metator run new");
    expect((r.json.data as { verbs: unknown[] }).verbs.length).toBe(6);
  });
});
