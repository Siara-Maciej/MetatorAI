/**
 * The pane sensor and host prompts end to end (R3, ADR-0080): the real daemon reads a pane's
 * state from its screen (the scenario host's question is a prompt only a person answers), puts
 * the host prompt in the inbox and runs `notify.command`; the person's "attach" answer takes the
 * driver lock; typing the answer moves the screen on and closes the inbox item; a hook call from
 * a pane (`metator guard`, with the pane's token) is a heartbeat only that pane may send.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "conducting"
      - ask: { question: "Go on?", options: [yes, no] }
      - say: "STATUS: done"
    - - say: "conducting again"
      - ask: { question: "Still on?", options: [yes] }
`;
const CONFIG = `kind: MetatorConfig
schemaVersion: 6
notify:
  command: echo "$METATOR_RUN $METATOR_QUESTION_ID" >> notified.txt
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
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers });

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
  await repo.write(".gitignore", ".metator/\nnotified.txt\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("metator.config.yml", CONFIG);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
  runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Add the discount")).runId as string;
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "200"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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

describe("pane sensor and host prompts (real daemon, real PTYs)", () => {
  test("the host's question on the screen is `blocked`; it reaches the inbox once, notifies, and attach takes the lock; the answer in the pane closes it", async () => {
    await mt("run", "start");
    const waited = data(await mt("pane", "wait", "w1:p1", "--until", "blocked", "--timeout", "15000"));
    expect(waited).toEqual({ state: "blocked", reason: "Go on? [yes / no]" });
    const pane = (await get("/panes/w1:p1")).data as { pane: { state: { state: string } } };
    expect(pane.pane.state.state).toBe("blocked");
    const listed = data(await mt("pane", "list")) as { panes: { id: string; state?: { state: string } }[] };
    expect(listed.panes.map((p) => [p.id, p.state?.state])).toEqual([["w1:p1", "blocked"]]);
    // The supervisor puts the host prompt in the inbox, once, as a permission question of the run.
    const q = await until("the host prompt in the inbox", async () => {
      const inbox = (await get("/inbox")).data as {
        decisions: {
          runId: string;
          question: { id: string; source: string; prompt: string; options: { label: string }[] };
        }[];
      };
      return inbox.decisions.find((d) => d.runId === runId)?.question;
    });
    expect([q.source, q.prompt]).toEqual([
      "permission",
      "scenario waits for your answer in pane w1:p1: Go on? [yes / no]",
    ]);
    expect(q.options.map((o) => o.label)).toEqual(["Attach and answer in the pane", "Leave it", "Other"]);
    await Bun.sleep(700);
    const questions = data(await mt("run", "questions")) as { questions: unknown[] };
    expect(questions.questions.length).toBe(1);
    await until("the notification", async () =>
      (await Bun.file(repo.path("notified.txt")).exists()) ? true : undefined,
    );
    expect(await Bun.file(repo.path("notified.txt")).text()).toBe(`${runId} ${q.id}\n`);
    // The person chooses to answer in the pane: the daemon attaches them.
    expect(
      (
        await (
          await post(`/runs/${runId}/answer`, {
            question: q.id,
            choices: ["Attach and answer in the pane"],
            by: "maciej",
          })
        ).json()
      ).ok,
    ).toBe(true);
    await until("the lock", async () => {
      const state = (await get("/state")).data as {
        runs: { runId: string; driver: string; attachedBy?: string }[];
      };
      const run = state.runs.find((r) => r.runId === runId);
      return run?.driver === "human" && run.attachedBy === "maciej" ? true : undefined;
    });
    // They type the answer: the screen moves on, the session ends, the inbox item is closed by the pane.
    const events: Data[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/pane/w1:p1?by=maciej`);
    ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as Data);
    await until("the socket", async () => (events.length > 0 ? true : undefined));
    ws.send(JSON.stringify({ type: "input", data: "yes\r" }));
    await until("the exit", async () => (events.some((e) => e.type === "exit") ? true : undefined));
    ws.close();
    await until("the item closed", async () => {
      const inbox = (await get("/inbox")).data as { decisions: { runId: string }[] };
      return inbox.decisions.some((d) => d.runId === runId) ? undefined : true;
    });
    const activity = data(await mt("run", "activity")) as { entries: { text: string; type: string }[] };
    const texts = activity.entries.map((e) => e.text);
    expect(texts).toContain("the host prompt in pane w1:p1 went away");
    // The person answered the inbox item (attach), so the pane had nothing left to answer.
    expect(texts.some((t) => t.startsWith(`${q.id}: Attach and answer in the pane · maciej`))).toBe(true);
    expect(data(await mt("pane", "wait", "w1:p1", "--until", "exited", "--timeout", "5000"))).toEqual({
      state: "exited",
      exitCode: 0,
    });
    await mt("run", "release");
  }, 60_000);

  test("a hook call from a pane is its heartbeat: only with the pane's own token; the guard sends it", async () => {
    const shell = await (
      await post("/panes", {
        label: "tools",
        role: "shell",
        argv: ["sh", "-c", "echo token=$METATOR_PANE_TOKEN; sleep 30"],
      })
    ).json();
    const shellId = (shell.data as { id: string }).id;
    const token = await until("the shell to print its token", async () => {
      const text = (await get(`/panes/${shellId}`)).data.text as string;
      return /token=([0-9a-f-]{36})/.exec(text)?.[1];
    });
    expect((await post(`/panes/${shellId}/heartbeat`, {})).status).toBe(403);
    expect((await post("/panes/w1:p1/heartbeat", {}, { "x-metator-pane": token })).status).toBe(403);
    const own = await post(`/panes/${shellId}/heartbeat`, {}, { "x-metator-pane": token });
    expect(own.status).toBe(200);
    const before = ((await get(`/panes/${shellId}`)).data.pane as { live: { lastHookAt?: string } }).live
      .lastHookAt;
    expect(before).toBeDefined();
    await Bun.sleep(20);
    // The real hook process, with the pane's identity in its environment, beats without being asked to.
    const guard = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Read", tool_input: { file_path: repo.path("README.md") } },
      repo.root,
      { ...env, METATOR_PANE_ID: shellId, METATOR_PANE_TOKEN: token, METATOR_ROLE: "shell" },
    );
    expect(guard.code).toBe(0);
    const after = ((await get(`/panes/${shellId}`)).data.pane as { live: { lastHookAt?: string } }).live
      .lastHookAt;
    expect(after).toBeDefined();
    expect((after as string) > (before as string)).toBe(true);
    const state = (await get(`/panes/${shellId}/state`)).data as { state: string; reason: string };
    expect(state).toEqual({ state: "working", reason: "a hook call just now" });
  }, 30_000);

  test("the supervisor resumes the conductor whose session ended while the run goes on (R5)", async () => {
    // The first session exited at the end of the first test; the run is still active.
    const resumed = await until("the conductor to come back", async () => {
      const pane = (await get("/panes/w1:p1")).data as {
        pane: { live: { alive: boolean; sessionId: string } };
        text: string;
      };
      return pane.pane.live.alive && pane.text.includes("conducting again") ? pane : undefined;
    });
    expect(resumed.pane.live.sessionId).toBe("scenario-mt-orchestrator-2");
    const activity = data(await mt("run", "activity")) as { entries: { type: string; text: string }[] };
    const restarts = activity.entries.filter((e) => e.type === "restart").map((e) => e.text);
    expect(restarts.length).toBe(1);
    expect(restarts[0]).toStartWith(
      "resumed conductor 1 of 3: its session scenario-mt-orchestrator-1 had exited with 0 (pane w1:p1)",
    );
  }, 30_000);
});
