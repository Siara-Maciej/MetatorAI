import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conductorSessions } from "../src/sessions.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "metator-sessions-"));
  dirs.push(d);
  return d;
}

describe("conductorSessions (the ConductorSessions port through the daemon)", () => {
  test("no daemon serves the repository: an error that says so (core then drives the run)", async () => {
    const root = await repo();
    const opened = await conductorSessions()({ root }).open({ runId: "r1", host: "claude" });
    expect(opened._unsafeUnwrapErr().message).toBe("no daemon runs for this repository");
  });

  test("the daemon of the repository opens the run's conductor, as `run start` asks it; its pane and host come back", async () => {
    const root = await repo();
    const calls: { path: string; body: unknown }[] = [];
    const daemon = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        calls.push({ path: `${url.pathname}${url.search}`, body: await req.json() });
        return Response.json({
          ok: true,
          data: {
            id: "w2:p1",
            role: "conductor",
            process: { kind: "host", host: "claude", agent: "mt-orchestrator" },
          },
        });
      },
    });
    await mkdir(join(root, ".metator"), { recursive: true });
    await Bun.write(
      join(root, ".metator/daemon.json"),
      JSON.stringify({
        kind: "DaemonInfo",
        schemaVersion: 1,
        url: `http://127.0.0.1:${daemon.port}`,
        pid: process.pid,
        startedAt: "2026-11-20T10:00:00.000Z",
      }),
    );
    const opened = await conductorSessions()({ root }).open({ runId: "r 1", host: "claude" });
    await daemon.stop(true);
    expect(opened._unsafeUnwrap()).toEqual({ paneId: "w2:p1", host: "claude" });
    expect(calls).toEqual([
      { path: `/runs/r%201/start?repo=${encodeURIComponent(root)}`, body: { host: "claude" } },
    ]);
  });
});
