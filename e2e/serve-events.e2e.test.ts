/**
 * The daemon's event channel end to end (ADR-0110): the real `metator serve` on a scratch
 * repository. `/ws/events` says hello, then which topics changed: after a request it answered,
 * and after another `metator` process changed the runs on disk (the daemon's one sweep). The
 * state socket still sends the overview itself, read from the same sweep.
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
type Message = { type: string; epoch: string; seq: number; topics?: string[] };
const mt = (...args: string[]) => metator(args, repo.root);

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** A socket and every message it got, parsed. */
function listen(path: string): { ws: WebSocket; got: unknown[] } {
  const got: unknown[] = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}${path}`);
  ws.onmessage = (m) => got.push(JSON.parse(String(m.data)));
  return { ws, got };
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.commit("init");
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR },
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

describe("/ws/events (real daemon)", () => {
  test("hello, then a request's topics, then a change another process made", async () => {
    const events = listen("/ws/events");
    const messages = () => events.got as Message[];
    const hello = await until("hello", () => messages()[0]);
    expect(hello.type).toBe("hello");
    expect(typeof hello.epoch).toBe("string");
    expect(hello.epoch.length).toBeGreaterThan(0);
    expect(typeof hello.seq).toBe("number");
    const changed = (topic: string, after: number) =>
      until(`a change of ${topic}`, () =>
        messages()
          .slice(after)
          .find((m) => m.type === "changed" && m.topics?.includes(topic)),
      );

    // A request the daemon answers: a Backlog item is the `backlog` topic (no sweep reads it).
    let mark = messages().length;
    const added = (await (
      await fetch(`${base}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "Flaky test", by: "maciej" }),
      })
    ).json()) as { ok: boolean };
    expect(added.ok).toBe(true);
    const backlog = await changed("backlog", mark);
    expect(backlog.epoch).toBe(hello.epoch);
    expect(backlog.topics).toEqual([...new Set(backlog.topics)].sort());

    // Another process makes a run on disk; the daemon's sweep sees the state change.
    mark = messages().length;
    const run = (await mt("run", "init", "--workflow", "demo", "--task", "Add the discount")).json
      .data as Data;
    expect(typeof run.runId).toBe("string");
    const state = await changed("state", mark);
    expect(state.epoch).toBe(hello.epoch);

    // And closes it.
    mark = messages().length;
    const closed = await mt(
      "run",
      "close",
      "--run",
      run.runId as string,
      "--aborted",
      "--reason",
      "not needed",
    );
    expect(closed.code).toBe(0);
    await changed("state", mark);

    // Every `changed` is one more than the last: nothing went out that this socket did not get.
    const seqs = messages()
      .slice(1)
      .map((m) => m.seq);
    expect(seqs).toEqual(seqs.map((_, i) => hello.seq + i + 1));
    events.ws.close();

    // A socket that connects later starts from the last seq sent, in the same epoch.
    const again = listen("/ws/events");
    const second = await until("the second hello", () => (again.got as Message[])[0]);
    expect(second).toEqual({ type: "hello", epoch: hello.epoch, seq: seqs.at(-1) as number });
    again.ws.close();
  }, 60_000);

  test("the state socket still sends the overview, again when another process changes it", async () => {
    const state = listen("/ws/state");
    const runsIn = (i: number) =>
      ((state.got[i] as { data: { runs: { runId: string }[] } } | undefined)?.data.runs ?? []).map(
        (r) => r.runId,
      );
    await until("the first overview", () => state.got[0]);
    const before = runsIn(0);
    const run = (await mt("run", "init", "--workflow", "demo", "--task", "Round half-up")).json.data as Data;
    await until("the overview with the new run", () =>
      state.got.some((_, i) => runsIn(i).includes(run.runId as string)) ? true : undefined,
    );
    expect(before).not.toContain(run.runId);
    state.ws.close();
  }, 30_000);
});
