/**
 * Answer policies and notifications end to end (P5): the real `metator` drives runs with the
 * scenario host. A person answers a gate with `--always`, the next run's same gate is answered by
 * the policy without a person, a gate that grants the push refuses to become a policy, and every
 * question that waits runs `notify.command`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 3
id: demo
stages:
  - id: plan
    owner: mt-planner
  - id: approval
    hitl: true
  - id: delivery
    hitl: true
    grants: [push]
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-planner:
    - - say: "STATUS: done"
    - - say: "STATUS: done"
`;
const CONFIG = `kind: MetatorConfig
schemaVersion: 6
notify:
  command: echo "$METATOR_RUN $METATOR_QUESTION_ID" >> notified.txt
`;

interface Q {
  id: string;
  stage: string;
  answer?: { by: string; choices: string[] };
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
const questions = async (runId: string, all = false) =>
  ((await mt("run", "questions", "--run", runId, ...(all ? ["--all"] : []))).json.data as { questions: Q[] })
    .questions;
const openAt = (runId: string, stage: string) =>
  until(`a question at ${stage}`, async () => (await questions(runId)).find((q) => q.stage === stage));

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnotified.txt\n");
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

describe("answer policies (real CLI, scenario host)", () => {
  test("--always makes a policy; the next run's same gate is answered by it; the push never is", async () => {
    const first = (
      (await mt("run", "init", "--workflow", "demo", "--task", "Add the first flag to the CLI")).json
        .data as { runId: string }
    ).runId;
    await mt("run", "drive", "--run", first, "--host", "scenario", "--detach");
    const approval = await openAt(first, "approval");
    const answered = await mt(
      "run",
      "answer",
      approval.id,
      "--run",
      first,
      "--choice",
      "Approve",
      "--by",
      "maciej",
      "--always",
    );
    expect(answered.code).toBe(0);
    expect((answered.json.data as { policy: { id: string } }).policy.id).toBe("gate-approval-approve");

    // The push gate: a policy may never answer it.
    const push = await openAt(first, "delivery");
    const refused = await mt(
      "run",
      "answer",
      push.id,
      "--run",
      first,
      "--choice",
      "Approve",
      "--by",
      "maciej",
      "--always",
    );
    expect(refused.code).toBe(64);
    expect((refused.json.error as { message: string }).message).toContain("cannot be taken back");
    await mt("run", "answer", push.id, "--run", first, "--choice", "Approve", "--by", "maciej");
    await until("the first run to finish", async () =>
      ((await mt("run", "status", "--run", first)).json.data as { status: string }).status === "done"
        ? true
        : undefined,
    );

    const second = (
      (await mt("run", "init", "--workflow", "demo", "--task", "Add the second flag to the CLI")).json
        .data as { runId: string }
    ).runId;
    await mt("run", "drive", "--run", second, "--host", "scenario", "--detach");
    await openAt(second, "delivery"); // past the approval with nobody answering it
    const byPolicy = (await questions(second, true)).find((q) => q.stage === "approval");
    expect(byPolicy?.answer).toMatchObject({ by: "policy:gate-approval-approve", choices: ["Approve"] });
    await mt("run", "stop", "--run", second);

    // Every question that waited for a person was announced once; the policy's was not.
    const notified = (await repo.read("notified.txt")).trim().split("\n");
    expect(notified).toEqual([`${first} q001`, `${first} q002`, `${second} q002`]);

    const listed = (await mt("policy", "list")).json.data as { policies: { id: string }[] };
    expect(listed.policies.map((p) => p.id)).toEqual(["gate-approval-approve"]);
    expect(await repo.read("metator/answer-policies.yml")).toContain("kind: AnswerPolicies");
    expect((await mt("policy", "rm", "gate-approval-approve")).code).toBe(0);
    expect(((await mt("policy", "list")).json.data as { policies: unknown[] }).policies).toEqual([]);
  }, 90_000);
});
