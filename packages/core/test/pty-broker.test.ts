import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  DriverLock,
  InitRun,
  PtyBroker,
  type PtyEvent,
  RunJournal,
  RunRepository,
  WorkflowCatalog,
} from "@metator/core";
import { FakePty, FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-02T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const timers: { ms: number; fn: () => void }[] = [];
  const broker = new PtyBroker({
    repo,
    journal,
    clock,
    idleMs: 5000,
    after: (ms, fn) => {
      const t = { ms, fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  const init = (task: string) => new InitRun(catalog, repo, clock).execute({ workflow: "demo", task });
  const start = (
    paneId: string,
    runId: string | undefined,
    pty = new FakePty(1001),
    role: "conductor" | "shell" = "conductor",
  ) =>
    broker
      .start({ paneId, ...(runId ? { runId } : {}), role, host: "fake", sessionId: "fake-1", pty })
      ._unsafeUnwrap();
  return { fs, repo, journal, broker, timers, init, start, lock: new DriverLock(repo, journal, clock) };
}

describe("PtyBroker", () => {
  test("a started terminal fans its output out, keeps a backlog, and refuses a second live start of the pane", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = new FakePty(1001);
    const view = w.start("w1:p1", run.runId, pty);
    expect(view).toEqual({
      paneId: "w1:p1",
      runId: run.runId,
      role: "conductor",
      host: "fake",
      sessionId: "fake-1",
      pid: 1001,
      alive: true,
      idle: false,
      lastOutputAt: "2026-11-02T10:00:00.000Z",
    });
    const seen: PtyEvent[] = [];
    const stop = w.broker.subscribe("w1:p1", (e) => seen.push(e));
    pty.print("hello ");
    pty.print("world");
    expect(w.broker.backlog("w1:p1")).toBe("hello world");
    expect(seen).toEqual([
      { type: "data", data: "hello " },
      { type: "data", data: "world" },
    ]);
    stop();
    expect(
      w.broker
        .start({
          paneId: "w1:p1",
          runId: run.runId,
          role: "conductor",
          host: "fake",
          sessionId: "x",
          pty: new FakePty(),
        })
        ._unsafeUnwrapErr().message,
    ).toBe("pane w1:p1 already has a live terminal");
    expect(w.broker.byRun(run.runId).map((v) => v.paneId)).toEqual(["w1:p1"]);
  });

  test("typing goes to a run's pane only from the person who holds the driver lock; a shell takes any name", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = new FakePty(1001);
    w.start("w1:p1", run.runId, pty);
    const agentDriven = (
      await w.broker.write({ paneId: "w1:p1", data: "y\r", by: "maciej" })
    )._unsafeUnwrapErr();
    expect(agentDriven.message).toContain("is driven by the agent: attach first");
    await w.lock.attach({ runId: run.runId, by: "maciej" });
    const other = (await w.broker.write({ paneId: "w1:p1", data: "y\r", by: "alice" }))._unsafeUnwrapErr();
    expect(other.message).toContain("is driven by maciej: only they may type");
    expect((await w.broker.write({ paneId: "w1:p1", data: "y\r", by: "maciej" })).isOk()).toBe(true);
    expect(pty.typed).toEqual(["y\r"]);
    expect(w.broker.resize("w1:p1", { cols: 100, rows: 30 }).isOk()).toBe(true);
    expect(pty.sizes).toEqual([{ cols: 100, rows: 30 }]);
    const shell = new FakePty(1002);
    w.start("w2:p2", undefined, shell, "shell");
    expect((await w.broker.write({ paneId: "w2:p2", data: "ls\r", by: "" }))._unsafeUnwrapErr().message).toBe(
      "say who types (`by`)",
    );
    expect((await w.broker.write({ paneId: "w2:p2", data: "ls\r", by: "anyone" })).isOk()).toBe(true);
    expect(shell.typed).toEqual(["ls\r"]);
  });

  test("an exit is noted in the run and told to viewers; a dead pane can be started again", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = new FakePty(1001);
    w.start("w1:p1", run.runId, pty);
    const seen: PtyEvent[] = [];
    w.broker.subscribe("w1:p1", (e) => seen.push(e));
    pty.exit(3);
    expect(seen).toEqual([{ type: "exit", code: 3 }]);
    expect(w.broker.status("w1:p1")).toMatchObject({ alive: false, exitCode: 3 });
    expect((await w.broker.write({ paneId: "w1:p1", data: "x", by: "m" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
    const again = w.start("w1:p1", run.runId, new FakePty(1002));
    expect([again.pid, again.alive]).toEqual([1002, true]);
    const activity = (await w.journal.activity(run.runId))._unsafeUnwrap();
    expect(activity.map((a) => a.text)).toEqual(["session fake-1 exited with 3 (pane w1:p1)"]);
  });

  test("no output for the threshold with no open question is idleness, once; output ends it", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = new FakePty(1001);
    w.start("w1:p1", run.runId, pty);
    const seen: PtyEvent[] = [];
    w.broker.subscribe("w1:p1", (e) => seen.push(e));
    expect(w.timers.map((t) => t.ms)).toEqual([5000]);
    w.timers[0]?.fn();
    await Bun.sleep(5);
    expect(w.broker.status("w1:p1")?.idle).toBe(true);
    expect(seen).toEqual([{ type: "idle" }]);
    const idle = (await w.journal.activity(run.runId))._unsafeUnwrap().filter((a) => a.type === "idle");
    expect(idle.map((a) => [a.origin, a.text])).toEqual([
      ["pty", "no output for 5 s and no open question (pane w1:p1)"],
    ]);
    pty.print("…");
    expect(w.broker.status("w1:p1")?.idle).toBe(false);
    // An open question means the session waits for a person, not that it idles.
    await w.journal.ask(run.runId, {
      stage: "build",
      source: "agent",
      prompt: "Which?",
      options: [{ label: "A" }],
      multiSelect: false,
    });
    w.timers.at(-1)?.fn();
    await Bun.sleep(5);
    expect(w.broker.status("w1:p1")?.idle).toBe(false);
  });

  test("a nudge types into an agent-driven pane and never over a person; close kills and forgets", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = new FakePty(1001);
    w.start("w1:p1", run.runId, pty);
    expect((await w.broker.nudge("w1:p1", "go on")).isOk()).toBe(true);
    expect(pty.typed).toEqual(["go on\r"]);
    await w.lock.attach({ runId: run.runId, by: "maciej" });
    expect((await w.broker.nudge("w1:p1", "go on"))._unsafeUnwrapErr().message).toContain(
      "no nudge over a person",
    );
    expect(w.broker.close("w1:p1")._unsafeUnwrap()).toEqual({ closed: true });
    expect([pty.killed, w.broker.status("w1:p1"), w.broker.close("w1:p1")._unsafeUnwrap()]).toEqual([
      true,
      undefined,
      { closed: false },
    ]);
  });

  test("a hook heartbeat stamps the pane, ends idleness and starts the idle timer over; only a live pane has one", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = new FakePty(1001);
    w.start("w1:p1", run.runId, pty);
    expect(w.broker.status("w1:p1")?.lastHookAt).toBeUndefined();
    w.timers.at(-1)?.fn();
    await Bun.sleep(5);
    expect(w.broker.status("w1:p1")?.idle).toBe(true);
    const armed = w.timers.at(-1);
    expect(w.broker.heartbeat("w1:p1").isOk()).toBe(true);
    const view = w.broker.status("w1:p1");
    expect([view?.idle, view?.lastHookAt]).toEqual([false, "2026-11-02T10:00:00.000Z"]);
    expect(w.timers.at(-1)).not.toBe(armed);
    pty.exit(0);
    expect(w.broker.heartbeat("w1:p1")._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect(w.broker.heartbeat("w9:p9")._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});
