/**
 * A pane without a run asks the person (ADR-0091, real daemon, real PTYs, no real AI host): the
 * intake chat's agent asks in words, or its host asks leave to run a command. Either one is an
 * item of `/inbox` (`panes`), answered from the app with `POST /panes/:pane/answer`, and the pane
 * reads the answer: the words, or the menu's number. A stand-in `claude` program draws Claude
 * Code's approval screen; the scenario host plays the agent's question.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { CLAUDE_APPROVAL_OPTIONS, CLAUDE_APPROVAL_RAW, CLAUDE_APPROVAL_TEXT } from "@metator/testing";
import { CLI_ENTRY, E2E_STATE_DIR } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  session:
    - - say: "the intake chat"
      - ask: { question: "Which workflow?", options: [mt-feature, mt-bugfix] }
      - say: "STATUS: done"
`;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
type Data = Record<string, unknown>;
interface PaneItem {
  kind: string;
  paneId: string;
  label: string;
  role?: string;
  host: string;
  question: { id: string; source: string; prompt: string; options: { label: string }[]; answer?: unknown };
}
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { http: r.status, ...((await r.json()) as { ok: boolean; data: Data; error?: Data }) };
};
const paneItems = async () => ((await call("GET", "/inbox")).data.panes ?? []) as PaneItem[];
const screen = async (paneId: string) => (await call("GET", `/panes/${paneId}`)).data.text as string;

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
  await repo.write(".gitignore", ".metator/\nbin/\n");
  await repo.write("scenario.yml", SCENARIO);
  // Claude Code as far as this test needs it: its approval screen, then the key it is given.
  await repo.write("bin/approval.txt", CLAUDE_APPROVAL_RAW);
  await repo.write(
    "bin/claude",
    `#!/bin/sh\ncat "${repo.path("bin/approval.txt")}"\nread -r key\nprintf 'picked %s\\n' "$key"\nsleep 30\n`,
  );
  chmodSync(repo.path("bin/claude"), 0o755);
  await repo.commit("init");
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "500"],
    {
      cwd: repo.root,
      env: {
        ...process.env,
        METATOR_STATE_DIR: E2E_STATE_DIR,
        METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
        METATOR_CLAUDE_BIN: repo.path("bin/claude"),
      },
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
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await repo.dispose();
});

describe("a pane without a run asks the person through the inbox (real daemon)", () => {
  test("the chat's agent asks in words: an inbox item of the pane; the answer from the app is typed and the pane reads it", async () => {
    const chat = await call("POST", "/panes", {
      label: "chat",
      role: "apps",
      host: "scenario",
      agent: "mt-orchestrator",
    });
    const paneId = (chat.data as { id: string }).id;
    const item = await until("the pane's question in the inbox", async () =>
      (await paneItems()).find((i) => i.paneId === paneId),
    );
    expect([item.kind, item.label, item.role, item.host, item.question.source, item.question.prompt]).toEqual(
      ["pane", "chat", "apps", "scenario", "agent", "Which workflow?"],
    );
    expect(item.question.options.map((o) => o.label)).toEqual([
      "mt-feature",
      "mt-bugfix",
      "Attach and answer in the pane",
      "Other",
    ]);
    // A pane's agent cannot answer for the person.
    const own = await call(
      "POST",
      `/panes/${paneId}/answer`,
      { question: item.question.id, choices: ["mt-bugfix"], by: "agent" },
      { "x-metator-pane": "a-pane-token" },
    );
    expect(own.http).toBe(403);
    const answered = await call("POST", `/panes/${paneId}/answer`, {
      question: item.question.id,
      choices: ["mt-bugfix"],
      by: "ana",
    });
    expect([answered.ok, (answered.data.answer as { by: string }).by]).toEqual([true, "ana"]);
    await until("the pane to read the answer", async () =>
      (await screen(paneId)).includes("answer: mt-bugfix") ? true : undefined,
    );
    expect((await paneItems()).some((i) => i.paneId === paneId)).toBe(false);
    expect((await call("POST", `/panes/${paneId}/close`, {})).ok).toBe(true);
  }, 60_000);

  test("Claude Code asks leave to run a command: the item reads the prompt and its choices; Yes from the app picks 1 in the pane", async () => {
    const chat = await call("POST", "/panes", {
      label: "chat",
      role: "apps",
      host: "claude",
      agent: "mt-orchestrator",
    });
    const paneId = (chat.data as { id: string }).id;
    const item = await until("the host's prompt in the inbox", async () =>
      (await paneItems()).find((i) => i.paneId === paneId),
    );
    expect([item.question.source, item.question.prompt]).toEqual(["permission", CLAUDE_APPROVAL_TEXT]);
    expect(item.question.options.map((o) => o.label)).toEqual([
      ...CLAUDE_APPROVAL_OPTIONS,
      "Attach and answer in the pane",
      "Leave it",
    ]);
    // The pane's state says the prompt in words, not the bytes it was drawn with.
    const pane = (await call("GET", "/layout")).data.panes as {
      id: string;
      state?: { state: string; reason: string };
    }[];
    const state = pane.find((p) => p.id === paneId)?.state;
    expect([state?.state, state?.reason]).toEqual(["blocked", CLAUDE_APPROVAL_TEXT]);
    expect((await screen(paneId)).includes("\r")).toBe(false);
    const answered = await call("POST", `/panes/${paneId}/answer`, {
      question: item.question.id,
      choices: ["Yes"],
      by: "ana",
    });
    expect(answered.ok).toBe(true);
    await until("the pane to pick 1", async () =>
      (await screen(paneId)).includes("picked 1") ? true : undefined,
    );
    await until("the item to leave the inbox", async () =>
      (await paneItems()).some((i) => i.paneId === paneId) ? undefined : true,
    );
    expect((await call("POST", `/panes/${paneId}/close`, {})).ok).toBe(true);
  }, 60_000);
});
