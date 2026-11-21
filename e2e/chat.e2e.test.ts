/**
 * The conversation agent `mt-chat` (ADR-0093) with a real daemon and real PTYs, on the scenario
 * host only: the daemon names it for the "+ New run" chat once the repository holds its host
 * file; its pane is told who it is in the chat's own words; from that pane it does a direct edit
 * recorded as scratch, starts a quick run and a full run (each with a conductor in its own
 * terminal, never a background drive), and the pane remembers the run it started as that task's
 * main terminal. Nothing is committed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const QUICK = await Bun.file(join(ROOT, ".github/metator/workflows/mt-quick.yml")).text();
const DEMO =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
// The chat does what a model would do, command by command; each conductor only says it is there.
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-chat:
    - - say: "chat ready"
      - run: 'metator scratch begin '
      - write: { path: "{cwd}/src/price.ts", text: "export const price = (n: number) => n;\\nconsole.log(\\"price\\");\\n" }
      - run: 'metator scratch end --note "trace price calls" '
      - run: 'metator quick start --task "Round prices half-up" --here '
      - run: 'metator run new --workflow demo --task "Add a currency column" --allow-dirty '
      - run: 'metator run start '
      - say: "both started"
      - ask: { question: "What next?", options: [nothing] }
  mt-orchestrator:
    - - say: "conducting {cwd}"
      - ask: { question: "Type here to talk to the conductor.", options: [go on] }
`;

let repo: ScratchRepo;
let bin: string;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
type Data = Record<string, unknown>;
interface Pane {
  id: string;
  role: string;
  label: string;
  runId?: string;
  startedRun?: string;
  process: { kind: string; agent?: string; prompt?: string };
}
const mt = (...args: string[]) => metator(args, repo.root, env);
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as { ok: boolean; data: Data; error?: Data };
const panes = async () => ((await api("/layout")).data as { panes: Pane[] }).panes;
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
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
  await repo.write(".github/metator/workflows/mt-quick.yml", QUICK);
  await repo.write(".github/metator/workflows/demo.yml", DEMO);
  await repo.write("src/price.ts", "export const price = (n: number) => n;\n");
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
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
  stopProcessesUnder(repo.root);
  await repo.dispose();
  await rm(bin, { recursive: true, force: true });
});

describe("the conversation agent in the chat pane (real daemon, scenario host)", () => {
  test("the daemon names mt-chat for the chat once the repository holds its host file", async () => {
    expect((await api("/supervisor")).data.chatAgent).toBeUndefined();
    await repo.write(
      ".claude/agents/mt-chat.md",
      await Bun.file(join(ROOT, ".claude/agents/mt-chat.md")).text(),
    );
    expect((await api("/supervisor")).data.chatAgent).toBe("mt-chat");
  });

  test("its pane is told who it is; a direct edit is recorded as scratch; quick and full runs get their own conductor terminals", async () => {
    const opened = await api("/panes", {
      method: "POST",
      body: JSON.stringify({ label: "chat", newTab: true, role: "apps", agent: "mt-chat", host: "scenario" }),
    });
    expect(opened.ok).toBe(true);
    const chatId = (opened.data as { id: string }).id;
    const chat = (await panes()).find((p) => p.id === chatId) as Pane;
    expect([chat.role, chat.label, chat.process.agent]).toEqual(["apps", "chat", "mt-chat"]);
    expect(chat.process.prompt).toStartWith("You are MetatorAI's chat: a person is talking to you");
    // The chat worked through its script: both runs exist, each with a conductor pane of its own.
    const all = await until("both conductors", async () => {
      const now = await panes();
      return now.filter((p) => p.role === "conductor").length === 2 ? now : undefined;
    });
    const runs = (await mt("run", "list")).json.data as { runId: string; workflow: string; status: string }[];
    expect(runs.map((r) => [r.workflow, r.status]).sort()).toEqual([
      ["demo", "active"],
      ["mt-quick", "active"],
    ]);
    const conductors = all.filter((p) => p.role === "conductor").map((p) => p.runId);
    expect(conductors.sort()).toEqual(runs.map((r) => r.runId).sort());
    // The chat stays the main terminal of what it started last; no run is driven in the background.
    const full = runs.find((r) => r.workflow === "demo")?.runId;
    const quick = runs.find((r) => r.workflow === "mt-quick")?.runId as string;
    await until("the chat to remember its run", async () =>
      (await panes()).find((p) => p.id === chatId)?.startedRun === full ? true : undefined,
    );
    const ps = new TextDecoder().decode(Bun.spawnSync(["ps", "-eo", "args"]).stdout);
    expect(ps.split("\n").filter((l) => l.includes("run drive") && l.includes(repo.root))).toEqual([]);
    // The direct edit is a scratch record; the quick run started in this checkout with it (--here).
    const scratch = (await api("/scratch")).data as {
      items: { id: string; files: string[]; note?: string }[];
    };
    expect(scratch.items).toMatchObject([{ id: "s001", files: ["src/price.ts"], note: "trace price calls" }]);
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(1);
    const log = await repo.read(`.metator/runs/${quick}/log.md`);
    expect(log).toContain("created · workflow mt-quick");
    // Nothing was committed by anyone.
    expect((await repo.git("log", "--oneline")).trim().split("\n")).toHaveLength(1);
  }, 120_000);
});
