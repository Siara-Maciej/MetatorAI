import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import type { PaneView } from "../src/application/panes.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { InitRun } from "../src/application/runs.ts";
import {
  directTalkLine,
  PaneMail,
  RELAY_PREFIX,
  SessionSteering,
} from "../src/application/session-steering.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const AT = "2026-11-21T10:00:00.000Z";

async function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date(AT));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const init = new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock);
  const task = (await init.execute({ workflow: "demo", task: "The system task" }))._unsafeUnwrap().runId;
  const child = (await init.execute({ workflow: "demo", task: "Its child", parent: task }))._unsafeUnwrap()
    .runId;
  const other = (await init.execute({ workflow: "demo", task: "Another task" }))._unsafeUnwrap().runId;
  const host = (agent: string, prompt = "") => ({ kind: "host" as const, host: "claude", agent, prompt });
  const pane = (id: string, over: Partial<PaneView>): PaneView =>
    ({
      id,
      role: "worker",
      label: id,
      cwd: "/repo",
      process: host("mt-implementer"),
      createdAt: AT,
      live: { alive: true },
      ...over,
    }) as PaneView;
  const panes: PaneView[] = [
    pane("w1:p1", { role: "apps", label: "chat", process: host("mt-chat"), startedRun: task }),
    pane("w2:p2", {
      role: "conductor",
      runId: task,
      process: host("mt-orchestrator", "You are the conductor of run x"),
    }),
    pane("w3:p3", { role: "conductor", runId: child, process: host("mt-orchestrator") }),
    pane("w3:p4", { runId: child, worker: { name: "mt-implementer-1", stage: "build" } }),
    pane("w4:p5", { role: "conductor", runId: other, process: host("mt-orchestrator") }),
    pane("w4:p6", { role: "shell", runId: other, process: { kind: "command", argv: ["bash"] } }),
  ];
  const states = new Map<string, string>(panes.map((p) => [p.id, "idle"]));
  const asking = new Set<string>();
  const typed: [string, string][] = [];
  const interrupted: [string, string][] = [];
  const sensor = {
    state: async (id: string) =>
      states.has(id) ? ok({ state: states.get(id) } as never) : err(MetatorError.notFound(`pane ${id}`)),
  };
  const mail = new PaneMail({
    fs,
    clock,
    panes: { view: async () => ok({ workspaces: [], panes }) },
    sensor,
    asksInPane: (id) => asking.has(id),
    nudge: async (id, text) => {
      typed.push([id, text]);
      return ok(undefined);
    },
    journal,
  });
  const steering = new SessionSteering({
    panes: { view: async () => ok({ workspaces: [], panes }) },
    repo,
    mail,
    interrupt: async (id, text) => {
      interrupted.push([id, text]);
      return ok(undefined);
    },
    journal,
    repoName: "shop-api",
    daemonTyped: () => [],
    sensor,
  });
  const activity = async (runId: string) =>
    (await journal.activity(runId))._unsafeUnwrap().map((a) => a.text);
  return {
    fs,
    clock,
    panes,
    states,
    asking,
    typed,
    interrupted,
    mail,
    steering,
    task,
    child,
    other,
    activity,
  };
}

describe("SessionSteering.list: the sessions of a task", () => {
  test("the task's main chat, its run's panes and its child runs' panes, each with repo, role, agent and state", async () => {
    const w = await world();
    w.states.set("w3:p4", "working");
    const sessions = (await w.steering.list({ task: w.task }))._unsafeUnwrap();
    expect(sessions.map((s) => [s.pane, s.repo, s.role, s.agent, s.state, s.runId, s.main])).toEqual([
      ["w1:p1", "shop-api", "apps", "mt-chat", "idle", undefined, true],
      ["w2:p2", "shop-api", "conductor", "mt-orchestrator", "idle", w.task, undefined],
      ["w3:p3", "shop-api", "conductor", "mt-orchestrator", "idle", w.child, undefined],
      ["w3:p4", "shop-api", "worker", "mt-implementer", "working", w.child, undefined],
    ]);
    expect(sessions[3]?.worker).toBe("mt-implementer-1");
    // No task named: every agent session; a shell is no session to steer.
    const all = (await w.steering.list({}))._unsafeUnwrap();
    expect(all.map((s) => s.pane)).toEqual(["w1:p1", "w2:p2", "w3:p3", "w3:p4", "w4:p5"]);
    // A pane whose work is over says so.
    (w.panes[3] as { ended?: unknown }).ended = { at: AT, reason: "collected" };
    expect((await w.steering.list({ task: w.child }))._unsafeUnwrap().map((s) => [s.pane, s.state])).toEqual([
      ["w3:p3", "idle"],
      ["w3:p4", "ended"],
    ]);
  });
});

describe("session tell: the person's words, relayed when the agent is idle", () => {
  test("from the task's main chat: queued, typed with the prefix once the agent is idle, recorded in the run's activity", async () => {
    const w = await world();
    w.states.set("w3:p4", "working");
    const chat = w.panes[0] as PaneView;
    const told = (
      await w.steering.tell({ paneId: "w3:p4", text: "Use half-even\nrounding", from: chat })
    )._unsafeUnwrap();
    expect(told).toEqual({ pane: "w3:p4", queued: true, state: "working" });
    // Working: nothing is typed over it.
    expect((await w.mail.tick())._unsafeUnwrap()).toEqual([]);
    expect(w.typed).toEqual([]);
    w.states.set("w3:p4", "idle");
    const delivered = (await w.mail.tick())._unsafeUnwrap();
    expect(delivered.map((d) => d.paneId)).toEqual(["w3:p4"]);
    // One line, the person's words as they are (a line break would send it early).
    expect(w.typed).toEqual([["w3:p4", `${RELAY_PREFIX}Use half-even rounding`]]);
    expect(RELAY_PREFIX).toBe("[metator] From the person, through the main chat: ");
    expect(await w.activity(w.child)).toContain(
      "relayed to shop-api/mt-implementer (pane w3:p4): [metator] From the person, through the main chat: Use half-even rounding",
    );
    // Delivered once.
    expect((await w.mail.tick())._unsafeUnwrap()).toEqual([]);
    expect(w.typed).toHaveLength(1);
  });

  test("never over a host prompt or an open question; two tells arrive in order, one message each", async () => {
    const w = await world();
    const chat = w.panes[0] as PaneView;
    await w.steering.tell({ paneId: "w3:p4", text: "first", from: chat });
    await w.steering.tell({ paneId: "w3:p4", text: "second", from: chat });
    w.asking.add("w3:p4");
    expect((await w.mail.tick())._unsafeUnwrap()).toEqual([]);
    w.asking.delete("w3:p4");
    w.states.set("w3:p4", "waiting");
    expect((await w.mail.tick())._unsafeUnwrap()).toEqual([]);
    w.states.set("w3:p4", "idle");
    await w.mail.tick();
    expect(w.typed.map((t) => t[1])).toEqual([`${RELAY_PREFIX}first`]);
    await w.mail.tick();
    expect(w.typed.map((t) => t[1])).toEqual([`${RELAY_PREFIX}first`, `${RELAY_PREFIX}second`]);
  });

  test("a queue survives the daemon; a letter for a pane that ended is dropped and said", async () => {
    const w = await world();
    await w.steering.tell({ paneId: "w3:p4", text: "keep this", from: w.panes[0] as PaneView });
    const doc = JSON.parse((await w.fs.read(".metator/pane-mail.json"))._unsafeUnwrap());
    expect(doc).toMatchObject({ kind: "PaneMail", schemaVersion: 1, letters: [{ paneId: "w3:p4" }] });
    (w.panes[3] as { ended?: unknown }).ended = { at: AT, reason: "collected" };
    expect((await w.mail.tick())._unsafeUnwrap()).toEqual([]);
    expect(w.typed).toEqual([]);
    expect(await w.activity(w.child)).toContain(
      "not relayed to shop-api/mt-implementer (pane w3:p4), its session ended: [metator] From the person, through the main chat: keep this",
    );
    expect(JSON.parse((await w.fs.read(".metator/pane-mail.json"))._unsafeUnwrap()).letters).toEqual([]);
  });

  test("only the task's main chat or a person: another task's chat, a conductor and a worker are refused; a person's own words say so", async () => {
    const w = await world();
    const refused = async (from: PaneView, paneId = "w3:p4") =>
      (await w.steering.tell({ paneId, text: "x", from }))._unsafeUnwrapErr();
    const elsewhere = { ...(w.panes[0] as PaneView), id: "w9:p9", startedRun: w.other };
    const no = await refused(elsewhere);
    expect([no.code, no.message]).toEqual([
      "TRANSITION_DENIED",
      `pane w9:p9 is not the main chat of the task of pane w3:p4 (run ${w.child}): only that chat or a person steers its sessions`,
    ]);
    expect((await refused(w.panes[1] as PaneView)).code).toBe("TRANSITION_DENIED");
    expect((await refused(w.panes[3] as PaneView, "w3:p3")).code).toBe("TRANSITION_DENIED");
    // A person, from their own terminal: no pane; their name is in the line.
    (await w.steering.tell({ paneId: "w3:p4", text: "stop there", by: "ana" }))._unsafeUnwrap();
    await w.mail.tick();
    expect(w.typed).toEqual([["w3:p4", "[metator] From the person (ana): stop there"]]);
    // What cannot be told: a shell, a pane with no run, an ended one, an unknown one, and nothing.
    const usage = async (paneId: string, text = "x") =>
      (await w.steering.tell({ paneId, text, by: "ana" }))._unsafeUnwrapErr().message;
    expect(await usage("w4:p6")).toBe("pane w4:p6 is no agent session of a run: nothing to tell");
    expect(await usage("w1:p1")).toBe("pane w1:p1 is no agent session of a run: nothing to tell");
    expect(await usage("w0:p0")).toBe("pane w0:p0 not found");
    expect(await usage("w3:p4", "  ")).toBe("say what to tell: --text <the person's words>");
  });
});

describe("session interrupt: Esc, then the words", () => {
  test("at once, also while the agent works; refused like tell; recorded", async () => {
    const w = await world();
    w.states.set("w3:p4", "working");
    const r = (
      await w.steering.interrupt({ paneId: "w3:p4", text: "Stop: wrong file", from: w.panes[0] as PaneView })
    )._unsafeUnwrap();
    expect(r).toEqual({ pane: "w3:p4", interrupted: true });
    expect(w.interrupted).toEqual([["w3:p4", `${RELAY_PREFIX}Stop: wrong file`]]);
    expect(await w.activity(w.child)).toContain(
      "interrupted shop-api/mt-implementer (pane w3:p4): [metator] From the person, through the main chat: Stop: wrong file",
    );
    const no = await w.steering.interrupt({ paneId: "w3:p4", text: "x", from: w.panes[4] as PaneView });
    expect(no._unsafeUnwrapErr().code).toBe("TRANSITION_DENIED");
    expect(w.interrupted).toHaveLength(1);
  });
});

describe("the person talks to a sub-session directly: the task's main chat hears of it", () => {
  test("one line for the main chat, with where and the first 200 characters; typed when the chat is idle", async () => {
    const w = await world();
    const long = `Use half-even rounding ${"x".repeat(300)}`;
    const said = (await w.steering.directTalk({ paneId: "w3:p4", text: long }))._unsafeUnwrap();
    expect(said?.task).toEqual([w.child, w.task]);
    expect(said?.line).toBe(
      `[metator] The person told shop-api/mt-implementer directly: "${long.slice(0, 200)}"`,
    );
    expect(directTalkLine("web", "mt-tester", 'say "hi"\nplease')).toBe(
      '[metator] The person told web/mt-tester directly: "say "hi" please"',
    );
    expect((await w.steering.tellChats(said?.task ?? [], said?.line ?? ""))._unsafeUnwrap()).toEqual([
      "w1:p1",
    ]);
    await w.mail.tick();
    expect(w.typed).toEqual([["w1:p1", said?.line as string]]);
    expect(await w.activity(w.task)).toContain(`told the chat (pane w1:p1): ${said?.line}`);
  });

  test("what MetatorAI typed itself, the session's first prompt, the chat's own pane and a pane of no run say nothing", async () => {
    const w = await world();
    const none = async (paneId: string, text: string) =>
      (await w.steering.directTalk({ paneId, text }))._unsafeUnwrap();
    expect(await none("w3:p4", `${RELAY_PREFIX}Use half-even`)).toBeUndefined();
    expect(await none("w2:p2", "You are the conductor of run x")).toBeUndefined();
    expect(await none("w1:p1", "Round the prices")).toBeUndefined();
    expect(await none("w4:p6", "ls")).toBeUndefined();
    expect(await none("w3:p4", "   ")).toBeUndefined();
    // A task with no main chat: nobody to tell.
    const lonely = (await w.steering.directTalk({ paneId: "w4:p5", text: "hello" }))._unsafeUnwrap();
    expect((await w.steering.tellChats(lonely?.task ?? [], lonely?.line ?? ""))._unsafeUnwrap()).toEqual([]);
  });

  test("a card's answer MetatorAI typed for the person is not the person talking directly", async () => {
    const w = await world();
    const steering = new SessionSteering({
      panes: { view: async () => ok({ workspaces: [], panes: w.panes }) },
      repo: new RunRepository(w.fs, DEFAULT_PATHS),
      mail: w.mail,
      interrupt: async () => ok(undefined),
      journal: { record: async () => ok(undefined) },
      repoName: "shop-api",
      daemonTyped: (paneId) => (paneId === "w3:p4" ? ["half-even"] : []),
    });
    expect(
      (await steering.directTalk({ paneId: "w3:p4", text: "half-even" }))._unsafeUnwrap(),
    ).toBeUndefined();
    expect((await steering.directTalk({ paneId: "w3:p3", text: "half-even" }))._unsafeUnwrap()).toBeDefined();
  });
});
