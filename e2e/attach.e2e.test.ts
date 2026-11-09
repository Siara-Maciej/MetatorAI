/**
 * `metator attach` end to end (R4, ADR-0080): the real CLI in a real pseudo-terminal on a pane of
 * the real daemon. A shell pane takes anyone's keys; Ctrl-] detaches and the pane goes on. A run
 * named instead of a pane is its conductor pane: attaching takes the run's driver lock, the
 * person's answer reaches the session, its exit ends the attach and the lock is given back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { inTerminal } from "./helpers/terminal.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "conducting"
      - ask: { question: "Go on?", options: [yes, no] }
      - say: "STATUS: done"
`;

let repo: ScratchRepo;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let runId = "";
type Data = Record<string, unknown>;
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const get = async (path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<{ ok: boolean; data: Data }>;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
  runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Add the discount")).runId as string;
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stderr.getReader();
  let text = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await repo.dispose();
});

describe("metator attach (real daemon, real PTYs)", () => {
  test("a shell pane: keys go through, the pane's bytes come back, Ctrl-] detaches and the pane goes on", async () => {
    const shell = await (
      await fetch(`${base}/panes`, {
        method: "POST",
        body: JSON.stringify({ runId, role: "shell", label: "sh", argv: ["sh", "-i"] }),
      })
    ).json();
    const shellId = (shell.data as { id: string }).id;
    const r = await inTerminal(
      ["attach", shellId, "--by", "maciej"],
      repo.root,
      [
        {
          waitFor: `attached to ${shellId} (shell of run ${runId}); detach: Ctrl-]`,
          keys: "echo hello-from-attach\r",
        },
        { waitFor: "\nhello-from-attach", keys: "\x1d" },
      ],
      30_000,
      env,
    );
    expect(r.screen).toContain(`detached from ${shellId}; the pane goes on`);
    // The shell is the run's pane: the lock was taken for the keys and given back on detach.
    expect(r.json.data).toEqual({ paneId: shellId, ended: "detached", refused: [], runId, released: true });
    const pane = (await get(`/panes/${shellId}`)).data as {
      pane: { live: { alive: boolean } };
      text: string;
    };
    expect([pane.pane.live.alive, pane.text.includes("hello-from-attach")]).toEqual([true, true]);
  }, 60_000);

  test("a run names its conductor pane: the lock is taken, the answer typed reaches the session, the exit ends it and releases", async () => {
    await mt("run", "start");
    const r = await inTerminal(
      ["attach", runId, "--by", "maciej"],
      repo.root,
      [{ waitFor: "Go on? [yes / no]", keys: "yes\r" }],
      30_000,
      env,
    );
    expect(r.screen).toContain(`attached to w1:p2 (conductor of run ${runId})`);
    expect(r.screen).toContain("answer: yes");
    expect(r.screen).toContain("pane w1:p2 exited with 0");
    expect(r.json.data).toEqual({
      paneId: "w1:p2",
      ended: "exited",
      exitCode: 0,
      refused: [],
      runId,
      released: true,
    });
    const state = (await get("/state")).data as { runs: { runId: string; driver: string }[] };
    expect(state.runs.find((r) => r.runId === runId)?.driver).toBe("agent");
    const activity = data(await mt("run", "activity")) as { entries: { type: string; text: string }[] };
    const drivers = activity.entries.filter((e) => e.type === "driver").map((e) => e.text);
    expect(drivers.some((t) => t.includes("maciej"))).toBe(true);
  }, 60_000);

  test("without a terminal it says so; an unknown pane or a dead one is refused before anything is attached", async () => {
    const piped = await mt("attach", "w1:p2", "--by", "maciej");
    expect((piped.json.error as Data).message).toBe("`metator attach` needs a terminal");
    const r = await inTerminal(["attach", "w9:p9", "--by", "maciej"], repo.root, [], 20_000, env);
    expect((r.json.error as Data).code).toBe("NOT_FOUND");
    const dead = await inTerminal(["attach", "w1:p2", "--by", "maciej"], repo.root, [], 20_000, env);
    expect((dead.json.error as Data).message).toBe("pane w1:p2 has no live terminal");
  }, 60_000);
});
