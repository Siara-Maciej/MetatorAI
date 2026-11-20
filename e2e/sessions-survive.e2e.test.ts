/**
 * Agents' sessions survive the daemon (ADR-0092; real daemon, real PTYs, scenario host only): a
 * conductor with two workers; the daemon killed with SIGKILL comes back with the same panes, each
 * session resumed (the scenario's next entry) under the screen it left. Stopped with SIGTERM and
 * started with `--no-restore`, the panes stay paused (their last screen read-only) until
 * `metator run continue` resumes them and starts the parent run's drive. The chat the task was
 * given in is told, once, when the task is done.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
limits: { parallel: 2 }
stages:
  - id: build
    owner: mt-implementer
    parallel: [mt-tester]
`;
const tester = (n: number) => `    - - say: "tester entry ${n}"
      - ask: { question: "Keep testing ${n}?", options: [yes] }`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-orchestrator:
    - - say: "conducting the first time"
      - run: 'metator run delegate build --run "$METATOR_RUN" --agent mt-tester --card "Part A"'
      - run: 'metator run delegate build --run "$METATOR_RUN" --agent mt-tester --card "Part B"'
      - ask: { question: "Go on?", options: [yes] }
    - - say: "conductor resumed"
      - ask: { question: "Still there?", options: [yes] }
  mt-tester:
${[1, 2, 3, 4, 5, 6].map(tester).join("\n")}
  mt-implementer:
    - - ask: { question: "The parent's drive waits", options: [yes] }
  session:
    - - run: 'metator run new --workflow demo --task "From the chat" >/dev/null'
      - run: 'sleep 120'
`;

let repo: ScratchRepo;
let bin: string;
let daemon: Bun.Subprocess | undefined;
let base = "";
let parent = "";
let runId = "";
type Data = Record<string, unknown>;
interface Pane {
  id: string;
  role: string;
  runId?: string;
  startedRun?: string;
  paused?: { why: string };
  ended?: { reason: string };
  process: { sessionId?: string };
  live?: { alive: boolean; sessionId: string };
}
const env = () => ({
  METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
  METATOR_USER: "ana",
  METATOR_HOST: "scenario",
});
const mt = (...args: string[]) => metator(args, repo.root, env());
const call = async (method: string, path: string, body?: unknown) =>
  (await (
    await fetch(`${base}${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  ).json()) as { ok: boolean; data: Data; error?: Data };
const panes = async () => ((await call("GET", "/layout")).data as { panes: Pane[] }).panes;
const text = async (paneId: string) => (await call("GET", `/panes/${paneId}`)).data.text as string;
const activity = async (id: string) =>
  ((await call("GET", `/runs/${id}/activity`)).data as { entries: { text: string }[] }).entries.map(
    (e) => e.text,
  );

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

async function startDaemon(...extra: string[]): Promise<void> {
  const proc = Bun.spawn(
    [
      "bun",
      CLI_ENTRY,
      "serve",
      "--port",
      "0",
      "--poll-ms",
      "100",
      "--supervise-ms",
      "0",
      "--screens-ms",
      "300",
      ...extra,
    ],
    {
      cwd: repo.root,
      env: {
        ...process.env,
        METATOR_STATE_DIR: E2E_STATE_DIR,
        ...env(),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  daemon = proc;
  const reader = proc.stderr.getReader();
  let seen = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    seen += new TextDecoder().decode(value);
    const line = seen.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  // Keep reading stderr so the daemon never blocks on a full pipe.
  void (async () => {
    for (;;) {
      const { done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
    }
  })();
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  await chmod(join(bin, "metator"), 0o755);
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  const created = async (...args: string[]) =>
    ((await mt("run", "init", ...args)).json.data as Data).runId as string;
  parent = await created("--workflow", "demo", "--task", "The parent task");
  runId = await created("--workflow", "demo", "--task", "Add the discount", "--parent", parent);
  await startDaemon();
}, 60_000);
afterAll(async () => {
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  stopProcessesUnder(repo.root);
  await repo.dispose();
  await rm(bin, { recursive: true, force: true });
}, 60_000);

describe("sessions survive the daemon (real daemon, scenario host)", () => {
  test("SIGKILL mid-run: the conductor and its two workers come back in the same panes, sessions resumed, screens kept", async () => {
    expect((await call("POST", `/runs/${runId}/pty-open`, {})).ok).toBe(true);
    const before = await until("a conductor and two working testers", async () => {
      const p = await panes();
      const workers = p.filter((x) => x.role === "worker");
      if (workers.length < 2) return undefined;
      for (const w of workers) if (!(await text(w.id)).includes("tester entry")) return undefined;
      return p;
    });
    const ids = before.map((p) => p.id).sort();
    // The screens are kept on disk every 300 ms.
    await Bun.sleep(800);
    (daemon as Bun.Subprocess).kill("SIGKILL");
    await daemon?.exited;
    stopProcessesUnder(repo.root);
    await startDaemon();
    const after = await until("every pane back and alive", async () => {
      const p = await panes();
      return p.length === ids.length && p.every((x) => x.live?.alive && !x.paused) ? p : undefined;
    });
    expect(after.map((p) => p.id).sort()).toEqual(ids);
    // The conductor's session resumed: the scenario's next entry, under the screen it left.
    await until("the resumed conductor", async () =>
      (await text("w1:p1")).includes("conductor resumed") ? true : undefined,
    );
    expect(await text("w1:p1")).toContain("conducting the first time");
    for (const w of after.filter((p) => p.role === "worker"))
      expect((await text(w.id)).match(/tester entry \d/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(
      (await activity(runId)).some((t) =>
        /^resumed session scenario-mt-orchestrator-\d+ in pane w1:p1/.test(t),
      ),
    ).toBe(true);
  }, 120_000);

  test("SIGTERM, then --no-restore: the panes stay paused, read-only, until `metator run continue`", async () => {
    (daemon as Bun.Subprocess).kill("SIGTERM");
    await daemon?.exited;
    stopProcessesUnder(repo.root);
    await startDaemon("--no-restore");
    const paused = await panes();
    expect(paused.map((p) => [p.id, p.paused?.why, p.live?.alive ?? false])).toEqual(
      paused.map((p) => [p.id, "daemon-stopped", false]),
    );
    // A paused pane's socket: its last screen, and typing is refused with why.
    const seen: Data[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/pane/w1:p1?by=ana`);
    ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)) as Data);
    await until("the paused screen", async () =>
      seen.some((e) => e.type === "data" && String(e.data).includes("conductor resumed")) ? true : undefined,
    );
    expect(seen[0]).toMatchObject({ type: "paused", paused: { why: "daemon-stopped" } });
    ws.send(JSON.stringify({ type: "input", data: "x" }));
    await until("the refusal", async () => (seen.some((e) => e.type === "refused") ? true : undefined));
    ws.close();
    // One pane alone: its own Continue; a pane that is not paused is refused.
    const one = await call("POST", "/panes/w1:p2/continue", { by: "ana" });
    expect([one.ok, (one.data.resumed as { paneId: string }[])[0]?.paneId, one.data.drives]).toEqual([
      true,
      "w1:p2",
      [],
    ]);
    expect((await call("POST", "/panes/w1:p2/continue", { by: "ana" })).error?.code).toBe(
      "TRANSITION_DENIED",
    );
    // Continue the task from its parent: the paused panes of its child, and the parent's drive.
    const continued = await mt("run", "continue", "--run", parent);
    expect(continued.code).toBe(0);
    const report = continued.json.data as {
      resumed: { paneId: string; role: string }[];
      drives: { runId: string; host: string }[];
    };
    expect(report.resumed.map((r) => r.paneId).sort()).toEqual(
      paused
        .map((p) => p.id)
        .filter((id) => id !== "w1:p2")
        .sort(),
    );
    expect(report.drives).toEqual([{ runId: parent, host: "scenario" }]);
    await until("every pane alive again", async () =>
      (await panes()).every((p) => p.live?.alive && !p.paused) ? true : undefined,
    );
    expect(await activity(parent)).toContain(
      `continued by ana: its drive started again on scenario at build`,
    );
  }, 120_000);

  test("the chat a task was given in is told, once, when the task is done", async () => {
    const chat = await call("POST", "/panes", {
      label: "chat",
      role: "apps",
      host: "scenario",
      agent: "mt-guide",
    });
    const chatId = (chat.data as { id: string }).id;
    const started = await until(
      "the chat's run",
      async () => (await panes()).find((p) => p.id === chatId)?.startedRun,
    );
    expect((await mt("run", "advance", "pass", "--run", started)).code).toBe(0);
    await until("the chat to be told", async () =>
      (await text(chatId)).includes(`[metator] The task ${started} (From the chat) is done`)
        ? true
        : undefined,
    );
    await Bun.sleep(3000);
    const told = (await activity(started)).filter((t) =>
      t.startsWith(`told the chat (pane ${chatId}, done)`),
    );
    expect(told).toHaveLength(1);
    expect((await text(chatId)).split(`[metator] The task ${started}`).length - 1).toBe(1);
  }, 120_000);
});
