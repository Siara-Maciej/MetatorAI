import { describe, expect, test } from "bun:test";
import { ChatNotices } from "@metator/core";
import { ok } from "../src/domain/result.ts";

function world() {
  const run = {
    runId: "20261120-shop",
    task: "Prices in the customer's currency\nmore words",
    updatedAt: "2026-11-20T10:00:00.000Z",
    state: { status: "active", stage: "plan-approval", context: { history: [{ stage: "plan" }] } },
  };
  const questions: { id: string; source: string; stage: string; answer?: unknown }[] = [];
  const activity: { text: string }[] = [];
  const typed: string[] = [];
  let state = "idle";
  const panes = [
    { id: "w1:p1", startedRun: "20261120-shop", live: { alive: true } },
    { id: "w1:p2", runId: "20261120-shop", live: { alive: true } },
  ] as { id: string; startedRun?: string; live?: { alive: boolean }; paused?: unknown }[];
  const notices = new ChatNotices({
    panes: { view: async () => ok({ workspaces: [], panes } as never) },
    repo: { load: async () => ok(run as never) },
    journal: {
      questions: async () => ok(questions as never),
      activity: async () => ok(activity as never),
      record: async (_runId, a) => {
        activity.push({ text: a.text });
        return ok(a as never);
      },
    },
    sensor: { state: async () => ok({ state: state as never, reason: "" }) },
    nudge: async (paneId, text) => {
      typed.push(`${paneId} ${text}`);
      return ok(undefined);
    },
  });
  return { run, questions, activity, typed, panes, notices, set: (s: string) => (state = s) };
}

describe("ChatNotices: the chat where the task was given learns what became of it", () => {
  test("a person's approval waits: one line typed into the idle chat, once; the run's activity says so", async () => {
    const w = world();
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([]);
    w.questions.push({ id: "q001", source: "gate", stage: "plan-approval" });
    const line =
      "[metator] The task 20261120-shop (Prices in the customer's currency) waits for a person's approval at plan-approval. Tell the person to approve it in the app (Home).";
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([
      { paneId: "w1:p1", runId: "20261120-shop", event: "approval", line },
    ]);
    expect(w.typed).toEqual([`w1:p1 ${line}`]);
    expect(w.activity.map((a) => a.text)).toEqual([`told the chat (pane w1:p1, approval q001): ${line}`]);
    await w.notices.tick();
    expect(w.typed).toHaveLength(1);
    // An approval already given is no news.
    w.questions[0] = { id: "q002", source: "gate", stage: "plan-approval", answer: { by: "ana" } };
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([]);
  });

  test("an agent at work (or a person typing) is not interrupted: the line waits until it is idle", async () => {
    const w = world();
    w.run.state.status = "done";
    w.set("working");
    expect((await w.notices.tick())._unsafeUnwrap()).toEqual([]);
    w.set("idle");
    await w.notices.tick();
    expect(w.typed).toEqual([
      "w1:p1 [metator] The task 20261120-shop (Prices in the customer's currency) is done. Tell the person what was done.",
    ]);
  });

  test("an escalated task says where it stopped; each escalation is its own event", async () => {
    const w = world();
    w.run.state = { status: "escalated", stage: "escalated", context: { history: [{ stage: "build" }] } };
    await w.notices.tick();
    expect(w.typed[0]).toContain("stopped at build and needs the person");
    w.run.updatedAt = "2026-11-20T11:00:00.000Z";
    await w.notices.tick();
    expect(w.typed).toHaveLength(2);
  });

  test("a chat that is paused, gone or of no task is told nothing", async () => {
    const w = world();
    w.run.state.status = "done";
    (w.panes[0] as { paused?: unknown }).paused = { at: "t", why: "daemon-stopped" };
    await w.notices.tick();
    expect(w.typed).toEqual([]);
  });
});
