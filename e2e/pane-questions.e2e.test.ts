/**
 * Questions an agent asks in its terminal, answered from either side (real daemon, real PTYs,
 * scenario host): each question gets its own card; a card's answer is typed into the pane at
 * once (long before the daemon's next check); an answer typed in the pane is recorded with the
 * person at its keyboard; a card that comes after the pane answered is told so and types
 * nothing; `metator run ask --wait` blocks a terminal agent until the person answers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { inTerminal } from "./helpers/terminal.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - ask: { question: "Which rounding?", options: [half-up, half-even] }
      - ask: { question: "Which currency?", options: [PLN, EUR] }
      - ask: { question: "Which locale?", options: [pl-PL, en-US] }
      - ask: { question: "Which tax?", options: [VAT23, VAT8] }
      - ask: { question: "Which unit?", options: [kg, g] }
      - say: "all chosen"
`;
// The daemon's own check is slow here: what arrives sooner than it is the answer route's doing.
const SUPERVISE_MS = 3000;

let repo: ScratchRepo;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let runId = "";
type Data = Record<string, unknown>;
interface Q {
  id: string;
  prompt: string;
  options: { label: string }[];
  answer?: { choices: string[]; text?: string; by: string };
}
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const get = async (path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<{ ok: boolean; data: Data }>;
const post = async (path: string, body: unknown) =>
  (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<{
    ok: boolean;
    data: Data;
    error?: { code: string; message: string };
  }>;
const questions = async () =>
  (data(await mt("run", "questions", "--all", "--run", runId)).questions ?? []) as Q[];
const screen = async () => (await get("/panes/w1:p1")).data.text as string;
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
const cardFor = (prompt: string) =>
  until(`the card "${prompt}"`, async () => {
    const inbox = (await get("/inbox")).data as { decisions: { runId: string; question: Q }[] };
    return inbox.decisions.find((d) => d.runId === runId && d.question.prompt === prompt)?.question;
  });

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_HOST: "scenario" };
  runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Price the cart")).runId as string;
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", String(SUPERVISE_MS)],
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
  expect((await mt("run", "start", "--run", runId)).code).toBe(0);
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await repo.dispose();
});

describe("questions an agent asks in its terminal (real daemon, real PTYs)", () => {
  test("a card's answer is typed into the pane at once; the next question gets its own card", async () => {
    const q1 = await cardFor("Which rounding?");
    expect(q1.options.map((o) => o.label)).toEqual([
      "half-up",
      "half-even",
      "Attach and answer in the pane",
      "Other",
    ]);
    const sent = Date.now();
    expect(
      (await post(`/runs/${runId}/answer`, { question: q1.id, choices: ["half-even"], by: "ana" })).ok,
    ).toBe(true);
    await until("the pane to get the answer", async () =>
      (await screen()).includes("answer: half-even") ? true : undefined,
    );
    // Typed by the answer itself, well before the daemon's next check.
    expect(Date.now() - sent).toBeLessThan(SUPERVISE_MS);
    const q2 = await cardFor("Which currency?");
    expect(q2.id).not.toBe(q1.id);
  }, 60_000);

  test("an answer typed in the pane is recorded with the person at its keyboard, and the card goes", async () => {
    const q2 = await cardFor("Which currency?");
    expect((await post(`/runs/${runId}/attach`, { by: "bob" })).ok).toBe(true);
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/pane/w1:p1?by=bob`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    const typedAt = Date.now();
    ws.send(JSON.stringify({ type: "input", data: "EUR\r" }));
    const answered = await until("the pane's answer recorded", async () => {
      const q = (await questions()).find((x) => x.id === q2.id);
      return q?.answer;
    });
    expect([answered.choices, answered.by]).toEqual([["EUR"], "bob"]);
    // Recorded as soon as the pane echoed it, not on the daemon's next check.
    expect(Date.now() - typedAt).toBeLessThan(SUPERVISE_MS);
    const activity = data(await mt("run", "activity", "--run", runId)) as { entries: { text: string }[] };
    expect(activity.entries.some((e) => e.text.startsWith(`${q2.id}: EUR · bob`))).toBe(true);
    // While bob holds the keyboard, a card's answer to the next question is refused, never typed over him.
    const q3 = await cardFor("Which locale?");
    const refused = await post(`/runs/${runId}/answer`, { question: q3.id, choices: ["pl-PL"], by: "ana" });
    expect([refused.ok, refused.error?.code]).toEqual([false, "CONFLICT"]);
    expect(refused.error?.message).toBe(
      "bob is answering in pane w1:p1: answer there, or wait until they release it",
    );
    // bob answers there; a card that comes after is told the question is answered, and types nothing.
    ws.send(JSON.stringify({ type: "input", data: "en-US\r" }));
    await until("the pane to take en-US", async () =>
      (await screen()).includes("answer: en-US") ? true : undefined,
    );
    const late = await post(`/runs/${runId}/answer`, { question: q3.id, choices: ["pl-PL"], by: "ana" });
    expect([late.ok, late.error?.message]).toEqual([false, `question ${q3.id} is already answered`]);
    expect((await questions()).find((x) => x.id === q3.id)?.answer).toMatchObject({
      choices: ["en-US"],
      by: "bob",
    });
    expect(await screen()).not.toContain("pl-PL\r");
    expect((await post(`/runs/${runId}/release`, {})).ok).toBe(true);
    ws.close();
  }, 60_000);

  test("typed in the pane and the keyboard given back at once: the answer is still the person's", async () => {
    const q4 = await cardFor("Which tax?");
    expect((await post(`/runs/${runId}/attach`, { by: "bob" })).ok).toBe(true);
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/pane/w1:p1?by=bob`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.send(JSON.stringify({ type: "input", data: "VAT23\r" }));
    await until("the pane to take VAT23", async () =>
      (await screen()).includes("answer: VAT23") ? true : undefined,
    );
    expect((await post(`/runs/${runId}/release`, {})).ok).toBe(true);
    ws.close();
    expect((await questions()).find((x) => x.id === q4.id)?.answer).toMatchObject({
      choices: ["VAT23"],
      by: "bob",
    });
  }, 60_000);

  test("the person who holds the keyboard answers on the card: no conflict, typed as theirs", async () => {
    const q5 = await cardFor("Which unit?");
    expect((await post(`/runs/${runId}/attach`, { by: "bob" })).ok).toBe(true);
    expect((await post(`/runs/${runId}/answer`, { question: q5.id, choices: ["kg"], by: "bob" })).ok).toBe(
      true,
    );
    await until("the pane to take kg", async () =>
      (await screen()).includes("answer: kg") ? true : undefined,
    );
    expect((await post(`/runs/${runId}/release`, {})).ok).toBe(true);
  }, 60_000);

  test("`metator run ask --wait` blocks a terminal agent until the person answers, then prints it", async () => {
    const asking = Bun.spawn(
      [
        "bun",
        CLI_ENTRY,
        "run",
        "ask",
        "Which discount?",
        "--option",
        "VAT23",
        "--option",
        "VAT8",
        "--agent",
        "mt-implementer",
        "--wait",
        "--run",
        runId,
      ],
      {
        cwd: repo.root,
        env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const q = await cardFor("Which discount?");
    expect((await post(`/runs/${runId}/answer`, { question: q.id, choices: ["VAT8"], by: "ana" })).ok).toBe(
      true,
    );
    const out = JSON.parse((await new Response(asking.stdout).text()).trim()) as {
      ok: boolean;
      data: { question: { id: string; agent: string }; answer: { choices: string[]; by: string } };
    };
    expect(await asking.exited).toBe(0);
    expect([out.ok, out.data.question.agent, out.data.answer.choices, out.data.answer.by]).toEqual([
      true,
      "mt-implementer",
      ["VAT8"],
      "ana",
    ]);
  }, 60_000);

  test("`metator run ask --wait` at a terminal: the question, its options, that it waits, then the answer and who gave it", async () => {
    // A run of its own, with nothing in a pane: only the terminal and the card.
    const own = data(await mt("run", "init", "--workflow", "demo", "--task", "Ship the cart"))
      .runId as string;
    const answering = (async () => {
      const q = await until("the question", async () =>
        ((data(await mt("run", "questions", "--run", own)).questions ?? []) as Q[]).find(
          (x) => x.prompt === "Ship it behind a flag?",
        ),
      );
      await post(`/runs/${own}/answer`, { question: q.id, choices: ["no"], by: "ana" });
    })();
    const shown = await inTerminal(
      ["run", "ask", "Ship it behind a flag?", "--option", "yes", "no", "--run", own, "--wait"],
      repo.root,
      [],
      30_000,
      env,
    );
    await answering;
    expect(shown.screen).toContain("waiting for an answer…");
    expect(shown.screen).toContain("options: yes · no · Other");
    expect(shown.screen).toContain("answer: no · ana");
  }, 60_000);
});
