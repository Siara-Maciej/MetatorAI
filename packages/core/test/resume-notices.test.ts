import { describe, expect, test } from "bun:test";
import { ResumeNotices } from "@metator/core";
import { ok } from "../src/domain/result.ts";

function world(role: "conductor" | "worker" = "conductor") {
  const pending = [
    {
      paneId: "w1:p1",
      runId: "20261120-shop",
      role,
      why: "daemon-stopped" as const,
      at: "2026-11-20T10:00:00.000Z",
    },
  ];
  const typed: string[] = [];
  const activity: string[] = [];
  let state = "idle";
  let driver: { by: string; attachedBy?: string } | undefined;
  let asking = false;
  const notices = new ResumeNotices({
    panes: {
      resumeNotices: () => [...pending],
      resumeNoticeTold: (paneId) => {
        pending.splice(
          pending.findIndex((p) => p.paneId === paneId),
          1,
        );
      },
    },
    sensor: { state: async () => ok({ state: state as never, reason: "" }) },
    repo: { load: async () => ok({ driver } as never) },
    journal: {
      record: async (_runId, a) => {
        activity.push(a.text);
        return ok(a as never);
      },
    },
    asksInPane: () => asking,
    nudge: async (paneId, text) => {
      typed.push(`${paneId} ${text}`);
      return ok(undefined);
    },
  });
  return {
    notices,
    typed,
    activity,
    pending,
    set: (s: string) => (state = s),
    hold: (d?: { by: string; attachedBy?: string }) => (driver = d),
    ask: (a: boolean) => (asking = a),
  };
}

const CONDUCTOR =
  "[metator] Your session was resumed after the daemon stopped (daemon-stopped, at 2026-11-20T10:00:00.000Z). Continue where you stopped: check `metator run status` and your workers (`metator run workers`).";
const WORKER =
  "[metator] Your session was resumed after the daemon stopped. Continue your card where you stopped and report with `metator run result`.";

describe("ResumeNotices: a resumed session is told, once, to go on", () => {
  test("a conductor idle at its prompt gets its line, once; the run's activity says so", async () => {
    const w = world();
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([
      { paneId: "w1:p1", runId: "20261120-shop", line: CONDUCTOR },
    ]);
    expect(w.typed).toEqual([`w1:p1 ${CONDUCTOR}`]);
    expect(w.activity).toEqual([`told the resumed session in pane w1:p1: ${CONDUCTOR}`]);
    await w.notices.tick();
    expect(w.typed).toHaveLength(1);
  });

  test("a worker gets its own line", async () => {
    const w = world("worker");
    await w.notices.tick();
    expect(w.typed).toEqual([`w1:p1 ${WORKER}`]);
  });

  test("never over a person at the keyboard, nor over work: it waits, then goes once", async () => {
    const w = world();
    w.hold({ by: "human", attachedBy: "ana" });
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([]);
    w.hold(undefined);
    w.set("working");
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([]);
    // Never into an agent that asked the person in words and waits for them.
    w.set("idle");
    w.ask(true);
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([]);
    w.ask(false);
    w.set("working");
    // Never into a question that waits for the person: the host's prompt on its screen, or a card.
    for (const state of ["blocked", "waiting"]) {
      w.set(state);
      expect((await w.notices.tick())._unsafeUnwrap()).toEqual([]);
    }
    expect(w.pending).toHaveLength(1);
    w.set("idle");
    await w.notices.tick();
    expect(w.typed).toHaveLength(1);
    expect(w.pending).toEqual([]);
  });
});
