/**
 * The pane runtime end to end (R1, ADR-0080): the real daemon writes where it listens, opens a
 * run's workspace with its conductor and a shell pane, `metator pane list|read|wait` read them
 * through the daemon, a pane's socket streams it, and a restarted daemon brings every pane back
 * (the scenario session resumed at its next entry, the shell started again).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  session:
    - - say: "first session"
      - ask: { question: "Go on?", options: [yes, no] }
      - say: "STATUS: done"
    - - say: "resumed session"
      - ask: { question: "Still there?", options: [yes] }
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

async function startDaemon(): Promise<void> {
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
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
  runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Add the discount")).runId as string;
  await startDaemon();
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await repo.dispose();
});

describe("panes (real daemon, real PTYs)", () => {
  test("the daemon says where it listens; without it `metator pane` says so", async () => {
    const info = JSON.parse(await Bun.file(repo.path(".metator/daemon.json")).text()) as {
      kind: string;
      url: string;
      pid: number;
    };
    expect([info.kind, info.url, info.pid]).toEqual(["DaemonInfo", base, daemon.pid]);
    const elsewhere = await ScratchRepo.create();
    const none = await metator(["pane", "list"], elsewhere.root);
    expect((none.json.error as Data).message).toBe("no daemon runs for this repository");
    await elsewhere.dispose();
  });

  test("a run's conductor and a shell pane; list, read and wait through the CLI; a pane socket streams", async () => {
    expect((await post(`/runs/${runId}/pty-open`, {})).ok).toBe(true);
    const shell = await post("/panes", {
      runId,
      role: "shell",
      label: "sh",
      argv: ["sh", "-c", "echo shell-ready; sleep 60"],
    });
    expect(shell.ok).toBe(true);
    const shellId = (shell.data as { id: string }).id;
    const listed = data(await mt("pane", "list")) as { workspaces: Data[]; panes: Data[] };
    expect(listed.workspaces.map((w) => [w.id, w.label, w.runId])).toEqual([["w1", runId, runId]]);
    expect(listed.panes.map((p) => [p.id, p.role, (p.live as Data | undefined)?.alive])).toEqual([
      ["w1:p1", "conductor", true],
      [shellId, "shell", true],
    ]);
    await until("the shell's line", async () =>
      ((await get(`/panes/${shellId}`)).data.text as string).includes("shell-ready") ? true : undefined,
    );
    const read = data(await mt("pane", "read", shellId, "--lines", "5")) as { text: string };
    expect(read.text).toContain("shell-ready");
    const conductor = data(await mt("pane", "read", "w1:p1")) as { text: string };
    expect(conductor.text).toContain("first session");
    // A short command: wait sees its exit.
    const short = await post("/panes", {
      runId,
      role: "gate",
      label: "gate",
      argv: ["sh", "-c", "echo gate-ok; exit 3"],
    });
    const gateId = (short.data as { id: string }).id;
    const waited = data(await mt("pane", "wait", gateId, "--until", "exited", "--timeout", "10000"));
    expect(waited).toEqual({ state: "exited", exitCode: 3 });
    const events: Data[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/pane/${shellId}?by=maciej`);
    ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as Data);
    await until("the pane socket's backlog", async () =>
      events.some((e) => e.type === "data" && String(e.data).includes("shell-ready")) ? true : undefined,
    );
    expect(events[0]).toMatchObject({
      type: "session",
      session: { paneId: shellId, role: "shell", alive: true },
    });
    ws.close();
    expect((await post(`/panes/${gateId}/close`, {})).data).toEqual({ closed: true });
    expect((await mt("pane", "read", gateId)).json.ok).toBe(false);
  }, 60_000);

  test("a restarted daemon brings the panes back: the session resumed, the shell started again", async () => {
    const before = (await get("/layout")).data as { panes: { id: string; live?: { pid: number } }[] };
    const pids = Object.fromEntries(before.panes.map((p) => [p.id, p.live?.pid]));
    daemon.kill("SIGTERM");
    await daemon.exited;
    expect(existsSync(repo.path(".metator/daemon.json"))).toBe(false);
    await startDaemon();
    const after = await until("the panes to come back", async () => {
      const l = (await get("/layout")).data as {
        panes: { id: string; live?: { pid: number; alive: boolean } }[];
      };
      return l.panes.every((p) => p.live?.alive) ? l : undefined;
    });
    expect(after.panes.map((p) => p.id)).toEqual(Object.keys(pids));
    for (const p of after.panes) expect(p.live?.pid).not.toBe(pids[p.id]);
    await until("the resumed session", async () =>
      ((await get("/panes/w1:p1")).data.text as string).includes("resumed session") ? true : undefined,
    );
    const activity = (await get(`/runs/${runId}/activity`)).data as { entries: { text: string }[] };
    expect(
      activity.entries.some((e) => e.text.startsWith("resumed session scenario-session-2 in pane w1:p1")),
    ).toBe(true);
  }, 60_000);

  test("run close closes the run's panes through the daemon; --remove-worktree takes the worktree with it", async () => {
    const wt = data(
      await mt("run", "init", "--workflow", "demo", "--task", "In a worktree", "--worktree"),
    ) as {
      runId: string;
      worktree: { id: string; path: string };
    };
    expect((await post(`/runs/${wt.runId}/pty-open`, {})).ok).toBe(true);
    const layout = (await get("/layout")).data as {
      workspaces: { id: string; runId?: string; group?: string; cwd: string }[];
    };
    const own = layout.workspaces.find((w) => w.runId === wt.runId);
    const repoWs = layout.workspaces.find((w) => w.id === own?.group);
    expect([own?.cwd.endsWith(wt.worktree.path), repoWs?.runId ?? null, repoWs?.cwd]).toEqual([
      true,
      null,
      repo.root,
    ]);
    await mt("run", "advance", "pass", "--run", wt.runId);
    const closed = data(await mt("run", "close", "--run", wt.runId, "--remove-worktree", "--force")) as {
      status: string;
      panes: { closed: number };
      worktree: { id: string; path: string; removed: boolean };
    };
    expect([closed.status, closed.panes.closed, closed.worktree]).toEqual([
      "done",
      1,
      { id: wt.worktree.id, path: wt.worktree.path, removed: true },
    ]);
    const after = (await get("/layout")).data as { workspaces: { runId?: string }[] };
    expect(after.workspaces.some((w) => w.runId === wt.runId)).toBe(false);
    expect(existsSync(repo.path(wt.worktree.path))).toBe(false);
    expect((data(await mt("worktree", "list")) as { worktrees: unknown[] }).worktrees).toEqual([]);
  }, 60_000);
});
