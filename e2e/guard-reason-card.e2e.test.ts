/**
 * Why the guard asked reaches the card (real daemon, real PTY, real hook; never a real AI host):
 * Claude Code does not print a hook's `ask` reason in its approval, so the pane's own pre-tool
 * hook keeps it (`.metator/guard-asked/<pane>.json`, a hash of the command) and the daemon puts it
 * on the card that approval becomes. A stand-in `claude` runs the hook in its pane, as Claude Code
 * does, then draws the approval of a commit whose message runs over several lines behind its `│`
 * gutter: the card's command holds no frame character.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_APPROVAL_COMMIT_SCREEN, CLAUDE_COMMIT_COMMAND } from "@metator/testing";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
type Data = Record<string, unknown>;
interface PaneItem {
  paneId: string;
  question: { id: string; source: string; prompt: string; command?: string; reason?: string };
}
const COMMIT = CLAUDE_COMMIT_COMMAND.replace("src/server.ts", "src/price.ts");

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}
const get = async (path: string) => ((await (await fetch(`${base}${path}`)).json()) as { data: Data }).data;

beforeAll(async () => {
  const bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  chmodSync(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nstandin/\n");
  await repo.write("src/price.ts", "export const price = (n: number) => n;\n");
  await repo.commit("init");
  const env = { METATOR_USER: "ana", PATH: `${bin}:${process.env.PATH ?? ""}` };
  // A debug line, recorded as scratch: a commit that holds it is what the guard asks about.
  expect((await metator(["scratch", "begin"], repo.root, env)).code).toBe(0);
  await repo.write(
    "src/price.ts",
    'export const price = (n: number) => { console.log("[debug]", n); return n; };\n',
  );
  expect((await metator(["scratch", "end", "--note", "log the price"], repo.root, env)).code).toBe(0);
  await repo.write(
    "standin/payload.json",
    JSON.stringify({ tool_name: "Bash", tool_input: { command: COMMIT }, session_id: "s1" }),
  );
  await repo.write(
    "standin/approval.txt",
    `${CLAUDE_APPROVAL_COMMIT_SCREEN.replaceAll("src/server.ts", "src/price.ts")}\n`,
  );
  // Claude Code runs its pre-tool hook in the pane (its env names the pane), then draws its own approval.
  await repo.write(
    "standin/claude",
    `#!/bin/sh\nmetator guard pre-tool < "${repo.path("standin/payload.json")}" > /dev/null\ncat "${repo.path("standin/approval.txt")}"\nread -r key\nprintf 'picked %s\\n' "$key"\nsleep 60\n`,
  );
  chmodSync(repo.path("standin/claude"), 0o755);
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "300"],
    {
      cwd: repo.root,
      env: {
        ...process.env,
        METATOR_STATE_DIR: E2E_STATE_DIR,
        ...env,
        METATOR_HOST: "scenario",
        // Not a real host: a script that does what Claude Code does at a guarded commit.
        METATOR_CLAUDE_BIN: repo.path("standin/claude"),
        METATOR_COPILOT_BIN: "/nonexistent/copilot",
        METATOR_OPENCODE_BIN: "/nonexistent/opencode",
      },
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

describe("the guard's reason on the card of a host's approval (real daemon, real hook, stand-in host)", () => {
  test("a commit that holds debug changes: the card names the command without its frame, and says why the guard asks", async () => {
    const opened = (await (
      await fetch(`${base}/panes`, {
        method: "POST",
        body: JSON.stringify({ label: "chat", role: "apps", host: "claude", agent: "mt-chat" }),
      })
    ).json()) as { ok: boolean; data: { id: string }; error?: unknown };
    expect(opened.ok).toBe(true);
    const paneId = opened.data.id;
    const item = await until("the approval's card", async () =>
      (((await get("/inbox")).panes ?? []) as PaneItem[]).find((i) => i.paneId === paneId),
    ).catch(async (e) => {
      throw new Error(
        `${(e as Error).message}: ${JSON.stringify(await get(`/panes/${paneId}`)).slice(0, 1500)}`,
      );
    });
    expect(item.question.source).toBe("permission");
    expect(item.question.command).toBe(COMMIT);
    expect(item.question.prompt).not.toContain("│");
    expect(item.question.reason).toBe(
      "this commit holds debug changes: src/price.ts. Remove them first (`metator scratch drop`), or answer here to commit anyway.",
    );
    // `metator inbox` at a terminal of the person's own has it too: the daemon owns the pane's questions.
    const inbox = await metator(["inbox"], repo.root, { METATOR_USER: "ana" });
    expect(inbox.code).toBe(0);
    const listed = (inbox.json.data as { panes: PaneItem[] }).panes.find((i) => i.paneId === paneId);
    expect([listed?.question.id, listed?.question.command, listed?.question.reason]).toEqual([
      item.question.id,
      COMMIT,
      item.question.reason,
    ]);
    // The hook kept it as a hash of the command, with its reason, where the daemon works.
    const kept = JSON.parse(await repo.read(`.metator/guard-asked/${paneId.replace(":", "-")}.json`)) as {
      kind: string;
      asked: { hash: string; decision: string }[];
    };
    expect([kept.kind, kept.asked.map((a) => a.decision)]).toEqual(["GuardAsked", ["ask"]]);
    expect(JSON.stringify(kept)).not.toContain("git commit");
    await fetch(`${base}/panes/${paneId}/close`, { method: "POST", body: "{}" });
  }, 60_000);
});
