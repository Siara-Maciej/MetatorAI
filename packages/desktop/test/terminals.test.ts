import { describe, expect, test } from "bun:test";
import { gotoRows } from "../src/features/terminals/model.ts";
import {
  endedBanner,
  finishedOf,
  isEnded,
  paneKey,
  pathOf,
  sessionIn,
  sessionView,
  subBadge,
  taskGotoRows,
  taskView,
  terminalTasks,
  whereIs,
} from "../src/features/terminals/terminals.ts";
import type { PaneView } from "../src/shared/api/api.ts";
import { paneStateOf } from "../src/shared/model/panes.ts";
import { parseRoute, routeHash } from "../src/shared/model/route.ts";
import type { Run } from "../src/shared/model/runs.ts";

const run = (runId: string, extra: Partial<Run> = {}): Run =>
  ({ runId, task: `task ${runId}`, status: "active", ...extra }) as Run;
let n = 0;
const pane = (extra: Partial<PaneView> & { repo?: string }): PaneView & { repo?: string } =>
  ({
    id: `w1:p${++n}`,
    tab: "w1:t1",
    role: "worker",
    label: "pane",
    cwd: "/x",
    process: { kind: "host", host: "scenario", agent: "mt-implementer", prompt: "" },
    createdAt: "2026-11-19T10:00:00.000Z",
    live: { alive: true, sessionId: `s${n}`, lastOutputAt: "2026-11-19T10:00:00.000Z" },
    state: { state: "working" },
    ...extra,
  }) as never;

// The owner's picture: the chat where the task was given, the system run, a session per repository.
const runs = [
  run("sys", { children: ["api", "web"], repo: "shop-api", task: "Prices in the customer's currency" }),
  run("api", { parent: "sys", repo: "shop-api" }),
  run("web", { parent: "sys", repo: "shop-web" }),
  run("alone", { repo: "billing" }),
];
const chat = pane({ role: "apps", label: "chat", startedRun: "sys", repo: "shop-api" });
const sysConductor = pane({ role: "conductor", runId: "sys", repo: "shop-api" });
const apiConductor = pane({ role: "conductor", runId: "api", repo: "shop-api" });
const apiWorker1 = pane({
  runId: "api",
  repo: "shop-api",
  worker: { name: "mt-implementer-1", stage: "build" },
});
const apiWorker2 = pane({
  runId: "api",
  repo: "shop-api",
  worker: { name: "mt-implementer-2", stage: "build" },
  live: { alive: false, sessionId: "x", exitCode: 0 } as never,
  ended: { at: "2026-11-19T10:05:00.000Z", reason: "collected", summary: "tests pass" },
});
const webConductor = pane({ role: "conductor", runId: "web", repo: "shop-web" });
const aloneConductor = pane({ role: "conductor", runId: "alone", repo: "billing" });
const aloneWorker = pane({
  runId: "alone",
  repo: "billing",
  worker: { name: "mt-implementer-1", stage: "build" },
});
const panes = [
  chat,
  sysConductor,
  apiConductor,
  apiWorker1,
  apiWorker2,
  webConductor,
  aloneConductor,
  aloneWorker,
];
const tasks = terminalTasks(runs, panes, (id) => (id === "api" ? "price-model" : undefined));
const sys = tasks.find((t) => t.runId === "sys");
const alone = tasks.find((t) => t.runId === "alone");

describe("terminals by task (round 8)", () => {
  test("a task's main terminal is where the task was given; one tile per repository session; no workers", () => {
    expect(tasks.map((t) => t.runId)).toEqual(["sys", "alone"]);
    expect(sys?.main).toBe(chat);
    // The system run's own conductor is a session too, then a session per child run.
    expect(sys?.sessions.map((s) => [s.runId, s.label])).toEqual([
      ["sys", "shop-api"],
      ["api", "shop-api · price-model"],
      ["web", "shop-web"],
    ]);
    expect(taskView(sys as never)).toEqual([chat, sysConductor, apiConductor, webConductor]);
    expect(taskView(sys as never)).not.toContain(apiWorker1);
  });

  test("a session's own view: its main terminal and its sub-terminals", () => {
    const api = sessionIn(sys as never, "api");
    expect(sessionView(api as never)).toEqual([apiConductor, apiWorker1, apiWorker2]);
    expect(subBadge(api as never)).toBe("2 sub-terminals · 1 working · 1 finished");
    expect(subBadge(sessionIn(sys as never, "web") as never)).toBeUndefined();
  });

  test("a run of its own with no chat: its conductor is the main terminal, its workers its own session's", () => {
    expect(alone?.main).toBe(aloneConductor);
    expect(alone?.sessions).toEqual([]);
    expect(alone?.own.subs).toEqual([aloneWorker]);
    expect(taskView(alone as never)).toEqual([aloneConductor]);
  });

  test("where a pane is shown: a tile of its task, or its session's view for a sub-terminal", () => {
    expect(whereIs(tasks, chat.id)).toEqual({ task: sys as never });
    expect(whereIs(tasks, apiWorker1.id)).toEqual({ task: sys as never, session: "api" });
    expect(whereIs(tasks, aloneWorker.id)).toEqual({ task: alone as never, session: "alone" });
    expect(whereIs(tasks, "w9:p9")).toBeUndefined();
  });

  test("each repository numbers its own panes: the same id in two repositories is two panes", () => {
    const same = [
      run("t", { children: ["b", "s"], repo: "platform" }),
      run("b", { parent: "t", repo: "billing" }),
      run("s", { parent: "t", repo: "shop-api" }),
    ];
    const intake = pane({ id: "w1:p1", role: "apps", startedRun: "t", repo: "platform" });
    const billing = pane({ id: "w1:p1", role: "conductor", runId: "b", repo: "billing" });
    const billingWorker = pane({ id: "w1:p2", runId: "b", repo: "billing" });
    const shop = pane({ id: "w1:p1", role: "conductor", runId: "s", repo: "shop-api" });
    const shopWorker = pane({ id: "w1:p2", runId: "s", repo: "shop-api" });
    const [task] = terminalTasks(same, [intake, billing, billingWorker, shop, shopWorker]);
    if (!task) throw new Error("no task");
    expect(taskView(task)).toEqual([intake, billing, shop]);
    expect(taskView(task).map(paneKey)).toEqual(["platform|w1:p1", "billing|w1:p1", "shop-api|w1:p1"]);
    expect(whereIs([task], paneKey(shopWorker))).toEqual({ task: task as never, session: "s" });
    expect(whereIs([task], paneKey(billing))).toEqual({ task: task as never });
    const rows = taskGotoRows([task]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.find((r) => r.focusKey === paneKey(shopWorker))?.task).toEqual({ runId: "t", session: "s" });
  });

  test("Close finished on a task's view takes every finished terminal of the task, its sub-terminals too", () => {
    const [sys] = terminalTasks(runs, panes);
    if (!sys) throw new Error("no task");
    // apiWorker2 is a finished sub-terminal: not a tile of the task's view, yet the task's.
    expect(taskView(sys)).not.toContain(apiWorker2);
    expect(finishedOf(sys)).toEqual([apiWorker2]);
    const api = sessionIn(sys, "api");
    if (!api) throw new Error("no session");
    expect(finishedOf(sys, api)).toEqual([apiWorker2]);
    const web = sessionIn(sys, "web");
    if (!web) throw new Error("no session");
    expect(finishedOf(sys, web)).toEqual([]);
  });

  test("an ended pane says why in its banner: done, or the error tone with its code", () => {
    expect(isEnded(apiWorker2)).toBe(true);
    expect(endedBanner(apiWorker2)).toEqual({ text: "Finished — tests pass", tone: "done" });
    expect(endedBanner({ ended: { at: "", reason: "run-finished" } })).toEqual({
      text: "Finished — its run finished",
      tone: "done",
    });
    // Collected or ended with its run: the code is the stop the daemon sent (SIGHUP, 129), not a failure.
    expect(
      endedBanner({ ended: { at: "", reason: "collected", exitCode: 129, summary: "5 pass, 0 fail" } }),
    ).toEqual({ text: "Finished — 5 pass, 0 fail", tone: "done" });
    expect(endedBanner({ ended: { at: "", reason: "run-finished", exitCode: 143 } }).tone).toBe("done");
    // A process that exits by itself: 0 is done, any other code (1 too) is the error tone.
    expect(endedBanner({ ended: { at: "", reason: "exited", exitCode: 0 } }).tone).toBe("done");
    expect(endedBanner({ ended: { at: "", reason: "exited", exitCode: 1 } }).tone).toBe("error");
    expect(endedBanner({ ended: { at: "", reason: "exited", exitCode: 2 } })).toEqual({
      text: "Ended with code 2 — its process ended",
      tone: "error",
    });
    // The pane's state follows: finished, or exited after a failure.
    expect(paneStateOf(apiWorker2)).toBe("finished");
    expect(paneStateOf({ ...apiWorker1, ended: { at: "", reason: "exited", exitCode: 1 } })).toBe("exited");
  });

  test("go to lists the hierarchy: task › repository › worker", () => {
    expect(pathOf(sys as never, chat)).toBe("Prices in the customer's currency › main terminal");
    expect(pathOf(sys as never, apiConductor)).toBe(
      "Prices in the customer's currency › shop-api · price-model",
    );
    expect(pathOf(sys as never, apiWorker1)).toBe(
      "Prices in the customer's currency › shop-api · price-model › mt-implementer-1",
    );
    const rows = taskGotoRows(tasks);
    expect(rows.find((r) => r.paneId === apiWorker1.id)?.task).toEqual({ runId: "sys", session: "api" });
    // A pane of a task is listed once, by its place in the task, not again under its workspace's tab.
    const tab = {
      key: "w1:t1",
      label: "tab",
      kind: "task",
      workspaceId: "w1",
      tabId: "w1:t1",
      panes: [chat.id],
    };
    const all = gotoRows([{ id: "w1", label: "r", cwd: "/", tabs: [tab as never] }], panes, "all", "", rows);
    expect(all.filter((r) => r.paneId === chat.id)).toHaveLength(1);
    expect(gotoRows([], panes, "done", "", rows).map((r) => r.paneId)).toEqual([apiWorker2.id]);
  });

  test("a child that names its parent (run new --parent) is a session of the parent's task", () => {
    const t = terminalTasks(
      [run("p"), run("k", { parent: "p" })],
      [pane({ role: "conductor", runId: "p" }), pane({ role: "conductor", runId: "k" })],
    );
    expect(t.map((x) => [x.runId, x.sessions.map((s) => s.runId)])).toEqual([["p", ["k"]]]);
  });

  test("a task's and a session's address", () => {
    expect(routeHash({ screen: "grid", task: "sys", session: "api" })).toBe("#/grid/task/sys/api");
    expect(parseRoute("#/grid/task/sys/api")).toEqual({ screen: "grid", task: "sys", session: "api" });
    expect(parseRoute("#/grid/task/sys")).toEqual({ screen: "grid", task: "sys" });
    expect(parseRoute("#/grid/workspaces")).toEqual({ screen: "grid", group: "workspaces" });
    expect(parseRoute("#/grid/tasks")).toEqual({ screen: "grid", group: "tasks" });
  });
});

describe("a parent named by its children is one task (round 8)", () => {
  test("a run whose child names it with --parent groups with that child on the board and in the sidebar", async () => {
    const { boardCards } = await import("../src/shared/model/board.ts");
    const { workTasks } = await import("../src/shared/model/tasks.ts");
    const now = Date.parse("2026-11-19T12:00:00.000Z");
    const r = (runId: string, extra: Partial<Run> = {}) =>
      ({
        runId,
        task: runId,
        status: "active",
        stage: "build",
        attention: "driving",
        phase: "in-progress",
        stages: [],
        questions: [],
        elapsedMs: 0,
        updatedAt: "2026-11-19T11:00:00.000Z",
        ...extra,
      }) as Run;
    const t = workTasks(
      boardCards({ runs: [r("p"), r("k", { parent: "p" })], issues: [], plans: [], now }),
      [],
    );
    expect(t.map((x) => [x.key, x.kind, x.head?.runId, x.subtasks.map((c) => c.runId)])).toEqual([
      ["run:p", "parent", "p", ["k"]],
    ]);
  });
});
