/**
 * The driver lock, approvals from the chat and messages between runs (D1, D2, ADR-0077), end to
 * end with the real `metator`: attach takes a session for one person and shows in status,
 * `run approve --via chat` counts only then, a message lands in the other run and its agent
 * reads it as data, and `guard pre-tool` refuses the chat approval while nobody is attached.
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
  - id: build
    owner: mt-implementer
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-planner:
    - - say: "STATUS: done"
  mt-implementer:
    - - say: "STATUS: done"
`;

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const message = (r: { json: Record<string, unknown> }) => (r.json.error as { message: string }).message;

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

describe("driver lock and messages (real CLI)", () => {
  test("attach, status, approval from the chat, release", async () => {
    const run = data(
      await mt("run", "init", "--workflow", "demo", "--task", "Add the first flag to the CLI"),
    );
    const id = run.runId as string;
    await mt("run", "advance", "pass", "--run", id);
    // Nobody attached: the chat's yes does not count, and the hook says so to a driven agent.
    const refused = await mt("run", "approve", "approval", "--run", id, "--by", "maciej", "--via", "chat");
    expect([refused.code, message(refused)]).toEqual([
      64,
      `run ${id}: nobody is attached, so an approval from the chat does not count`,
    ]);
    const hook = await metator(
      ["guard", "pre-tool"],
      repo.root,
      { ...env, METATOR_DRIVEN: "1" },
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "metator run approve approval --by maciej --via chat" },
      }),
    );
    expect(JSON.stringify(hook.json)).toContain("counts only while a person is attached");

    const attached = data(await mt("run", "attach", "--run", id, "--by", "maciej")) as {
      driver: { by: string; attachedBy: string };
    };
    expect([attached.driver.by, attached.driver.attachedBy]).toEqual(["human", "maciej"]);
    const other = await mt("run", "attach", "--run", id, "--by", "alice");
    expect([other.code, message(other)]).toEqual([64, expect.stringContaining("is driven by maciej")]);
    const status = data(await mt("status")) as {
      runs: { runId: string; driver: string; attachedBy?: string }[];
    };
    expect(status.runs.find((r) => r.runId === id)).toMatchObject({ driver: "human", attachedBy: "maciej" });

    const approved = await mt("run", "approve", "approval", "--run", id, "--by", "maciej", "--via", "chat");
    expect([approved.code, (data(approved) as { stage: string }).stage]).toEqual([0, "build"]);
    expect(await repo.read(`.metator/runs/${id}/log.md`)).toContain(
      "approval from the chat · approval · maciej attached since",
    );
    const released = data(await mt("run", "release", "--run", id)) as { driver: { by: string } };
    expect(released.driver.by).toBe("agent");
    const state = JSON.parse(await repo.read(`.metator/runs/${id}/state.json`));
    expect([state.schemaVersion, state.driver]).toEqual([6, { by: "agent" }]);
    const activity = (
      data(await mt("run", "activity", "--run", id)) as { entries: { type: string; origin?: string }[] }
    ).entries;
    expect(activity.filter((e) => e.type === "driver").map((e) => e.origin)).toEqual(["run", "run"]);
  }, 60_000);

  test("a message from one run reaches the other run's agent as data", async () => {
    const a = data(
      await mt("run", "init", "--workflow", "demo", "--task", "Add the invoice type to the core"),
    );
    const b = data(
      await mt("run", "init", "--workflow", "demo", "--task", "Add the invoice list to the web app"),
    );
    const sent = await mt(
      "run",
      "message",
      b.runId as string,
      "--from",
      a.runId as string,
      "--topic",
      "shared-file",
      "--text",
      "Invoice gained a dueDate field",
      "--ref",
      "src/invoice.ts",
      "--by",
      "mt-implementer",
    );
    expect([sent.code, (data(sent) as { id: string; topic: string }).topic]).toEqual([0, "shared-file"]);
    const listed = data(await mt("run", "messages", "--run", b.runId as string)) as {
      messages: { id: string; refs: string[] }[];
    };
    expect(listed.messages.map((m) => [m.id, m.refs])).toEqual([["m001", ["src/invoice.ts"]]]);
    expect(JSON.parse(await repo.read(`.metator/runs/${b.runId}/messages/m001.json`))).toMatchObject({
      kind: "RunMessage",
      schemaVersion: 1,
      topic: "shared-file",
    });

    // Both runs noted it; the receiving run's agents get it in their stage message (unit-tested on the drive).
    for (const [id, text] of [
      [b.runId, `m001 from ${a.runId} · shared-file: Invoice gained a dueDate field`],
      [a.runId, `m001 to ${b.runId} · shared-file: Invoice gained a dueDate field`],
    ] as const) {
      const entries = (
        data(await mt("run", "activity", "--run", id as string)) as {
          entries: { type: string; text: string }[];
        }
      ).entries;
      expect(entries.filter((e) => e.type === "message").map((e) => e.text)).toEqual([text]);
    }
  }, 60_000);
});
