/**
 * Split panes end to end (S6): `metator pane split` opens a shell beside a pane under the real
 * daemon, the tab's tree lands in `.metator/layout.json`, and a daemon started again brings the
 * tree and both panes back. A shell pane of a run takes a person's keys without the driver lock.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
type Data = Record<string, unknown>;
const mt = (...args: string[]) => metator(args, repo.root);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const get = async (path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<{ ok: boolean; data: Data }>;
const post = async (path: string, body: unknown) =>
  (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<{
    ok: boolean;
    data: Data;
    error?: Data;
  }>;

async function startDaemon(): Promise<void> {
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, SHELL: "sh" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stderr.getReader();
  let text = "";
  const deadline = Date.now() + 20_000;
  base = "";
  while (!base && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    if (line) base = (JSON.parse(line) as { serving: { url: string } }).serving.url;
  }
  if (!base) throw new Error(`the daemon did not listen: ${text}`);
}

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
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.commit("init");
  await startDaemon();
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await repo.dispose();
});

describe("pane split (real daemon)", () => {
  test("split puts a shell beside the pane in the tab's tree; the tree survives a daemon restart; a run's shell takes anyone's keys", async () => {
    const runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Split me")).runId as string;
    const first = await post("/panes", { runId, role: "shell", argv: ["sh"] });
    expect(first.ok).toBe(true);
    const firstId = first.data.id as string;
    const split = data(await mt("pane", "split", firstId, "--dir", "down"));
    expect([split.tab, split.role, split.process]).toEqual([
      first.data.tab,
      "shell",
      { kind: "command", argv: ["sh"] },
    ]);
    const secondId = split.id as string;
    const layout = (await get("/layout")).data as {
      workspaces: { tabs: { panes: string[]; tree?: Data }[] }[];
    };
    const tab = layout.workspaces[0]?.tabs[0];
    expect(tab?.panes).toEqual([firstId, secondId]);
    expect(tab?.tree).toEqual({ dir: "column", ratio: 0.5, a: { pane: firstId }, b: { pane: secondId } });
    // A client's drag: the ratio changes; a tree of other panes is refused.
    const resized = await post(`/tabs/${encodeURIComponent(first.data.tab as string)}/tree`, {
      tree: { dir: "column", ratio: 0.3, a: { pane: firstId }, b: { pane: secondId } },
    });
    expect((resized.data.tree as Data).ratio).toBe(0.3);
    const wrong = await post(`/tabs/${encodeURIComponent(first.data.tab as string)}/tree`, {
      tree: { pane: firstId },
    });
    expect([wrong.ok, wrong.error?.code]).toEqual([false, "USAGE"]);
    // The run's shell pane takes a person's keys with no driver lock: the agent's panes keep theirs.
    const ws = new WebSocket(
      `${base.replace(/^http/, "ws")}/ws/pane/${encodeURIComponent(secondId)}?by=alice`,
    );
    const echoed = await new Promise<string>((resolve, reject) => {
      let seen = "";
      ws.onopen = () => ws.send(JSON.stringify({ type: "input", data: "echo split-shell-ok\r" }));
      ws.onmessage = (m) => {
        const e = JSON.parse(String(m.data)) as { type: string; data?: string; reason?: string };
        if (e.type === "refused") reject(new Error(e.reason));
        if (e.type === "data") {
          seen += e.data ?? "";
          if (
            seen.includes("split-shell-ok\r\n") ||
            /split-shell-ok\s*\n/.test(seen.replace(/echo split-shell-ok/, ""))
          )
            resolve(seen);
        }
      };
      setTimeout(() => resolve(seen), 8000);
    });
    ws.close();
    expect(echoed.split("split-shell-ok").length).toBeGreaterThanOrEqual(3);
    // Started again, the daemon restores both panes and keeps the tree and the ratio.
    daemon.kill("SIGTERM");
    await daemon.exited;
    await startDaemon();
    const restored = await until("both panes live again", async () => {
      const l = (await get("/layout")).data as {
        workspaces: { tabs: { tree?: Data }[] }[];
        panes: { id: string; live?: { alive: boolean } }[];
      };
      const live = l.panes.filter((p) => p.live?.alive).map((p) => p.id);
      return live.length === 2 ? l : undefined;
    });
    expect(restored.workspaces[0]?.tabs[0]?.tree).toEqual({
      dir: "column",
      ratio: 0.3,
      a: { pane: firstId },
      b: { pane: secondId },
    });
    // Closing a pane prunes the tree.
    expect(data(await mt("pane", "list"))).toBeDefined();
    const closed = await post(`/panes/${encodeURIComponent(secondId)}/close`, {});
    expect(closed.ok).toBe(true);
    const after = (await get("/layout")).data as {
      workspaces: { tabs: { panes: string[]; tree?: Data }[] }[];
    };
    expect(after.workspaces[0]?.tabs[0]).toMatchObject({ panes: [firstId], tree: { pane: firstId } });
  }, 90_000);
});
