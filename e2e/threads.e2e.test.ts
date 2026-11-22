/**
 * Threads (ADR-0095) with the real `metator` process and a real daemon, on the scenario host only
 * (METATOR_NO_REAL_HOSTS): the CLI lifecycle on the files before any daemon runs; a thread made
 * with its mt-chat pane, whose agent reads it, writes its summary, starts a run (linked, with
 * facts) and opens a new thread for a new topic (the carried line is its first message); runs
 * without a chat; close and reopen (the kept session continued, or a new one told what it
 * continues); and a chat that survives a daemon restart. Nothing is committed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const ROOT = join(import.meta.dir, "..");
const DEMO =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
// Every chat pane counts its own starts (a pane has its own directory), so only the first chat
// does what the prompt tells mt-chat to do; every other chat, and every resumed one, waits for lines.
const FIRST = [
  "metator thread show",
  'metator thread summary --text "Decided: round prices half up."',
  'metator run new --workflow demo --task "Round prices" --allow-dirty',
  'metator thread new --title "Invoice PDF" --carry "The person wants the PDF in A4."',
].join(" && ");
// An agent idle at its prompt that takes the next line typed into it as the person's message.
const HEARS = `      - run: 'read -r line; printf "heard: %s\\n" "$line"'`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-chat:
    - - say: "chat ready"
      - run: 'if [ ! -e "{cwd}/.metator/first-chat" ]; then touch "{cwd}/.metator/first-chat" && ${FIRST}; fi'
${HEARS}
${HEARS}
      - run: 'sleep 300'
    - - say: "chat resumed"
${HEARS}
      - run: 'sleep 300'
  mt-orchestrator:
    - - say: "conducting"
      - ask: { question: "Go on?", options: [go on] }
`;

let repo: ScratchRepo;
let bin: string;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let base = "";
type Data = Record<string, unknown>;
interface Thread {
  id: string;
  title: string;
  state: string;
  summary: string;
  runs: string[];
  panes: { paneId: string; hostSession?: string }[];
  from?: { thread?: string };
  facts: { text: string }[];
  tasks?: { runId: string; status: string }[];
  chat?: { paneId: string; status: string };
}
interface Tree {
  threads: Thread[];
  closed: Thread[];
  withoutChat: { runId: string; task: string }[];
}
interface Pane {
  id: string;
  threadId?: string;
  paused?: unknown;
  ended?: { reason: string };
  process: { kind: string; agent?: string; sessionId?: string };
}
const mt = (...args: string[]) => metator(args, repo.root, env);
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as { ok: boolean; data: Data; error?: Data };
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
const tree = async () => (await api("/threads")).data as unknown as Tree;
const panes = async () => ((await api("/layout")).data as { panes: Pane[] }).panes;
const paneText = async (id: string) =>
  String((await api(`/panes/${encodeURIComponent(id)}?lines=200`)).data.text);
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function startDaemon(): Promise<void> {
  const d = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  daemon = d;
  const reader = d.stderr.getReader();
  let text = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  // Its later lines are not read: drained, so the daemon never blocks on a full pipe.
  void (async () => {
    while (!(await reader.read()).done);
  })();
}
async function stopDaemon(): Promise<void> {
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  daemon = undefined;
}

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  await chmod(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nscenario.yml\n");
  await repo.write(
    "metator.config.yml",
    "kind: MetatorConfig\nschemaVersion: 13\nsupervisor:\n  hostOrder: [scenario]\n",
  );
  await repo.write("package.json", JSON.stringify({ name: "shop", private: true }));
  await repo.write(".github/metator/workflows/demo.yml", DEMO);
  await repo.write(
    ".claude/agents/mt-chat.md",
    await Bun.file(join(ROOT, ".claude/agents/mt-chat.md")).text(),
  );
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
    METATOR_NO_REAL_HOSTS: "1",
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
}, 60_000);
afterAll(async () => {
  await stopDaemon();
  stopProcessesUnder(repo.root);
  await repo.dispose();
  await rm(bin, { recursive: true, force: true });
});

let offline = "";
let first = "";
let second = "";
let started = "";

describe("threads (real CLI and daemon, scenario host)", () => {
  test("without a daemon: a thread is made on the files (no chat yet), summarised, shown, listed and closed", async () => {
    const made = await mt("thread", "new", "--title", "Offline idea", "--by", "ana");
    expect(made.code).toBe(0);
    const data = made.json.data as { thread: Thread; noPane: string };
    offline = data.thread.id;
    expect(offline).toMatch(/^\d{8}-offline-idea$/);
    expect(data.noPane).toContain("no daemon serves this repository");
    expect(data.thread.facts.map((f) => f.text)).toEqual(["opened by ana"]);
    const written = await metator(
      ["thread", "summary", "--thread", offline, "--text", "-"],
      repo.root,
      env,
      "Idea: a dark mode.\n",
    );
    expect((written.json.data as { thread: Thread }).thread.summary).toBe("Idea: a dark mode.");
    const shown = await mt("thread", "show", offline);
    expect(shown.json.data).toMatchObject({ id: offline, title: "Offline idea", tasks: [] });
    expect(((await mt("thread", "list")).json.data as unknown as Tree).threads.map((t) => t.id)).toEqual([
      offline,
    ]);
    const closed = await mt("thread", "close", offline, "--by", "ana");
    expect((closed.json.data as { thread: Thread }).thread.state).toBe("closed");
    // Only a daemon opens a chat terminal; outside a thread's chat a thread must be named.
    expect((await mt("thread", "reopen", offline, "--by", "ana")).code).not.toBe(0);
    const unnamed = await mt("thread", "show");
    expect(unnamed.code).toBe(64);
    expect(String((unnamed.json.error as Data).message)).toBe("name the thread: --thread <id>");
  }, 60_000);

  test("the daemon makes a thread with its mt-chat pane; the agent reads it, summarises, starts a run and opens a new topic", async () => {
    await startDaemon();
    const opened = await post("/threads", { title: "Price rounding", by: "ana", host: "scenario" });
    expect(opened.ok).toBe(true);
    const { thread, pane } = opened.data as unknown as { thread: Thread; pane: Pane };
    first = thread.id;
    expect(pane).toMatchObject({ threadId: first, process: { agent: "mt-chat" } });
    // The run the chat started is the thread's, with a fact; the agent wrote the summary.
    const linked = await until("the run to be linked", async () => {
      const t = (await api(`/threads/${first}`)).data as unknown as Thread;
      return t.runs.length === 1 && t.summary !== "" ? t : undefined;
    });
    started = linked.runs[0] as string;
    expect(linked.summary).toBe("Decided: round prices half up.");
    expect(linked.facts.map((f) => f.text)).toContain(`run ${started} started: Round prices`);
    expect(linked.tasks?.map((x) => x.runId)).toEqual([started]);
    expect(linked.chat).toEqual({ paneId: pane.id, status: "live" });
    // `metator thread show` in the chat found its thread from the pane.
    expect(await paneText(pane.id)).toContain(`"id":"${first}"`);
    // The new topic: a thread from this one, its chat given the carried line first.
    const next = await until("the new thread", async () =>
      (await tree()).threads.find((t) => t.from?.thread === first),
    );
    second = next.id;
    expect(next.title).toBe("Invoice PDF");
    await until("the carried line in the new chat", async () =>
      (await paneText(next.chat?.paneId as string)).includes(
        'heard: [metator] Carried over from thread "Price rounding": The person wants the PDF in A4.',
      )
        ? true
        : undefined,
    );
    expect((await tree()).threads.find((t) => t.id === first)?.state).toBe("open");
    const layout = JSON.parse(await repo.read(".metator/layout.json")) as {
      schemaVersion: number;
      panes: Pane[];
    };
    expect(layout.schemaVersion).toBe(5);
    expect(
      layout.panes
        .filter((p) => p.threadId)
        .map((p) => p.threadId)
        .sort(),
    ).toEqual([first, second].sort());
  }, 120_000);

  test("a run started in a terminal is without a chat; a run's end is a fact of its thread", async () => {
    const other = await mt("run", "new", "--workflow", "demo", "--task", "Fix the footer", "--allow-dirty");
    const otherId = (other.json.data as { runId: string }).runId;
    const t = await tree();
    expect(t.withoutChat.map((r) => r.runId)).toEqual([otherId]);
    expect(t.threads.find((x) => x.id === first)?.tasks?.map((x) => x.runId)).toEqual([started]);
    expect(t.closed.map((x) => x.id)).toEqual([offline]);
    expect(
      ((await api("/state")).data as { threads: { open: number; closed: number } }).threads,
    ).toMatchObject({
      open: 2,
      closed: 1,
    });
    await mt("run", "close", "--run", started, "--aborted", "--reason", "not needed");
    await until("the fact of the aborted run", async () =>
      ((await api(`/threads/${first}`)).data as unknown as Thread).facts.some(
        (f) => f.text === `run ${started} aborted: Round prices`,
      )
        ? true
        : undefined,
    );
  }, 60_000);

  test("closing ends the chat, never a run; reopening continues its session, or starts one told what it continues", async () => {
    const closed = await mt("thread", "close", second, "--by", "ana");
    expect(closed.code).toBe(0);
    const { ended } = closed.json.data as { ended: string };
    expect((await panes()).find((p) => p.id === ended)?.ended?.reason).toBe("closed-by-host");
    expect((await tree()).closed.map((x) => x.id).sort()).toEqual([offline, second].sort());
    const reopened = await mt("thread", "reopen", second, "--by", "ana");
    const back = reopened.json.data as { how: string; pane: Pane; thread: Thread };
    expect(back.how).toBe("resumed");
    // The kept session was continued: the scenario host's resumed session plays its next entry.
    expect(back.thread.panes.at(-2)?.hostSession).toBe("scenario-mt-chat-1");
    expect(back.pane.process.sessionId).toBe("scenario-mt-chat-2");
    expect(back.thread.facts.map((f) => f.text).slice(-2)).toEqual([
      "reopened by ana",
      `chat continued in pane ${back.pane.id} (session resumed)`,
    ]);
    // The thread made without a daemon had no chat: a new session, told first what it continues.
    const fresh = (await post(`/threads/${offline}/reopen`, { by: "ana" })).data as {
      how: string;
      pane: Pane;
    };
    expect(fresh.how).toBe("new-session");
    await until("the continue line in the new chat", async () =>
      (await paneText(fresh.pane.id)).includes(
        'heard: [metator] This chat continues the thread "Offline idea". Run `metator thread show` and carry on from it.',
      )
        ? true
        : undefined,
    );
  }, 120_000);

  test("a thread's chat survives a daemon restart: paused with the daemon, resumed in the same pane", async () => {
    const before = (await panes()).find((p) => p.threadId === first) as Pane;
    await stopDaemon();
    const kept = JSON.parse(await repo.read(".metator/layout.json")) as { panes: Pane[] };
    expect(kept.panes.find((p) => p.id === before.id)?.paused).toBeDefined();
    await startDaemon();
    const t = await until("the chat to be live again", async () => {
      const x = (await api(`/threads/${first}`)).data as unknown as Thread;
      return x.chat?.status === "live" ? x : undefined;
    });
    expect(t.chat?.paneId).toBe(before.id);
    const after = (await panes()).find((p) => p.id === before.id) as Pane;
    // Its session was continued, not started anew (the scenario host's resumed session is the next entry).
    expect([before.process.sessionId, after.process.sessionId]).toEqual([
      "scenario-mt-chat-1",
      "scenario-mt-chat-2",
    ]);
    expect(((await post(`/threads/${first}/reopen`, { by: "ana" })).data as { how: string }).how).toBe(
      "live",
    );
    const threads = await findUnversioned(repo.root, [".metator/threads"]);
    expect([threads.checked, threads.unversioned]).toEqual([3, []]);
    // Nothing was committed by anyone.
    expect((await repo.git("log", "--oneline")).trim().split("\n")).toHaveLength(1);
  }, 120_000);
});
