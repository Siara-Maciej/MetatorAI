import { describe, expect, test } from "bun:test";
import { ChatNotices, type ChatNoticesDependencies, MetatorError } from "@metator/core";
import { err, ok } from "../src/domain/result.ts";

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
  const load = async () => ok(run as never);
  const journal: ChatNoticesDependencies["journal"] = {
    questions: async () => ok(questions as never),
    activity: async () => ok(activity as never),
    record: async (_runId, a) => {
      activity.push({ text: a.text });
      return ok(a as never);
    },
  };
  const notices = new ChatNotices({
    panes: { view: async () => ok({ workspaces: [], panes } as never) },
    repo: { load },
    journal,
    sensor: { state: async () => ok({ state: state as never, reason: "" }) },
    nudge: async (paneId, text) => {
      typed.push(`${paneId} ${text}`);
      return ok(undefined);
    },
  });
  return { run, questions, activity, typed, panes, notices, load, journal, set: (s: string) => (state = s) };
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

  test("a plan made on demand is ready: the chat is told once, with the command that keeps it in the Backlog", async () => {
    const w = world();
    w.run.state = { status: "planned", stage: "planned", context: { history: [{ stage: "plan-approval" }] } };
    expect((await w.notices.tick())._unsafeUnwrap().map((n) => n.event)).toEqual(["planned"]);
    await w.notices.tick();
    expect(w.typed).toEqual([
      "w1:p1 [metator] The task 20261120-shop (Prices in the customer's currency) has its plan approved and stopped there (plan ready). Ask the person whether to put the plan in the Backlog (`metator issue from-plan --run 20261120-shop`).",
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

  test("a folder's chat is told of a run kept in one of the folder's repositories (ADR-0113)", async () => {
    const shop = world();
    shop.run.state.status = "done";
    const typed: string[] = [];
    const folder = new ChatNotices({
      panes: { view: async () => ok({ workspaces: [], panes: shop.panes } as never) },
      // The folder's own place holds no run.
      repo: { load: async () => err(MetatorError.notFound("run 20261120-shop")) },
      journal: {
        questions: async () => err(MetatorError.notFound("run 20261120-shop")),
        activity: async () => err(MetatorError.notFound("run 20261120-shop")),
        record: async () => err(MetatorError.notFound("run 20261120-shop")),
      },
      sensor: { state: async () => ok({ state: "idle" as never, reason: "" }) },
      nudge: async (paneId, text) => {
        typed.push(`${paneId} ${text}`);
        return ok(undefined);
      },
    });
    // Without the repositories the run cannot be read: nothing to say yet.
    expect((await folder.tick())._unsafeUnwrap()).toEqual([]);
    const elsewhere = [{ repo: { load: shop.load }, journal: shop.journal }];
    const told = (await folder.tick(elsewhere))._unsafeUnwrap();
    expect(told.map((t) => [t.paneId, t.runId, t.event])).toEqual([["w1:p1", "20261120-shop", "done"]]);
    expect(typed).toHaveLength(1);
    // The mark is written where the run is kept, so the line is typed once.
    expect(shop.activity.map((a) => a.text)).toEqual([`told the chat (pane w1:p1, done): ${told[0]?.line}`]);
    expect((await folder.tick(elsewhere))._unsafeUnwrap()).toEqual([]);
  });
});
