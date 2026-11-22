import { describe, expect, test } from "bun:test";
import { ContinueTask, MetatorError, type TaskRepository } from "@metator/core";
import { err, ok } from "../src/domain/result.ts";

type FakePane = {
  id: string;
  role: string;
  runId?: string;
  startedRun?: string;
  paused?: { at: string; why: string };
  ended?: { at: string; reason: string };
  live?: { alive: boolean; sessionId: string };
};

/** A repository as the daemon holds it: its runs, its layout, its drives; what was done is recorded. */
function repo(
  name: string | undefined,
  runs: { runId: string; parent?: string; status: string }[],
  panes: FakePane[],
  driving: string[] = [],
) {
  const done: string[] = [];
  const journal: string[] = [];
  const r: TaskRepository = {
    ...(name ? { name } : {}),
    runs: {
      loadAll: async () => ({
        runs: runs.map((x) => ({ ...x, state: { status: x.status } })) as never,
        unreadable: [],
      }),
      load: async () => err(MetatorError.notFound("x")),
    },
    panes: {
      view: async () => ok({ workspaces: [], panes } as never),
      noteResumed: (pane) => {
        done.push(`noted ${pane.id}`);
      },
      resumePane: async (paneId) => {
        const p = panes.find((x) => x.id === paneId) as FakePane;
        done.push(`resume ${paneId}`);
        delete p.paused;
        p.live = { alive: true, sessionId: `s-${paneId}` };
        return ok(p as never);
      },
    },
    drivers: {
      status: async (runId) => ok(driving.includes(runId) ? ({ alive: true } as never) : null),
    },
    ensureDriven: {
      execute: async ({ runId }) => {
        done.push(`drive ${runId}`);
        return ok({ stage: "status", started: true, host: "claude" });
      },
    },
    conductor: {
      start: async ({ runId }) => {
        const p = panes.find((x) => x.runId === runId && x.role === "conductor") as FakePane;
        done.push(`conductor ${runId}`);
        p.live = { alive: true, sessionId: `s-${p.id}` };
        return ok(p as never);
      },
    },
    journal: {
      record: async (runId, a) => {
        journal.push(`${runId}: ${a.text}`);
        return ok(a as never);
      },
    },
  };
  return { r, done, journal };
}

describe("ContinueTask", () => {
  test("the task, its children in other repositories and its chat: paused panes resumed, the undriven runs carried again", async () => {
    const platform = repo(
      "platform",
      [
        { runId: "20261120-sys", status: "active" },
        { runId: "20261120-other", status: "active" },
      ],
      [
        { id: "w1:p1", role: "apps", startedRun: "20261120-sys", paused: { at: "t", why: "daemon-stopped" } },
        {
          id: "w2:p1",
          role: "conductor",
          runId: "20261120-other",
          paused: { at: "t", why: "daemon-stopped" },
        },
      ],
    );
    const billing = repo(
      "billing",
      [
        { runId: "20261120-bill", parent: "20261120-sys", status: "active" },
        { runId: "20261120-bill-fix", parent: "20261120-bill", status: "active" },
        { runId: "20261120-old", parent: "20261120-sys", status: "done" },
        { runId: "20261120-stuck", parent: "20261120-sys", status: "escalated" },
      ],
      [
        {
          id: "w1:p1",
          role: "conductor",
          runId: "20261120-bill",
          paused: { at: "t", why: "daemon-stopped" },
        },
        { id: "w1:p2", role: "worker", runId: "20261120-bill", paused: { at: "t", why: "process-lost" } },
        { id: "w1:p3", role: "worker", runId: "20261120-bill", ended: { at: "t", reason: "collected" } },
        { id: "w2:p1", role: "conductor", runId: "20261120-old", paused: { at: "t", why: "daemon-stopped" } },
        { id: "w3:p1", role: "conductor", runId: "20261120-bill-fix", ended: { at: "t", reason: "exited" } },
      ],
    );
    const report = (
      await new ContinueTask(() => [platform.r, billing.r]).execute({ runId: "20261120-sys", by: "ana" })
    )._unsafeUnwrap();
    expect(report).toEqual({
      resumed: [
        { repo: "platform", paneId: "w1:p1", role: "apps", sessionId: "s-w1:p1" },
        { repo: "billing", paneId: "w1:p1", role: "conductor", sessionId: "s-w1:p1" },
        { repo: "billing", paneId: "w1:p2", role: "worker", sessionId: "s-w1:p2" },
      ],
      drives: [
        // The system run had no conductor: its drive (at `status`) starts again; so does the
        // child whose conductor ended by itself.
        { repo: "platform", runId: "20261120-sys", host: "claude" },
        { repo: "billing", runId: "20261120-bill-fix", host: "claude" },
      ],
      skipped: [
        { repo: "billing", paneId: "w2:p1", runId: "20261120-old", why: "run 20261120-old is done" },
        {
          repo: "billing",
          runId: "20261120-stuck",
          why: "escalated: resume it first (`metator run resume --run 20261120-stuck --by <name>`)",
        },
      ],
    });
    // Another task's paused pane is left alone.
    expect(platform.done).toEqual(["resume w1:p1", "drive 20261120-sys"]);
    expect(billing.journal).toContain(
      "20261120-bill: continued by ana: resumed pane w1:p2 (session s-w1:p2)",
    );
    expect(platform.journal).toContain(
      "20261120-sys: continued by ana: its drive started again on claude at status",
    );
  });

  test("a run carried already is left as it is; a conductor whose session died is resumed through the conductor", async () => {
    const one = repo(
      undefined,
      [
        { runId: "20261120-a", status: "active" },
        { runId: "20261120-b", parent: "20261120-a", status: "active" },
      ],
      [{ id: "w1:p1", role: "conductor", runId: "20261120-b", live: { alive: false, sessionId: "s0" } }],
      ["20261120-a"],
    );
    const report = (
      await new ContinueTask(() => [one.r]).execute({ runId: "20261120-a", by: "ana" })
    )._unsafeUnwrap();
    expect(report).toEqual({
      resumed: [{ paneId: "w1:p1", role: "conductor", sessionId: "s-w1:p1" }],
      drives: [],
      skipped: [],
    });
    // The conductor brought back is told to go on, as a resumed one is.
    expect(one.done).toEqual(["conductor 20261120-b", "noted w1:p1"]);
  });

  test("an unknown run, and nobody named, are refused", async () => {
    const one = repo(undefined, [], []);
    const use = new ContinueTask(() => [one.r]);
    expect((await use.execute({ runId: "20261120-x", by: "ana" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await use.execute({ runId: "20261120-x", by: " " }))._unsafeUnwrapErr().message).toBe(
      "say who continues: by",
    );
  });
});
