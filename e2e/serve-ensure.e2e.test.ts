/**
 * `metator serve --ensure` end to end (ADR-0087): the command the desktop app runs when it opens.
 * It starts the daemon for the repository in the background when none serves it, answers with the
 * address of the one that does, and never starts a second one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

type Ensured = { url: string; pid: number; started: boolean };
let repo: ScratchRepo;
const pids: number[] = [];
const ensure = async () => {
  const r = await metator(["serve", "--ensure", "--port", "0"], repo.root);
  const data = r.json.data as Ensured;
  if (r.code === 0) pids.push(data.pid);
  return { code: r.code, data };
};
const lives = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.commit("init");
});
afterAll(async () => {
  for (const pid of new Set(pids)) if (lives(pid)) process.kill(pid, "SIGTERM");
  await repo.dispose();
});

describe("metator serve --ensure (real daemon)", () => {
  test("starts the daemon once and returns at once; the next call answers with the same one", async () => {
    const first = await ensure();
    expect([first.code, first.data.started]).toEqual([0, true]);
    // The command returned while the daemon keeps serving: the app's window can open now.
    const health = (await (await fetch(`${first.data.url}/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
    expect(lives(first.data.pid)).toBe(true);

    const second = await ensure();
    expect(second.data).toEqual({ ...first.data, started: false });

    // A daemon that is gone leaves a stale file: the next call starts a new one.
    process.kill(first.data.pid, "SIGTERM");
    for (let i = 0; i < 100 && lives(first.data.pid); i++) await Bun.sleep(100);
    const third = await ensure();
    expect(third.data.started).toBe(true);
    expect(third.data.pid).not.toBe(first.data.pid);
    expect(((await (await fetch(`${third.data.url}/health`)).json()) as { ok: boolean }).ok).toBe(true);
  }, 90_000);
});
