/**
 * Steering a task's sessions from its main chat (ADR-0093), with a real daemon and real PTYs on
 * the scenario host only: `metator session list` shows the task's sessions; the chat relays the
 * person's words to a worker (`session tell`: typed when the worker is idle, with the fixed
 * prefix, recorded in the run's activity); a worker may not steer; a person tells and interrupts
 * from their own terminal; and when the person talks to a session directly (the host's
 * user-prompt hook), the task's main chat hears of it in one line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const DEMO =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
// Each session waits at its prompt as a host does (idle, nothing asked) and shows what it is told.
const hears = (who: string) => `      - run: 'read -r line; printf "${who} heard: %s\\n" "$line"'`;
// The worker's host does what a real one does with every line submitted at its prompt, whoever
// typed it: it hands the line to its user-prompt hook.
const hearsAsHost = (who: string) =>
  `      - run: 'read -r line; printf "${who} heard: %s\\n" "$line"; printf "{\\"prompt\\":\\"%s\\"}" "$line" | metator guard user-prompt'`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-chat:
    - - say: "chat ready"
      - run: 'metator run new --workflow demo --task "Round the prices" >/dev/null'
      - run: 'metator run start >/dev/null'
      - run: 'until metator session list | grep -q mt-implementer-1; do sleep 0.2; done'
      - run: 'metator session tell w2:p3 --text "Use half-even rounding"'
${hears("chat")}
      - run: 'sleep 300'
  mt-orchestrator:
    - - say: "conducting"
      - run: 'metator run delegate build --run "$METATOR_RUN" --agent mt-implementer --card "Round the prices"'
${hears("conductor")}
      - run: 'sleep 300'
  mt-implementer:
    - - say: "rounding"
${hearsAsHost("worker")}
      - run: 'metator session tell w2:p2 --text "I am only a worker" || true'
${hearsAsHost("worker")}
      - run: 'printf "{\\"prompt\\":\\"Use banker rounding instead\\"}" | metator guard user-prompt'
      - run: 'sleep 300'
`;

let repo: ScratchRepo;
let bin: string;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let runId = "";
type Data = Record<string, unknown>;
interface Session {
  pane: string;
  repo: string;
  role: string;
  agent: string;
  state: string;
  runId?: string;
  worker?: string;
  main?: boolean;
}
const mt = (...args: string[]) => metator(args, repo.root, env);
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as { ok: boolean; data: Data; error?: Data };
const screen = async (pane: string) => ((await api(`/panes/${pane}`)).data as { text: string }).text;
const activity = async () =>
  (await repo.read(`.metator/runs/${runId}/activity.jsonl`))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { text: string }).text);
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const shows = (pane: string, words: string) =>
  until(`pane ${pane} to show "${words}"`, async () =>
    (await screen(pane)).includes(words) ? true : undefined,
  );

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
  await repo.write(".github/metator/workflows/demo.yml", DEMO);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
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

describe("steering a task's sessions from its main chat (real daemon, scenario host)", () => {
  test("session list: the task's main chat, its conductor and its worker, with repository, role and state", async () => {
    const opened = await api("/panes", {
      method: "POST",
      body: JSON.stringify({ label: "chat", newTab: true, role: "apps", agent: "mt-chat", host: "scenario" }),
    });
    expect((opened.data as { id: string }).id).toBe("w1:p1");
    const sessions = await until("the worker's session", async () => {
      const all = ((await api("/sessions")).data as { sessions: Session[] }).sessions;
      return all.some((s) => s.worker === "mt-implementer-1") ? all : undefined;
    });
    runId = sessions.find((s) => s.role === "conductor")?.runId as string;
    const name = basename(repo.root);
    const listed = ((await mt("session", "list", "--task", runId)).json.data as { sessions: Session[] })
      .sessions;
    expect(listed.map((s) => [s.pane, s.repo, s.role, s.agent, s.runId, s.main, s.worker])).toEqual([
      ["w1:p1", name, "apps", "mt-chat", undefined, true, undefined],
      ["w2:p2", name, "conductor", "mt-orchestrator", runId, undefined, undefined],
      ["w2:p3", name, "worker", "mt-implementer", runId, undefined, "mt-implementer-1"],
    ]);
    for (const s of listed) expect(["working", "idle", "waiting"]).toContain(s.state);
  }, 120_000);

  test("the chat's tell reaches the worker when it is idle, word for word behind the prefix; a worker may not steer", async () => {
    await shows(
      "w2:p3",
      "worker heard: [metator] From the person, through the main chat: Use half-even rounding",
    );
    expect(await activity()).toContain(
      `relayed to ${basename(repo.root)}/mt-implementer (pane w2:p3): [metator] From the person, through the main chat: Use half-even rounding`,
    );
    // The worker then tried to tell the conductor something itself: refused, and nothing was typed there.
    await shows("w2:p3", "is not the main chat of the task of pane w2:p2");
    expect(await screen("w2:p2")).not.toContain("I am only a worker");
  }, 120_000);

  test("a person tells and interrupts from their own terminal, under their name", async () => {
    const told = await mt("session", "tell", "w2:p3", "--text", "Keep two decimals", "--by", "ana");
    expect([told.code, told.json.data]).toMatchObject([0, { pane: "w2:p3", queued: true }]);
    await shows("w2:p3", "worker heard: [metator] From the person (ana): Keep two decimals");
    const cut = await mt("session", "interrupt", "w2:p2", "--text", "Stop: wrong file", "--by", "ana");
    expect([cut.code, cut.json.data]).toEqual([0, { pane: "w2:p2", interrupted: true }]);
    // Esc first (it is in what the session read), then the words, then Enter.
    await shows("w2:p2", "[metator] From the person (ana): Stop: wrong file");
    expect(await activity()).toContain(
      `interrupted ${basename(repo.root)}/mt-orchestrator (pane w2:p2): [metator] From the person (ana): Stop: wrong file`,
    );
    // A shell, an unknown pane and no words are usage errors, not steering.
    const unknown = await mt("session", "tell", "w9:p9", "--text", "x", "--by", "ana");
    expect([unknown.code, (unknown.json.error as { message: string }).message]).toEqual([
      1,
      "pane w9:p9 not found",
    ]);
  }, 120_000);

  test("the person talked to the worker directly (its host's user-prompt hook): the main chat hears of it in one line", async () => {
    const line = `[metator] The person told ${basename(repo.root)}/mt-implementer directly: "Use banker rounding instead"`;
    await shows("w1:p1", `chat heard: ${line}`);
    expect(await activity()).toContain(`told the chat (pane w1:p1): ${line}`);
    // The worker's host reported every line typed into it to its hook, the relays the daemon typed
    // too: none of those was taken for the person talking to the worker directly.
    expect((await activity()).filter((t) => t.startsWith("told the chat"))).toHaveLength(1);
  }, 120_000);
});
