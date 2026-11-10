/**
 * Interactive hosts end to end (D6, ADR-0077): the real daemon opens a session for a run on the
 * Copilot, Claude Code and OpenCode adapters, each a real process in a real PTY (stand-in
 * scripts where the CLIs are not installed), the default host follows `supervisor.hostOrder`,
 * and a session opened again on the same host is resumed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const STAND_IN = `#!/bin/sh\nprintf 'args: %s\\n' "$*"\nread -r line\nprintf 'typed: %s\\n' "$line"\nexit 0\n`;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let runId = "";
type Data = Record<string, unknown>;
const get = async (path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<{ ok: boolean; data: Data; error?: Data }>;
const post = async (path: string, body: unknown) =>
  (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<{
    ok: boolean;
    data: Data;
    error?: Data;
  }>;
const backlog = async () => ((await get(`/runs/${runId}/pty`)).data as { backlog: string }).backlog;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const said = (text: string) => until(text, async () => ((await backlog()).includes(text) ? true : undefined));
/** Closes the run's session and waits until the broker saw the process end. */
async function closed(): Promise<void> {
  expect((await post(`/runs/${runId}/pty-close`, {})).ok).toBe(true);
  await until("the session to end", async () => {
    const view = (await get(`/runs/${runId}/pty`)).data as { session?: { alive: boolean } };
    return view.session?.alive ? undefined : true;
  });
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  for (const bin of ["copilot", "claude", "opencode"]) {
    await repo.write(`bin/${bin}`, STAND_IN);
    chmodSync(repo.path(`bin/${bin}`), 0o755);
  }
  await repo.commit("init");
  const run = await metator(["run", "init", "--workflow", "demo", "--task", "Add the discount"], repo.root);
  runId = (run.json.data as { runId: string }).runId;
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100"], {
    cwd: repo.root,
    env: {
      ...process.env,
      METATOR_STATE_DIR: E2E_STATE_DIR,
      METATOR_COPILOT_BIN: repo.path("bin/copilot"),
      METATOR_CLAUDE_BIN: repo.path("bin/claude"),
      METATOR_OPENCODE_BIN: repo.path("bin/opencode"),
    },
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
  await repo.dispose();
});

describe("interactive hosts through the daemon (real processes)", () => {
  test("the default host is the first of hostOrder: Copilot starts with the task and resumes with --continue", async () => {
    const opened = await post(`/runs/${runId}/pty-open`, {});
    expect(opened.ok).toBe(true);
    expect((opened.data as { host: string }).host).toBe("copilot");
    await said("args: -i Add the discount --add-dir");
    expect(await backlog()).toContain("--deny-tool shell(git push)");
    await closed();
    const again = await post(`/runs/${runId}/pty-open`, {});
    expect((again.data as { host: string }).host).toBe("copilot");
    await said("args: --continue --add-dir");
    await closed();
  }, 60_000);

  test("Claude Code gets the task and a session id; OpenCode the worktree and the prompt", async () => {
    const claude = await post(`/runs/${runId}/pty-open`, { host: "claude" });
    expect((claude.data as { host: string }).host).toBe("claude");
    await said("args: Add the discount --session-id");
    expect(await backlog()).toContain("--permission-mode default");
    await closed();
    const opencode = await post(`/runs/${runId}/pty-open`, { host: "opencode" });
    expect((opencode.data as { host: string }).host).toBe("opencode");
    await said(`args: ${repo.root} --prompt Add the discount`);
    await closed();
    const activity = (await get(`/runs/${runId}/activity`)).data as {
      entries: { origin?: string; text: string }[];
    };
    const starts = activity.entries.filter(
      (e) => e.origin === "pty" && /^(started|resumed) session/.test(e.text),
    );
    expect(starts.map((e) => e.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "started session continue",
      "resumed session continue",
      expect.stringMatching(/^started session [0-9a-f-]{36}$/),
      "started session continue",
    ]);
  }, 60_000);

  test("an unknown host is refused with the known ones", async () => {
    const r = await post(`/runs/${runId}/pty-open`, { host: "nope" });
    expect(r.ok).toBe(false);
    expect(String(r.error?.message)).toContain("unknown interactive host nope");
    expect(String(r.error?.hint)).toContain("copilot, claude, opencode");
  });
});
