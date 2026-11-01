/**
 * `metator ui` end to end (G5): the real CLI in a pseudo-terminal, full screen. The session that
 * waits at its gate is answered in place, the editor is chosen in the settings and opens the
 * worktree, the run's application starts, a question about the code is answered, and q leaves
 * the terminal as it was with the one JSON envelope. In a folder of repositories, every
 * repository's sessions are on the one screen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  mt-guide:
    - - say: "The discount lives in src/discount.ts:1."
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
  await repo.write("src/discount.ts", "export const discount = 0;\n");
  await repo.write(
    "app.ts",
    'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("hi") });\n',
  );
  await repo.write(
    "metator/environment.yml",
    "kind: Environment\nschemaVersion: 2\nservices:\n  app:\n    source: { script: bun app.ts }\n    ports: { http: 3000 }\n    health: { http: / }\n",
  );
  // A stand-in window editor: records what it was asked to open.
  await repo.write("bin/code", `#!/bin/sh\necho "$@" > ${repo.path("opened.txt")}\n`);
  await chmod(repo.path("bin/code"), 0o755);
  await repo.commit("init");
  env = {
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_USER: "maciej",
    METATOR_UI_REFRESH_MS: "300",
    METATOR_HOST: "scenario",
    PATH: `${repo.path("bin")}:${process.env.PATH}`,
    EDITOR: "",
    VISUAL: "",
  };
  const init = await mt("run", "init", "--workflow", "demo", "--task", "Add discount", "--worktree");
  runId = (init.json.data as { runId: string }).runId;
  await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
  for (let i = 0; i < 100; i++) {
    if (((await mt("run", "questions")).json.data as { questions: unknown[] }).questions.length > 0) break;
    await Bun.sleep(100);
  }
  await mt("run", "stop");
}, 60_000);
afterAll(async () => {
  await mt("env", "down", "--worktree", runId);
  await mt("run", "stop");
  await repo.dispose();
}, 60_000);

describe("metator ui (real CLI, full screen)", () => {
  test("answer in place, pick the editor and open the worktree, start the app, ask about the code, quit", async () => {
    const r = await inTerminal(
      ["ui"],
      repo.root,
      [
        { waitFor: "1 need you", keys: KEY.enter }, // the waiting session is selected: answer it
        { waitFor: "approve to continue", keys: KEY.enter }, // Approve
        { waitFor: "Answered q001", keys: "e" }, // no editor yet
        { waitFor: "No editor is set", keys: "," },
        { waitFor: "Settings ·", keys: KEY.enter }, // Editor
        { waitFor: "Settings · editor", keys: KEY.enter }, // the stand-in VS Code found on PATH
        { waitFor: "Saved.", keys: "e" },
        { waitFor: "Opened in your editor.", keys: "\x1b[D" }, // ← from Overview is Apps
        { waitFor: "u: start all", keys: "u" },
        { waitFor: "Applications started.", keys: "?" },
        { waitFor: "Ask about the code", keys: "Where is the discount?" },
        { waitFor: "Where is the discount?", keys: KEY.enter },
        { waitFor: "The discount lives in src/discount.ts:1.", keys: "q" },
      ],
      90_000,
      env,
    );
    expect(r.code).toBe(0);
    expect((r.json.data as { visited: string[] }).visited).toContain(runId);
    // The answer reached the run; the editor was saved and asked to open the worktree.
    const q = (
      (await mt("run", "questions", "--all")).json.data as {
        questions: { answer?: { by: string; choices: string[] } }[];
      }
    ).questions;
    expect([q[0]?.answer?.by, q[0]?.answer?.choices]).toEqual(["maciej", ["Approve"]]);
    expect(await repo.read("metator.config.yml")).toContain("editor: code");
    expect((await repo.read("opened.txt")).trim()).toBe(repo.path(".metator", "wt", runId));
    const status = (await mt("env", "status", "--worktree", runId)).json.data as {
      services: { status: string }[];
    };
    expect(status.services[0]?.status).toBe("running");
    const talks = ((await mt("ask", "list")).json.data as { conversations: { title: string }[] })
      .conversations;
    expect(talks.map((c) => c.title)).toEqual(["Where is the discount?"]);
  }, 120_000);

  test("in a folder of repositories every repository's sessions are on one screen", async () => {
    const folder = await mkdtemp(join(tmpdir(), "metator-ui-folder-"));
    for (const name of ["shop", "billing"]) {
      const dir = join(folder, name);
      const git = (...a: string[]) =>
        Bun.spawnSync(
          ["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a],
          { cwd: dir },
        );
      Bun.spawnSync(["mkdir", "-p", join(dir, ".github/metator/workflows")]);
      git("init", "-q", "-b", "main");
      await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
      await Bun.write(join(dir, ".gitignore"), ".metator/\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      await metator(["run", "init", "--workflow", "demo", "--task", `Work in ${name}`], dir, env);
    }
    const r = await inTerminal(
      ["ui"],
      folder,
      [
        { waitFor: "2 repositories", keys: "" },
        { waitFor: "Work in shop", keys: "q" },
      ],
      60_000,
      // A terminal where CI is set (CI runners, some dev containers) still gets the full screen.
      { ...env, CI: "true" },
    );
    expect(r.code).toBe(0);
    expect(r.screen).toContain("billing");
    expect(r.screen).toContain("Work in billing");
    expect(r.screen).toContain("2 need you");
    await rm(folder, { recursive: true, force: true });
  }, 90_000);

  test("an escalated run shows the stage it stopped at, and c resumes and drives it", async () => {
    const other = await ScratchRepo.create();
    await other.write(".gitignore", ".metator/\n");
    await other.write(
      ".github/metator/workflows/fix.yml",
      "kind: Workflow\nschemaVersion: 2\nid: fix\nstages:\n  - id: build\n    owner: mt-implementer\n",
    );
    await other.write("scenario.yml", SCENARIO);
    await other.commit("init");
    const here = { ...env, METATOR_AGENT_SCENARIO: other.path("scenario.yml") };
    await metator(["run", "init", "--workflow", "fix", "--task", "Fix the discount"], other.root, here);
    await metator(["run", "advance", "fail", "--reason", "the gate needs a token"], other.root, here);
    const r = await inTerminal(
      ["ui"],
      other.root,
      [
        { waitFor: "at build: fix the cause, then resume it (c)", keys: "c" },
        { waitFor: "every stage passed", keys: "q" },
      ],
      60_000,
      here,
    );
    expect(r.code).toBe(0);
    expect(r.screen).toContain("1 escalated");
    expect(r.screen).toContain("[build !]");
    const status = (await metator(["run", "status"], other.root, here)).json.data as { status: string };
    expect(status.status).toBe("done");
    expect(await other.read("src/discount.ts")).toBe("export const discount = 1;\n");
    await other.dispose();
  }, 90_000);

  test("without a terminal, ui points to the commands that do the same", async () => {
    const r = await mt("ui");
    expect([r.code, (r.json.error as { message: string; hint: string }).message]).toEqual([
      64,
      "`metator ui` needs a terminal",
    ]);
    expect((r.json.error as { hint: string }).hint).toContain("metator status");
  });
});
