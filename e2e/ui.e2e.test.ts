/**
 * `metator ui` end to end (F8.6): the real CLI in a pseudo-terminal. The session waiting for an
 * answer is picked, answered from the session, its worktree opened in the editor found on PATH
 * (and saved in the config), its application started, then the hub is left.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { inTerminal, KEY } from "./helpers/terminal.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: approval
    hitl: true
  - id: build
    owner: mt-implementer
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-implementer:
    - - write: { path: src/discount.ts, text: "export const discount = 1;\\n" }
      - say: "STATUS: done"
`;

let repo: ScratchRepo;
let env: Record<string, string>;
let runId = "";
const mt = (...args: string[]) => metator(args, repo.root, env);

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nbin/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.write(
    "app.ts",
    'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("hi") });\n',
  );
  await repo.write(
    "metator/environment.yml",
    "kind: Environment\nschemaVersion: 1\nservices:\n  app:\n    source: { script: bun app.ts }\n    ports: { http: 3000 }\n    health: { http: / }\n",
  );
  // A stand-in GUI editor: records what it was asked to open.
  await repo.write("bin/code", `#!/bin/sh\necho "$@" > ${repo.path("opened.txt")}\n`);
  await chmod(repo.path("bin/code"), 0o755);
  await repo.commit("init");
  env = {
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_USER: "maciej",
    PATH: `${repo.path("bin")}:${process.env.PATH}`,
    EDITOR: "",
    VISUAL: "",
  };
  const init = await mt("run", "init", "--workflow", "demo", "--task", "Add discount", "--worktree");
  runId = (init.json.data as { runId: string }).runId;
  await mt("run", "drive", "--host", "scenario", "--detach");
  for (let i = 0; i < 100; i++) {
    if (((await mt("run", "questions")).json.data as { questions: unknown[] }).questions.length > 0) break;
    await Bun.sleep(100);
  }
  await mt("run", "stop");
});
afterAll(async () => {
  await mt("env", "down", "--worktree", runId);
  await mt("run", "stop");
  await repo.dispose();
});

describe("metator ui (real CLI in a terminal)", () => {
  test("pick the waiting session, answer it, open it in the editor, start its app, quit", async () => {
    const r = await inTerminal(
      ["ui"],
      repo.root,
      [
        { waitFor: "1 question(s) for you", keys: KEY.enter }, // the waiting session is first
        // Continue the run · Answer questions (1) · Applications · Open in editor · Shell here · Diff · Back
        { waitFor: "Answer questions (1)", keys: `${KEY.down}${KEY.enter}` },
        { waitFor: "Which question?", keys: KEY.enter },
        { waitFor: "approve to continue", keys: KEY.enter }, // Approve
        { waitFor: "No questions are waiting.", keys: `${KEY.down}${KEY.down}${KEY.enter}` }, // Open in editor
        { waitFor: "Which editor?", keys: KEY.enter }, // the stand-in `code`
        { waitFor: "Opened ", keys: `${KEY.down}${KEY.enter}` }, // Applications
        { waitFor: "Applications of", keys: `${KEY.down}${KEY.enter}` }, // Start all
        { waitFor: "Started.", keys: `${KEY.up}${KEY.enter}` }, // Back (the list wraps)
        { waitFor: "Continue the run", keys: KEY.up + KEY.enter }, // Back
        { waitFor: "Sessions", keys: KEY.up + KEY.enter }, // Quit
      ],
      60_000,
      env,
    );
    expect([r.code, (r.json.data as { visited: string[] }).visited]).toEqual([0, [runId]]);
    // The answer reached the run; the editor was asked to open the worktree and was saved.
    const q = (
      (await mt("run", "questions", "--all")).json.data as { questions: { answer?: { by: string } }[] }
    ).questions;
    expect(q[0]?.answer?.by).toBe("maciej");
    expect((await repo.read("opened.txt")).trim()).toBe(repo.path(".metator", "wt", runId));
    expect(await repo.read("metator.config.yml")).toContain("editor: code");
    const status = (await mt("env", "status", "--worktree", runId)).json.data as {
      services: { status: string }[];
    };
    expect(status.services[0]?.status).toBe("running");
  }, 90_000);

  test("a second session: its question is answered from the inbox without opening it", async () => {
    const init = await mt("run", "init", "--workflow", "demo", "--task", "Fix rounding");
    const second = (init.json.data as { runId: string }).runId;
    await mt("run", "drive", "--run", second, "--host", "scenario", "--detach");
    for (let i = 0; i < 100; i++) {
      const qs = (await mt("run", "questions", "--run", second)).json.data as { questions: unknown[] };
      if (qs.questions.length > 0) break;
      await Bun.sleep(100);
    }
    await mt("run", "stop", "--run", second);
    const r = await inTerminal(
      ["ui"],
      repo.root,
      [
        // Both sessions are listed; up wraps to Quit, up again is Questions (1).
        { waitFor: "1 question(s) for you", keys: KEY.up + KEY.up + KEY.enter },
        { waitFor: "demo-fix-rounding · approval · gate", keys: KEY.enter },
        { waitFor: "approve to continue", keys: KEY.enter },
        { waitFor: "No questions are waiting.", keys: KEY.up + KEY.enter }, // Quit
      ],
      60_000,
      env,
    );
    expect([r.code, (r.json.data as { visited: string[] }).visited]).toEqual([0, []]);
    const q = (
      (await mt("run", "questions", "--run", second, "--all")).json.data as {
        questions: { runId: string; answer?: { choices: string[] } }[];
      }
    ).questions;
    expect(q.map((x) => [x.runId, x.answer?.choices])).toEqual([[second, ["Approve"]]]);
  }, 90_000);

  test("without a terminal, ui points to the commands that do the same", async () => {
    const r = await mt("ui");
    expect([r.code, (r.json.error as { message: string }).message]).toEqual([
      64,
      "`metator ui` needs a terminal",
    ]);
  });
});
