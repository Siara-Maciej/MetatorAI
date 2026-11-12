/**
 * `metator serve` end to end (D3, ADR-0077): the real daemon on localhost serves the state and
 * the inbox, opens a scenario host session in a real PTY for a run, streams its output over a
 * WebSocket, lets only the attached person type, and answers a question through its API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { realpath, rm, symlink } from "node:fs/promises";
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
/** A run of this workflow escalates at once: its only stage is a gate that fails until a file exists. */
const STUCK = `kind: Workflow
schemaVersion: 2
id: stuck
stages:
  - id: check
    gate: { script: "test -f {runDir}/fixed" }
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
  await repo.write(".github/metator/workflows/stuck.yml", STUCK);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  // Drives the daemon starts use the scenario host too: no real AI host is ever started.
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_HOST: "scenario" };
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

  test("a second daemon in the same repository is refused and leaves the first one's file alone (R7)", async () => {
    const before = await repo.read(".metator/daemon.json");
    const pid = (JSON.parse(before) as { pid: number }).pid;
    const second = await mt("serve", "--port", "0");
    expect([second.code, (second.json.error as Data).code]).toEqual([64, "USAGE"]);
    expect((second.json.error as Data).message).toBe(
      `a daemon already serves ${await realpath(repo.root)}: ${base} (pid ${pid})`,
    );
    expect(String((second.json.error as Data).hint)).toContain("metator serve --port <other>");
    expect(await repo.read(".metator/daemon.json")).toBe(before);
    expect((await get("/health")).ok).toBe(true);
  });

  test("an approval or an answer through the API without a name is refused; the state still reads (R1)", async () => {
    const runId = ((await get("/state")).data as { runs: { runId: string }[] }).runs[0]?.runId as string;
    const approved = await post(`/runs/${runId}/approve`, { gate: "push" });
    expect([approved.ok, approved.error?.code]).toEqual([false, "USAGE"]);
    const answered = await post(`/runs/${runId}/answer`, { question: "q001", choices: ["x"] });
    expect([answered.ok, answered.error?.code]).toEqual([false, "USAGE"]);
    const state = await get("/state");
    expect([state.ok, (state.data as { unreadable: unknown[] }).unreadable]).toEqual([true, []]);
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
    // An agent at work in a pane: `metator status` (through the daemon that holds the pane) and the
    // daemon's state count the run as working, and no background drive is claimed for it.
    type Row = { runId: string; attention: string; driving: boolean; session?: { working: boolean } };
    const status = data(await mt("status")) as { runs: Row[]; counts: { driving: number; stopped: number } };
    const row = status.runs.find((r) => r.runId === runId);
    expect([row?.attention, row?.driving, row?.session?.working]).toEqual(["driving", false, true]);
    expect([status.counts.driving, status.counts.stopped]).toEqual([1, 0]);
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
    // The session ended: the run stands still again.
    const after = data(await mt("status")) as { runs: Row[] };
    expect(after.runs.find((r) => r.runId === runId)?.attention).toBe("stopped");
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

  test("a run artifact is read through the API: only a file inside the run directory, never a path or a link out of it", async () => {
    const runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Read the plan"))
      .runId as string;
    const dir = `.metator/runs/${runId}`;
    await repo.write(`${dir}/plan.md`, "# Plan\n\n1. round the totals\n");
    await repo.write(`${dir}/results/w1.json`, '{"status":"done"}\n');
    await repo.write("secret.txt", "not an artifact\n");
    await symlink(repo.path("secret.txt"), repo.path(`${dir}/link.md`));
    const read = (path: string) => get(`/runs/${runId}/artifact?path=${encodeURIComponent(path)}`);
    expect((await read("plan.md")).data).toEqual({
      runId,
      path: "plan.md",
      content: "# Plan\n\n1. round the totals\n",
      truncated: false,
    });
    expect((await read("results/w1.json")).data.content).toBe('{"status":"done"}\n');
    const refused = async (path: string) => {
      const r = await read(path);
      const e = r.error as { code: string; message: string };
      return [r.ok, e.code, e.message.replace(`not an artifact of run ${runId}: `, "")];
    };
    expect(await refused("../../../secret.txt")).toEqual([
      false,
      "USAGE",
      "../../../secret.txt does not stay inside the run directory",
    ]);
    expect(await refused(repo.path("secret.txt"))).toEqual([
      false,
      "USAGE",
      `${repo.path("secret.txt")} is an absolute path`,
    ]);
    // A link a stage (or anyone) left in the run directory does not open what it points at.
    expect(await refused("link.md")).toEqual([false, "USAGE", "link.md leads outside the run directory"]);
    expect(await refused("state.json")).toEqual([false, "USAGE", "state.json is the run's own bookkeeping"]);
    expect(await refused("nope.md")).toEqual([
      false,
      "NOT_FOUND",
      `artifact nope.md of run ${runId} not found`,
    ]);
    expect(await refused("")).toEqual([false, "USAGE", "no path given"]);
    // The route only reads: a POST to it is no route at all.
    const posted = await fetch(`${base}/runs/${runId}/artifact?path=plan.md`, { method: "POST", body: "{}" });
    expect(posted.status).toBe(404);
    await post(`/runs/${runId}/close`, { aborted: true, reason: "the test ends it" });
  });

  test("an escalated run through the API: in the inbox, resumed and driven on, stopped, or closed as aborted (R9)", async () => {
    const escalate = async (task: string) => {
      const runId = data(await mt("run", "init", "--workflow", "stuck", "--task", task)).runId as string;
      expect(data(await mt("run", "drive", "--run", runId, "--host", "scenario")).status).toBe("escalated");
      return runId;
    };
    const statusOf = async (runId: string) => data(await mt("run", "status", "--run", runId)).status;
    const runId = await escalate("Check the totals");
    const inbox = (await get("/inbox")).data as {
      escalated: { runId: string; stage: string; reason: string; next: string[] }[];
    };
    const item = inbox.escalated.find((e) => e.runId === runId);
    expect([item?.stage, item?.next[0]]).toEqual([
      "check",
      `metator run resume --run ${runId} --by <name> --drive`,
    ]);
    expect(item?.reason).toStartWith("gate `test -f {runDir}/fixed`");
    const counts = (await get("/state")).data.counts as { escalated: number; finished: number };
    expect(counts.escalated).toBe(1);
    // A resume needs a name; with one the run is active again and a drive is started.
    const nameless = await post(`/runs/${runId}/resume`, {});
    expect([nameless.ok, (nameless.error as { code: string }).code]).toEqual([false, "USAGE"]);
    // `to` takes only a stage the run worked: the refusal names them, and the run stays escalated.
    const nowhere = await post(`/runs/${runId}/resume`, { by: "maciej", to: "deploy" });
    expect([nowhere.ok, nowhere.error]).toEqual([
      false,
      {
        code: "USAGE",
        message: "the run cannot resume at deploy: it never worked that stage",
        hint: "It escalated at check. Stages it may resume at: check.",
      },
    ]);
    expect(await statusOf(runId)).toBe("escalated");
    const listed = (await get("/state")).data.runs as { runId: string; resumable?: string[] }[];
    expect(listed.find((r) => r.runId === runId)?.resumable).toEqual(["check"]);
    await repo.write(`.metator/runs/${runId}/fixed`, "");
    const resumed = await post(`/runs/${runId}/resume`, {
      by: "maciej",
      to: "check",
      note: "the file is there now",
    });
    expect([resumed.ok, (resumed.data.run as { stage: string }).stage, resumed.data.drive]).toEqual([
      true,
      "check",
      { stage: "check", started: true },
    ]);
    // The note is kept with the run: its board lists the resume.
    const board = (await get(`/runs/${runId}/board`)).data as { resumes: Record<string, unknown>[] };
    expect(board.resumes).toMatchObject([
      { by: "maciej", from: "check", to: "check", note: "the file is there now" },
    ]);
    await until("the resumed run to finish", async () =>
      (await statusOf(runId)) === "done" ? true : undefined,
    );
    expect(((await get("/inbox")).data as { escalated: unknown[] }).escalated).toEqual([]);

    // Close: an abort needs a reason; an escalated run closed with one ends as aborted.
    const other = await escalate("Check the taxes");
    const bare = await post(`/runs/${other}/close`, { aborted: true });
    expect([bare.ok, (bare.error as { code: string }).code]).toEqual([false, "USAGE"]);
    const closed = await post(`/runs/${other}/close`, { aborted: true, reason: "not worth fixing" });
    expect([closed.ok, closed.data.status]).toEqual([true, "aborted"]);
    expect(await statusOf(other)).toBe("aborted");

    // Stop: the drive of a run waiting at its gate ends; the run stays where it is.
    const live = data(await mt("run", "init", "--workflow", "demo", "--task", "Stop me")).runId as string;
    await mt("run", "drive", "--run", live, "--host", "scenario", "--detach");
    await until("its gate", async () => {
      const d = (await get("/inbox")).data as { decisions: { runId: string }[] };
      return d.decisions.some((x) => x.runId === live) ? true : undefined;
    });
    const stopped = await post(`/runs/${live}/stop`, {});
    expect([stopped.ok, typeof stopped.data.stopped]).toEqual([true, "number"]);
    expect([await statusOf(live), data(await mt("run", "activity", "--run", live)).driver]).toEqual([
      "active",
      null,
    ]);
    // Closed with a reason while its question was open: the inbox no longer asks (R3).
    await post(`/runs/${live}/close`, { aborted: true, reason: "the test ends it" });
    const after = (await get("/inbox")).data as { decisions: { runId: string }[] };
    expect(after.decisions.some((x) => x.runId === live)).toBe(false);
  }, 90_000);
});

describe("metator serve stops (last: the daemon is gone after it)", () => {
  test("a daemon that stops removes daemon.json only when the file is still its own (R7)", async () => {
    // Another daemon wrote its address meanwhile (here: this test process, which lives).
    const other = `${JSON.stringify(
      {
        kind: "DaemonInfo",
        schemaVersion: 1,
        url: "http://127.0.0.1:4999",
        pid: process.pid,
        startedAt: "2026-11-12T10:00:00.000Z",
      },
      null,
      2,
    )}\n`;
    await repo.write(".metator/daemon.json", other);
    daemon.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
    expect(await repo.read(".metator/daemon.json")).toBe(other);
    // Its own file is removed: a daemon started and stopped leaves nothing behind.
    await rm(repo.path(".metator/daemon.json"));
    const again = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0"], {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    // It says where it listens as the last step of starting; it heard signals before that.
    const reader = again.stderr.getReader();
    let said = "";
    await until("the second daemon to listen", async () => {
      const { value, done } = await reader.read();
      said += new TextDecoder().decode(value);
      return done || said.includes('"serving"') ? true : undefined;
    });
    await Bun.sleep(500);
    expect(await repo.exists(".metator/daemon.json")).toBe(true);
    again.kill("SIGTERM");
    expect(await again.exited).toBe(0);
    expect(await repo.exists(".metator/daemon.json")).toBe(false);
  }, 60_000);

  test("a SIGTERM the moment daemon.json appears, before the daemon said it listens: it stops and leaves no file", async () => {
    const file = repo.path(".metator/daemon.json");
    // The daemon of the other tests is gone, and so is its file.
    daemon.kill("SIGTERM");
    await daemon.exited;
    await rm(file, { force: true });
    for (let i = 0; i < 3; i++) {
      const d = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0"], {
        cwd: repo.root,
        env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      // As soon as the file is there: the daemon still brings its panes back and has not announced.
      const deadline = Date.now() + 30_000;
      while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(1);
      expect(existsSync(file)).toBe(true);
      d.kill("SIGTERM");
      expect(await d.exited).toBe(0);
      expect(existsSync(file)).toBe(false);
    }
  }, 120_000);
});
