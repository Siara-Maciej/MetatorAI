/**
 * The ways out of a run that stands still, end to end with the real `metator`: a gate approved
 * from another terminal while a drive waits on it (R8), a run aborted under a live drive (R3), an
 * escalated run resumed and driven on or given up (R9, F1, F6), a worktree removed by hand (R10),
 * and a host whose program is not installed (F3). Agents are played by the scenario host.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.md]
  - id: approval
    hitl: true
  - id: check
    gate: { script: "test -f {runDir}/fixed" }
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-planner:
    - - write: { path: "{runDir}/plan.md", text: "# Plan\\n" }
      - say: "STATUS: done"
`;

interface Q {
  id: string;
  stage: string;
  runId: string;
}
type E = { code: string; message: string; hint?: string };
type Data = Record<string, unknown>;

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);
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
const start = async (task: string, ...more: string[]) =>
  data(await mt("run", "init", "--workflow", "demo", "--task", task, ...more)).runId as string;
const gateOf = (runId: string) =>
  until(`the gate of ${runId}`, async () => {
    const qs = (data(await mt("run", "questions", "--run", runId)) as { questions: Q[] }).questions;
    return qs.find((q) => q.stage === "approval");
  });
const status = async (runId: string) => data(await mt("run", "status", "--run", runId));
const statusIs = (runId: string, wanted: string) =>
  until(`run ${runId} to be ${wanted}`, async () => {
    const s = await status(runId);
    return s.status === wanted ? s : undefined;
  });
const driver = async (runId: string) =>
  data(await mt("run", "activity", "--run", runId)).driver as { pid: number; alive: boolean } | null;
const inbox = async () =>
  data(await mt("inbox")) as {
    decisions: { runId: string }[];
    escalated: { runId: string; stage: string; reason?: string; next: string[] }[];
  };

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
});
afterAll(async () => {
  const runs = (await mt("run", "list")).json.data as { runId: string }[];
  for (const r of runs) await mt("run", "stop", "--run", r.runId);
  await repo.dispose();
});

describe("a run that stands still (real CLI, scenario host)", () => {
  test("run approve <gate> while a drive waits on the gate: the drive carries on and no card is left (R8)", async () => {
    const runId = await start("Approve from another terminal");
    await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
    const gate = await gateOf(runId);
    expect((await inbox()).decisions.map((d) => d.runId)).toContain(runId);
    await repo.write(`.metator/runs/${runId}/fixed`, "");
    const approved = await mt("run", "approve", "approval", "--by", "ola", "--run", runId);
    expect(approved.code).toBe(0);
    // The same drive goes on through the next stage: nobody had to answer the question.
    await statusIs(runId, "done");
    const qs = (
      data(await mt("run", "questions", "--run", runId, "--all")) as {
        questions: (Q & { answer?: { choices: string[]; by: string } })[];
      }
    ).questions;
    expect(qs.find((q) => q.id === gate.id)?.answer).toMatchObject({ choices: ["Approve"], by: "ola" });
    expect((await inbox()).decisions.map((d) => d.runId)).not.toContain(runId);
  }, 60_000);

  test("run close --aborted under a live drive: the drive is stopped, the inbox is empty, an answer is refused (R3)", async () => {
    const runId = await start("Abort under a drive");
    await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
    const gate = await gateOf(runId);
    const pid = (await driver(runId))?.pid as number;
    expect((await driver(runId))?.alive).toBe(true);
    const closed = await mt("run", "close", "--run", runId, "--aborted", "--reason", "not needed");
    expect([closed.code, data(closed).status, data(closed).stoppedDriver]).toEqual([0, "aborted", pid]);
    expect(await driver(runId)).toBeNull();
    expect((await inbox()).decisions.map((d) => d.runId)).not.toContain(runId);
    const late = await mt("run", "answer", gate.id, "--choice", "Approve", "--by", "ola", "--run", runId);
    expect([late.code, (late.json.error as E).message]).toEqual([
      64,
      `run ${runId} is aborted: question ${gate.id} no longer waits for an answer`,
    ]);
    expect((await status(runId)).status).toBe("aborted");
  }, 60_000);

  test("an escalated run: said in the inbox and the status, not driven, resumed with --drive, or given up (R9, F1, F6)", async () => {
    const runId = await start("Escalate at the check");
    await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
    const gate = await gateOf(runId);
    await mt("run", "answer", gate.id, "--choice", "Approve", "--by", "ola", "--run", runId);
    const escalated = (await statusIs(runId, "escalated")) as {
      escalated: { stage: string; reason: string; next: string[] };
    };
    const next = [
      `metator run resume --run ${runId} --by <name> --drive`,
      `metator run close --run ${runId} --aborted --reason <why>`,
    ];
    expect([escalated.escalated.stage, escalated.escalated.next]).toEqual(["check", next]);
    expect(escalated.escalated.reason).toStartWith("gate `test -f {runDir}/fixed`");
    const waiting = (await inbox()).escalated.find((e) => e.runId === runId);
    expect([waiting?.stage, waiting?.next]).toEqual(["check", next]);
    // The summary a drive writes at its end leaves the run escalated: it can still be resumed.
    await until("the drive to leave", async () => ((await driver(runId)) === null ? true : undefined));

    // Neither drive nor continue pretends: each names the resume.
    for (const args of [
      ["run", "drive", "--run", runId, "--host", "scenario", "--detach"],
      ["run", "drive", "--run", runId, "--host", "scenario"],
      ["run", "continue", runId, "--host", "scenario"],
    ]) {
      const refused = await mt(...args);
      const e = refused.json.error as E;
      expect([args[1], refused.code, e.code]).toEqual([args[1], 64, "USAGE"]);
      expect(e.message).toStartWith(`run ${runId} escalated at check: gate`);
      expect(e.hint).toContain(next[0] as string);
    }
    expect(await driver(runId)).toBeNull();
    const none = await mt("run", "continue");
    if (none.code !== 0) expect((none.json.error as E).hint ?? "").toContain("metator run resume --run");

    // Resumed without the cause removed: the check fails again and the run escalates again.
    const again = await mt("run", "resume", "--run", runId, "--by", "ola", "--drive", "--host", "scenario");
    expect([again.code, data(again).status, data(again).stage]).toEqual([0, "active", "check"]);
    expect((data(again).drive as { alive: boolean }).alive).toBe(true);
    await statusIs(runId, "escalated");
    await until("the drive to leave", async () => ((await driver(runId)) === null ? true : undefined));
    // The cause removed, then resume: the same command carries the run to its end.
    await repo.write(`.metator/runs/${runId}/fixed`, "");
    expect(
      (await mt("run", "resume", "--run", runId, "--by", "ola", "--drive", "--host", "scenario")).code,
    ).toBe(0);
    await statusIs(runId, "done");
    expect((await inbox()).escalated.map((e) => e.runId)).not.toContain(runId);

    // Given up instead: an escalated run closed with a reason ends as aborted (F6).
    const other = await start("Escalate and give up");
    await mt("run", "drive", "--run", other, "--host", "scenario", "--detach");
    const q = await gateOf(other);
    await mt("run", "answer", q.id, "--choice", "Approve", "--by", "ola", "--run", other);
    await statusIs(other, "escalated");
    const closed = await mt("run", "close", "--run", other, "--aborted", "--reason", "gave up");
    expect([closed.code, data(closed).status]).toEqual([0, "aborted"]);
    expect((await status(other)).status).toBe("aborted");
    expect((await inbox()).escalated.map((e) => e.runId)).not.toContain(other);
  }, 120_000);

  test("a worktree removed by hand: the drive says so and names the two ways on (R10)", async () => {
    const runId = await start("Lose the worktree", "--worktree", "--no-setup");
    const path = (data(await mt("run", "status", "--run", runId)).worktree as { path: string }).path;
    await rm(repo.path(path), { recursive: true, force: true });
    const driven = await mt("run", "drive", "--run", runId, "--host", "scenario");
    const e = driven.json.error as E;
    expect([driven.code, e.code, e.message]).toEqual([
      1,
      "NOT_FOUND",
      `the worktree of run ${runId} is gone: ${path} is not a git checkout any more`,
    ]);
    expect(e.hint).toContain(`metator run close --run ${runId} --aborted`);
    // Nothing was made in its place, and the run is where it was.
    expect(await repo.exists(`${path}/.metator`)).toBe(false);
    expect((await status(runId)).status).toBe("active");
    await mt("run", "close", "--run", runId, "--aborted", "--reason", "worktree removed");
  }, 60_000);

  test("a host whose program is not installed is refused before a stage runs; no loop is spent (F3)", async () => {
    const runId = await start("Drive with a host that is not here");
    const missing = { ...env, METATOR_COPILOT_BIN: repo.path("no-such-copilot") };
    for (const detach of [[], ["--detach"]]) {
      const driven = await metator(
        ["run", "drive", "--run", runId, "--host", "copilot", ...detach],
        repo.root,
        missing,
      );
      const e = driven.json.error as E;
      expect([driven.code, e.code]).toEqual([64, "USAGE"]);
      expect(e.message).toStartWith("AI host copilot cannot start here:");
      expect(e.hint).toContain("--host claude");
    }
    const s = await status(runId);
    expect([s.status, s.stage, s.loops, await driver(runId)]).toEqual(["active", "plan", {}, null]);
    await mt("run", "close", "--run", runId, "--aborted", "--reason", "the test ends it");
  }, 60_000);
});
