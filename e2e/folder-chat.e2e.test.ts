/**
 * The chat of a folder of repositories (ADR-0113) with the real `metator` process and a real
 * daemon, on the scenario host only (METATOR_NO_REAL_HOSTS): a thread asked for the folder itself
 * is kept in the folder, its chat starts there with the conversation agent copied from a
 * repository and is told which repositories there are; the agent reads its thread, starts a run
 * in one repository with `-C`, and that run is the folder thread's task; a repository's own chat
 * still opens in the repository. Nothing is committed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";

const ROOT = join(import.meta.dir, "..");
const DEMO =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const CONFIG = "kind: MetatorConfig\nschemaVersion: 13\nsupervisor:\n  hostOrder: [scenario]\n";
// The folder's chat does what the conversation agent does there: reads its thread, keeps the
// summary, and starts the run in the repository it belongs to. A repository's chat only greets
// (shop has no conversation agent, so its chat is the agent that started runs before).
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-chat:
    - - say: "chat in {cwd}"
      - run: 'if [ -d web ]; then metator thread show && metator thread summary --text "Decided: the price is rounded in web." && metator -C web run new --workflow demo --task "Round prices" --allow-dirty; fi'
      - run: 'sleep 300'
  mt-orchestrator:
    - - say: "chat in {cwd}"
      - run: 'sleep 300'
`;

let folder: string;
let bin: string;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let base = "";
type Data = Record<string, unknown>;
interface Task {
  runId: string;
  repo?: string;
}
interface Thread {
  id: string;
  repo?: string;
  summary: string;
  runs: string[];
  panes: { paneId: string; repo?: string }[];
  facts: { text: string }[];
  tasks?: Task[];
  chat?: { paneId: string; repo?: string; status: string };
}
interface Pane {
  id: string;
  cwd: string;
  threadId?: string;
  process: { agent?: string; prompt?: string };
}
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as { ok: boolean; data: Data; error?: Data };
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
const threads = async () =>
  (await api("/threads")).data as unknown as { threads: Thread[]; withoutChat: Task[] };
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-c", "user.email=ana@example.com", "-c", "user.name=ana", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await p.exited) !== 0)
    throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  await chmod(join(bin, "metator"), 0o755);
  folder = await mkdtemp(join(tmpdir(), "metator-folder-chat-e2e-"));
  for (const name of ["shop", "web"]) {
    const root = join(folder, name);
    await mkdir(root, { recursive: true });
    await Bun.write(join(root, ".gitignore"), ".metator/\n");
    await Bun.write(join(root, "metator.config.yml"), CONFIG);
    await Bun.write(join(root, "package.json"), JSON.stringify({ name, private: true }));
    await Bun.write(join(root, ".github/metator/workflows/demo.yml"), DEMO);
    await git(root, "init", "-q");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "init");
  }
  // Only one repository has the conversation agent's host file: the folder's copy comes from it.
  await Bun.write(
    join(folder, "web/.claude/agents/mt-chat.md"),
    await Bun.file(join(ROOT, ".claude/agents/mt-chat.md")).text(),
  );
  await Bun.write(join(folder, "scenario.yml"), SCENARIO);
  env = {
    METATOR_NO_REAL_HOSTS: "1",
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const d = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: folder,
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
  void (async () => {
    while (!(await reader.read()).done);
  })();
}, 60_000);
afterAll(async () => {
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  stopProcessesUnder(folder);
  await rm(folder, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

let own = "";

describe("the chat of a folder of repositories (real CLI and daemon, scenario host)", () => {
  test("a thread asked for the folder is the folder's: kept there, its chat started there and told the repositories", async () => {
    const opened = await post("/threads?repo=.", { by: "ana", host: "scenario" });
    expect(opened.ok).toBe(true);
    const { thread, pane } = opened.data as unknown as { thread: Thread; pane: Pane };
    own = thread.id;
    expect(thread.panes).toMatchObject([{ repo: ".", paneId: pane.id }]);
    expect(pane.cwd).toBe(folder);
    expect(pane).toMatchObject({ threadId: own, process: { agent: "mt-chat" } });
    expect(pane.process.prompt).toContain("a folder of 2 repositories, not in one of them: shop, web");
    // Its record and the agent's host file are in the folder; no repository got a thread.
    expect(existsSync(join(folder, ".metator/threads", `${own}.json`))).toBe(true);
    expect(await Bun.file(join(folder, ".claude/agents/mt-chat.md")).text()).toBe(
      await Bun.file(join(folder, "web/.claude/agents/mt-chat.md")).text(),
    );
    expect(existsSync(join(folder, "shop/.metator/threads"))).toBe(false);
    expect(existsSync(join(folder, "web/.metator/threads"))).toBe(false);
    // The layout of the folder itself has the pane.
    const layout = (await api("/layout?repo=.")).data as { panes: Pane[] };
    expect(layout.panes.map((p) => p.id)).toEqual([pane.id]);
  }, 60_000);

  test("its agent reads the thread in the folder and starts a run in one repository: the run is the folder thread's task", async () => {
    const linked = await until("the run to be linked", async () => {
      const t = (await threads()).threads.find((x) => x.id === own);
      return t && t.runs.length === 1 && t.summary !== "" ? t : undefined;
    });
    expect(linked.repo).toBe(".");
    expect(linked.summary).toBe("Decided: the price is rounded in web.");
    expect(linked.chat).toMatchObject({ repo: ".", status: "live" });
    const run = linked.runs[0] as string;
    expect(linked.facts.map((f) => f.text)).toContain(`run ${run} started: Round prices`);
    expect(linked.tasks).toMatchObject([{ runId: run, repo: "web" }]);
    // The run is kept in the repository it was started in, and no "Without a chat" lists it.
    expect(existsSync(join(folder, "web/.metator/runs", run, "state.json"))).toBe(true);
    expect((await threads()).withoutChat).toEqual([]);
    // `metator thread list` in the folder lists the folder's threads.
    const listed = await metator(["thread", "list"], folder, env);
    expect(listed.code).toBe(0);
    expect((listed.json.data as { threads: Thread[] }).threads.map((t) => t.id)).toEqual([own]);
  }, 90_000);

  test("the run's end is a fact of the folder's thread", async () => {
    const run = ((await threads()).threads.find((x) => x.id === own) as Thread).runs[0] as string;
    const closed = await metator(
      ["-C", "web", "run", "close", run, "--aborted", "--reason", "not now"],
      folder,
      env,
    );
    expect(closed.code).toBe(0);
    const noted = await until("the fact", async () => {
      const t = (await threads()).threads.find((x) => x.id === own);
      return t?.facts.find((f) => f.text.startsWith(`run ${run} aborted`));
    });
    expect(noted.text).toBe(`run ${run} aborted: Round prices`);
  }, 60_000);

  test("a repository's own chat still opens in the repository", async () => {
    // Untitled like the folder's chat, the same day: its id is still its own, across the folder.
    const opened = await post("/threads?repo=shop", { by: "ana", host: "scenario" });
    expect(opened.ok).toBe(true);
    const { thread, pane } = opened.data as unknown as { thread: Thread; pane: Pane };
    expect(pane.cwd).toBe(join(folder, "shop"));
    expect(thread.panes).toMatchObject([{ repo: "shop" }]);
    expect(thread.id).toBe(`${own}-2`);
    expect(pane.process.prompt ?? "").not.toContain("a folder of");
    expect(existsSync(join(folder, "shop/.metator/threads", `${thread.id}.json`))).toBe(true);
    const all = (await threads()).threads.map((t) => [t.id, t.repo]);
    expect(all).toContainEqual([own, "."]);
    expect(all).toContainEqual([thread.id, "shop"]);
  }, 60_000);
});
