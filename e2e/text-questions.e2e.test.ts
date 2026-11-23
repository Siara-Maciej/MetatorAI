/**
 * An agent that asks the person in words and waits (ADR-0091; real daemon, real PTYs, scenario
 * host only): the run's conductor ends its turn with numbered options, as Claude Code did in a real
 * run, and waits at its prompt. The question is in `/inbox` `panes` with its run, the whole
 * message and the options; the run needs the person; the supervisor (idle after 1 s here) never
 * nudges it while the question is open; "1" from the app is typed into the pane, which reads it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const CONFIG = "kind: MetatorConfig\nschemaVersion: 12\nsupervisor:\n  idleThresholdMs: 1000\n";
// What a real conductor wrote, then its prompt: the scenario host says it, then reads a line.
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-orchestrator:
    - - say: "● The tests fail: the build has no currency field."
      - say: ""
      - say: "  Options:"
      - say: "  1. Add the field and run the tests again."
      - say: "  2. Stop the run."
      - run: 'read -r line; printf "answer: %s\\n" "$line"'
      - run: 'sleep 120'
  mt-chat:
    - - say: "● Which rounding should the EUR price use?"
      - say: ""
      - say: "  1. Half-up to the nearest cent."
      - say: "  2. Banker's rounding to the nearest cent."
      # While it waits, the host writes to its terminal once more (Claude Code sets its title,
      # redraws its status line): output that changes nothing on the screen.
      - run: '(sleep 4; printf "\\033]0;mt-chat\\007") & read -r line; printf "heard: %s\\n" "$line"'
      - run: 'sleep 120'
`;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let runId = "";
type Data = Record<string, unknown>;
interface PaneItem {
  kind: string;
  paneId: string;
  runId?: string;
  label: string;
  question: { id: string; source: string; prompt: string; text?: string; options: { label: string }[] };
}
const get = async (path: string) => ((await (await fetch(`${base}${path}`)).json()) as { data: Data }).data;
const items = async () => ((await get("/inbox")).panes ?? []) as PaneItem[];
const text = async (paneId: string) => (await get(`/panes/${paneId}`)).text as string;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("metator.config.yml", CONFIG);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  const env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_HOST: "scenario" };
  runId = (
    (await metator(["run", "init", "--workflow", "demo", "--task", "Add the currency"], repo.root, env)).json
      .data as Data
  ).runId as string;
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "300"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = daemon.stderr.getReader();
  let seen = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    seen += new TextDecoder().decode(value);
    const line = seen.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  void (async () => {
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await repo.dispose();
});

describe("an agent's question in words reaches the person (real daemon, scenario host)", () => {
  test("the conductor's numbered options: an inbox item with its run; no nudge while it is open; 1 from the app is typed", async () => {
    await fetch(`${base}/runs/${runId}/pty-open`, { method: "POST", body: "{}" });
    const item = await until("the conductor's question in the inbox", async () =>
      (await items()).find((i) => i.paneId === "w1:p1"),
    );
    expect([item.kind, item.runId, item.question.source, item.question.prompt]).toEqual([
      "pane",
      runId,
      "agent",
      // The agent's first sentence alone: it has no question sentence, and none is made up.
      "The tests fail: the build has no currency field.",
    ]);
    expect(item.question.text).toBe(
      "The tests fail: the build has no currency field.\n\nOptions:\n1. Add the field and run the tests again.\n2. Stop the run.",
    );
    expect(item.question.options.map((o) => o.label)).toEqual([
      "1. Add the field and run the tests again.",
      "2. Stop the run.",
      "Other",
      "Leave it",
    ]);
    // The run needs the person, as with a card.
    const state = (await get("/state")) as { runs: { runId: string; attention: string }[] };
    expect(state.runs.find((r) => r.runId === runId)?.attention).toBe("you");
    // Idle for well over the supervisor's 1 s: no nudge while the question is open.
    await Bun.sleep(4000);
    const activity = (await get(`/runs/${runId}/activity`)) as { entries: { text: string }[] };
    expect(activity.entries.filter((e) => e.text.startsWith("nudged"))).toEqual([]);
    const answered = (await (
      await fetch(`${base}/panes/w1:p1/answer`, {
        method: "POST",
        body: JSON.stringify({
          question: item.question.id,
          choices: [item.question.options[0]?.label],
          by: "ana",
        }),
      })
    ).json()) as { ok: boolean };
    expect(answered.ok).toBe(true);
    await until("the pane to read 1", async () =>
      (await text("w1:p1")).includes("answer: 1") ? true : undefined,
    );
    expect((await items()).some((i) => i.paneId === "w1:p1")).toBe(false);
    // The daemon keeps what it typed for the person (a hash, never the words): the host's
    // user-prompt hook, which gets that line like any prompt, reads it as the person's answer to a
    // card, not as the person talking to the session directly.
    const typed = JSON.parse(await repo.read(".metator/typed/w1-p1.json")) as {
      kind: string;
      lines: { hash: string; by: string }[];
    };
    expect([typed.kind, typed.lines.map((l) => l.by)]).toEqual(["PaneTyped", ["answer"]]);
    const asHost = await hook(["guard", "user-prompt"], { prompt: "1" }, repo.root, {
      METATOR_PANE_ID: "w1:p1",
      METATOR_RUN: runId,
    });
    expect(asHost.json).toBeNull();
    await metator(["run", "close", "--run", runId, "--aborted", "--reason", "the test ends it"], repo.root);
  }, 60_000);

  test("the chat asks in words; the host writes to its terminal while it waits: the card stays, and its words reach the chat", async () => {
    const opened = (await (
      await fetch(`${base}/panes`, {
        method: "POST",
        body: JSON.stringify({ label: "chat", role: "apps", host: "scenario", agent: "mt-chat" }),
      })
    ).json()) as { ok: boolean; data: { id: string } };
    expect(opened.ok).toBe(true);
    const paneId = opened.data.id;
    const item = await until("the chat's question in the inbox", async () =>
      (await items()).find((i) => i.paneId === paneId),
    );
    expect([item.question.source, item.question.prompt]).toEqual([
      "agent",
      "Which rounding should the EUR price use?",
    ]);
    // Past the host's late output (4 s after it started waiting): still asked.
    await Bun.sleep(4500);
    expect((await items()).find((i) => i.paneId === paneId)?.question.id).toBe(item.question.id);
    const answered = (await (
      await fetch(`${base}/panes/${paneId}/answer`, {
        method: "POST",
        body: JSON.stringify({ question: item.question.id, choices: [], text: "neither for now", by: "ana" }),
      })
    ).json()) as { ok: boolean; error?: { message: string } };
    expect([answered.ok, answered.error?.message]).toEqual([true, undefined]);
    await until("the chat to read the words", async () =>
      (await text(paneId)).includes("heard: neither for now") ? true : undefined,
    );
    await fetch(`${base}/panes/${paneId}/close`, { method: "POST", body: "{}" });
  }, 60_000);
});
