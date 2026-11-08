/**
 * herdr under MetatorAI's guard end to end (E, ADR-0079), on a stand-in herdr CLI (the real one
 * when METATOR_E2E_HERDR names it, see the last test): `metator herdr open` makes a workspace per
 * run and types the host's command there with the run's variables, `sync` mirrors the run into
 * herdr's sidebar and notes a host prompt herdr sees, herdr's plugin attaches a person from
 * herdr's workspace id alone, `close` ends the workspace; and the guard refuses what herdr allows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standInHerdr } from "@metator/testing";
import { hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

let repo: ScratchRepo;
let herdr: ReturnType<typeof standInHerdr>;
let env: Record<string, string>;
const mt = (args: string[], cwd = repo.root, extra: Record<string, string> = {}) =>
  metator(args, cwd, { ...env, ...extra });
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.commit("init");
  herdr = standInHerdr(mkdtempSync(join(tmpdir(), "metator-e2e-herdr-")));
  env = {
    METATOR_HERDR_BIN: herdr.bin,
    METATOR_STATE_DIR: mkdtempSync(join(tmpdir(), "metator-e2e-herdr-state-")),
  };
});
afterAll(async () => repo.dispose());

describe("metator herdr (real CLI, stand-in herdr)", () => {
  test("open, sync, the plugin's attach from herdr's workspace id, close", async () => {
    const run = data(await mt(["run", "init", "--workflow", "demo", "--task", "Add the discount"]));
    const runId = run.runId as string;
    const opened = data(await mt(["herdr", "open", "--run", runId, "--host", "claude"]));
    expect(opened).toMatchObject({ runId, workspace: "w1", pane: "w1:p1", host: "claude", reused: false });
    const [create, typed] = herdr.calls();
    expect(create?.slice(0, 7)).toEqual([
      "workspace",
      "create",
      "--cwd",
      repo.root,
      "--label",
      runId,
      "--no-focus",
    ]);
    expect(create).toContain(`METATOR_RUN=${runId}`);
    expect(create).toContain("METATOR_DRIVEN=1");
    expect(typed?.slice(0, 3)).toEqual(["pane", "run", "w1:p1"]);
    expect(typed?.[3]).toStartWith(`claude 'Add the discount' --session-id ${opened.sessionId}`);
    expect(data(await mt(["herdr", "open", "--run", runId])).reused).toBe(true);

    herdr.setAgentStatus("w1:p1", "blocked");
    const synced = data(await mt(["herdr", "sync"])) as { runs: Data[] };
    expect(synced.runs).toEqual([
      { runId, pane: "w1:p1", alive: true, agentStatus: "blocked", title: "build · stopped" },
    ]);
    expect(herdr.calls().find((c) => c[1] === "report-metadata")).toContain("build · stopped");
    const activity = data(await mt(["run", "activity", "--run", runId])) as {
      entries: { type: string; text: string }[];
    };
    expect(activity.entries.filter((e) => e.type === "idle").map((e) => e.text)).toEqual([
      "the host waits at its own prompt in herdr pane w1:p1; answer it there (a person, not another agent)",
    ]);

    // herdr's plugin runs in its own directory and knows only herdr's workspace id.
    const elsewhere = mkdtempSync(join(tmpdir(), "metator-e2e-herdr-plugin-"));
    const attached = await mt(["herdr", "plugin", "attach"], elsewhere, {
      HERDR_WORKSPACE_ID: "w1",
      USER: "maciej",
    });
    expect(attached.json.ok).toBe(true);
    const status = data(await mt(["status"])) as {
      runs: { runId: string; driver: string; attachedBy?: string }[];
    };
    expect(status.runs.find((r) => r.runId === runId)).toMatchObject({
      driver: "human",
      attachedBy: "maciej",
    });
    expect((await mt(["herdr", "plugin", "release"], elsewhere, { HERDR_PANE_ID: "w1:p1" })).json.ok).toBe(
      true,
    );
    const unknown = await mt(["herdr", "plugin", "attach"], elsewhere, { HERDR_WORKSPACE_ID: "w7" });
    expect((unknown.json.error as Data).message).toBe("a MetatorAI run for herdr workspace w7 not found");

    expect(data(await mt(["herdr", "close", "--run", runId]))).toEqual({ runId, closed: true });
    expect(herdr.calls().at(-1)).toEqual(["workspace", "close", "w1"]);
  }, 60_000);

  test("the guard refuses what herdr allows: typing into another pane, its socket, starting agents", async () => {
    const deny = async (command: string) => {
      const r = await hook(["guard", "pre-tool"], { tool_name: "Bash", tool_input: { command } }, repo.root);
      const out = r.json?.hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      return [out?.permissionDecision, out?.permissionDecisionReason?.slice(0, 40)];
    };
    expect(await deny('"$HERDR_BIN_PATH" agent send-keys reviewer y enter')).toEqual([
      "deny",
      "herdr: typing into a herdr pane can answ",
    ]);
    expect((await deny("nc -U $HERDR_SOCKET_PATH"))[0]).toBe("deny");
    expect((await deny("metator herdr open --run x"))[0]).toBe("deny");
    const read = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: "herdr agent list" } },
      repo.root,
    );
    expect(read.json).toBeNull();
  }, 60_000);

  // With real herdr: METATOR_E2E_HERDR=$(which herdr) and a running herdr server (`herdr server`).
  test.skipIf(!process.env.METATOR_E2E_HERDR)(
    "real herdr: open, sync and close a run's workspace",
    async () => {
      const real = { METATOR_HERDR_BIN: process.env.METATOR_E2E_HERDR as string };
      const run = data(await mt(["run", "init", "--workflow", "demo", "--task", "Say hello"]));
      const runId = run.runId as string;
      const opened = await mt(["herdr", "open", "--run", runId, "--host", "claude"], repo.root, real);
      expect(opened.json.ok).toBe(true);
      const synced = await mt(["herdr", "sync"], repo.root, real);
      expect(((synced.json.data as { runs: Data[] }).runs[0] as Data).alive).toBe(true);
      expect((await mt(["herdr", "close", "--run", runId], repo.root, real)).json.ok).toBe(true);
    },
    120_000,
  );
});
