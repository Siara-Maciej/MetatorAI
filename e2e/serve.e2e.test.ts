/**
 * `metator serve` end to end (D3, ADR-0077): the real daemon on localhost serves the state and
 * the inbox, opens a scenario host session in a real PTY for a run, streams its output over a
 * WebSocket, lets only the attached person type, and answers a question through its API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: build
    owner: mt-implementer
  - id: approval
    hitl: true
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  session:
    - - say: "hello from the session"
      - ask: { question: "Which rounding?", options: [half-up, half-even] }
      - say: "STATUS: done"
  mt-implementer:
    - - say: "STATUS: done"
`;

let repo: ScratchRepo;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
const mt = (...args: string[]) => metator(args, repo.root, env);
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const get = async (path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<{ ok: boolean; data: Data; error?: Data }>;
const post = async (path: string, body: unknown) =>
  (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<{
    ok: boolean;
    data: Data;
    error?: Data;
  }>;

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
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100"], {
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

describe("metator serve (real daemon)", () => {
  test("health, state and inbox come from the same use cases as the CLI", async () => {
    expect((await get("/health")).ok).toBe(true);
    const run = data(
      await mt("run", "init", "--workflow", "demo", "--task", "Add the discount to the invoice"),
    );
    const state = await get("/state");
    expect((state.data as { runs: { runId: string }[] }).runs.map((r) => r.runId)).toEqual([
      run.runId as string,
    ]);
    expect(((await get("/inbox")).data as { decisions: unknown[] }).decisions).toEqual([]);
    expect((await get("/nope")).ok).toBe(false);
  });

  test("a PTY session over a WebSocket: output streams, only the attached person types, the exit arrives", async () => {
    const runId = ((await get("/state")).data as { runs: { runId: string }[] }).runs[0]?.runId as string;
    const events: Record<string, unknown>[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/pty/${runId}?by=maciej`);
    ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as Record<string, unknown>);
    await until("the session to greet", async () =>
      events.some((e) => e.type === "data" && String(e.data).includes("hello from the session"))
        ? true
        : undefined,
    );
    expect(events[0]).toMatchObject({ type: "session", session: { runId, host: "scenario", alive: true } });
    // The agent drives: typing is refused until the person attaches.
    ws.send(JSON.stringify({ type: "input", data: "half-up\r" }));
    await until("the refusal", async () => (events.some((e) => e.type === "refused") ? true : undefined));
    expect(String(events.find((e) => e.type === "refused")?.reason)).toContain("attach first");
    expect((await post(`/runs/${runId}/attach`, { by: "maciej" })).ok).toBe(true);
    ws.send(JSON.stringify({ type: "input", data: "half-up\r" }));
    await until("the answer echoed", async () =>
      events.some((e) => e.type === "data" && String(e.data).includes("answer: half-up")) ? true : undefined,
    );
    await until("the exit", async () => (events.some((e) => e.type === "exit") ? true : undefined));
    expect(events.find((e) => e.type === "exit")).toEqual({ type: "exit", code: 0 });
    ws.close();
    const pty = (await get(`/runs/${runId}/pty`)).data as {
      session: { alive: boolean; exitCode: number };
      backlog: string;
    };
    expect([pty.session.alive, pty.session.exitCode, pty.backlog.includes("STATUS: done")]).toEqual([
      false,
      0,
      true,
    ]);
    const activity = (await get(`/runs/${runId}/activity`)).data as {
      entries: { type: string; origin?: string; text: string }[];
    };
    expect(activity.entries.filter((e) => e.origin === "pty").map((e) => e.text)).toEqual([
      expect.stringContaining("started session scenario-session-1 in pane w1:p1"),
      "session scenario-session-1 exited with 0 (pane w1:p1)",
    ]);
    expect((await post(`/runs/${runId}/release`, {})).ok).toBe(true);
  }, 60_000);

  test("a question answered through the API; the activity socket streams the entries", async () => {
    const runId = ((await get("/state")).data as { runs: { runId: string }[] }).runs[0]?.runId as string;
    await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
    const q = await until("the gate", async () => {
      const inbox = (await get("/inbox")).data as {
        decisions: { runId: string; question: { id: string } }[];
      };
      return inbox.decisions.find((d) => d.runId === runId)?.question;
    });
    const seen: Record<string, unknown>[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/activity/${runId}`);
    ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)) as Record<string, unknown>);
    await until("the backlog", async () => (seen.length > 0 ? true : undefined));
    const answered = await post(`/runs/${runId}/answer`, {
      question: q.id,
      choices: ["Approve"],
      by: "maciej",
    });
    expect(answered.ok).toBe(true);
    // The drive is alive and reads the answer itself: the daemon starts nothing.
    expect(answered.data.drive).toBeUndefined();
    await until("the run to end", async () => {
      const s = (await mt("run", "status", "--run", runId)).json.data as { status: string };
      return s.status === "done" ? true : undefined;
    });
    await until("the answer in the stream", async () =>
      seen.some((e) => (e.entry as { type: string })?.type === "answer") ? true : undefined,
    );
    ws.close();
  }, 60_000);

  test("an answer through the API to a run nothing drives starts its drive again, as the TUI does", async () => {
    const runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Round the totals"))
      .runId as string;
    await mt("run", "drive", "--run", runId, "--host", "scenario", "--detach");
    const q = await until("the gate", async () => {
      const inbox = (await get("/inbox")).data as {
        decisions: { runId: string; question: { id: string } }[];
      };
      return inbox.decisions.find((d) => d.runId === runId)?.question;
    });
    // The drive is stopped: the question stays open with nobody to carry its answer out.
    expect((await mt("run", "stop", "--run", runId)).json.ok).toBe(true);
    await until("the drive to end", async () => {
      const runs = (await get("/state")).data.runs as { runId: string; driving: boolean }[];
      return runs.find((r) => r.runId === runId)?.driving === false ? true : undefined;
    });
    const answered = await post(`/runs/${runId}/answer`, {
      question: q.id,
      choices: ["Approve"],
      by: "maciej",
    });
    expect([answered.ok, answered.data.drive]).toEqual([true, { started: true }]);
    await until("the run to end", async () => {
      const s = (await mt("run", "status", "--run", runId)).json.data as { status: string };
      return s.status === "done" ? true : undefined;
    });
  }, 60_000);
});
