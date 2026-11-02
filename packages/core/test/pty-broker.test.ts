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
import { FakeInteractiveHost, FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-02T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const host = new FakeInteractiveHost("fake");
  const timers: { ms: number; fn: () => void }[] = [];
  const broker = new PtyBroker({
    repo,
    journal,
    hosts: new Map([["fake", host]]),
    clock,
    root: "/repo",
    idleMs: 5000,
    after: (ms, fn) => {
      const t = { ms, fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  const init = (task: string) => new InitRun(catalog, repo, clock).execute({ workflow: "demo", task });
  return { fs, repo, journal, host, broker, timers, init, lock: new DriverLock(repo, journal, clock) };
}

describe("PtyBroker", () => {
  test("open starts the host with the run's task in its checkout, remembers the session, fans output out", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const view = (await w.broker.open({ runId: run.runId }))._unsafeUnwrap();
    expect(view).toEqual({
      runId: run.runId,
      host: "fake",
      sessionId: "fake-1",
      pid: 1001,
      alive: true,
      idle: false,
    });
    const started = w.host.started[0];
    expect([started?.task.prompt, started?.task.cwd, started?.task.driven]).toEqual([
      "Add discount",
      "/repo",
      true,
    ]);
    expect((await w.repo.load(run.runId))._unsafeUnwrap()).toMatchObject({
      host: "fake",
      hostSession: "fake-1",
    });
    const seen: PtyEvent[] = [];
    const stop = w.broker.subscribe(run.runId, (e) => seen.push(e));
    started?.pty.print("hello ");
    started?.pty.print("world");
    expect(w.broker.backlog(run.runId)).toBe("hello world");
    expect(seen).toEqual([
      { type: "data", data: "hello " },
      { type: "data", data: "world" },
    ]);
    stop();
    // Opening again while alive is the same session; nothing new starts.
    expect((await w.broker.open({ runId: run.runId }))._unsafeUnwrap().sessionId).toBe("fake-1");
    expect(w.host.started.length).toBe(1);
    const activity = (await w.journal.activity(run.runId))._unsafeUnwrap();
    expect(activity.map((a) => [a.type, a.origin, a.text])).toEqual([
      ["agent", "pty", "started session fake-1 (pid 1001)"],
    ]);
  });

  test("typing goes to the PTY only from the person who holds the driver lock", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    await w.broker.open({ runId: run.runId });
    const pty = w.host.started[0]?.pty;
    const agentDriven = (
      await w.broker.write({ runId: run.runId, data: "y\r", by: "maciej" })
    )._unsafeUnwrapErr();
    expect(agentDriven.message).toContain("is driven by the agent: attach first");
    await w.lock.attach({ runId: run.runId, by: "maciej" });
    const other = (await w.broker.write({ runId: run.runId, data: "y\r", by: "alice" }))._unsafeUnwrapErr();
    expect(other.message).toContain("is driven by maciej: only they may type");
    expect((await w.broker.write({ runId: run.runId, data: "y\r", by: "maciej" })).isOk()).toBe(true);
    expect(pty?.typed).toEqual(["y\r"]);
    expect(w.broker.resize(run.runId, { cols: 100, rows: 30 }).isOk()).toBe(true);
    expect(pty?.sizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  test("an exit is noted and told to viewers; the next open resumes the session by its id", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    await w.broker.open({ runId: run.runId });
    const seen: PtyEvent[] = [];
    w.broker.subscribe(run.runId, (e) => seen.push(e));
    w.host.started[0]?.pty.exit(3);
    expect(seen).toEqual([{ type: "exit", code: 3 }]);
    expect(w.broker.status(run.runId)).toMatchObject({ alive: false, exitCode: 3 });
    expect((await w.broker.write({ runId: run.runId, data: "x", by: "m" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
    const again = (await w.broker.open({ runId: run.runId }))._unsafeUnwrap();
    expect([again.sessionId, w.host.started[1]?.resumed]).toEqual(["fake-1", "fake-1"]);
    const activity = (await w.journal.activity(run.runId))._unsafeUnwrap();
    expect(activity.map((a) => a.text)).toEqual([
      "started session fake-1 (pid 1001)",
      "session fake-1 exited with 3",
      "resumed session fake-1 (pid 1002)",
    ]);
  });

  test("no output for the threshold with no open question is idleness, once; output ends it", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    await w.broker.open({ runId: run.runId });
    const seen: PtyEvent[] = [];
    w.broker.subscribe(run.runId, (e) => seen.push(e));
    expect(w.timers.map((t) => t.ms)).toEqual([5000]);
    w.timers[0]?.fn();
    await Bun.sleep(5);
    expect(w.broker.status(run.runId)?.idle).toBe(true);
    expect(seen).toEqual([{ type: "idle" }]);
    const idle = (await w.journal.activity(run.runId))._unsafeUnwrap().filter((a) => a.type === "idle");
    expect(idle.map((a) => [a.origin, a.text])).toEqual([["pty", "no output for 5 s and no open question"]]);
    w.host.started[0]?.pty.print("…");
    expect(w.broker.status(run.runId)?.idle).toBe(false);
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
    expect(w.broker.status(run.runId)?.idle).toBe(false);
  });

  test("close kills a live session; a finished run and an unknown host are refused", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    await w.broker.open({ runId: run.runId });
    expect((await w.broker.close(run.runId))._unsafeUnwrap()).toEqual({ closed: true });
    expect(w.host.started[0]?.pty.killed).toBe(true);
    expect((await w.broker.close(run.runId))._unsafeUnwrap()).toEqual({ closed: false });
    expect((await w.broker.open({ runId: run.runId, host: "nope" }))._unsafeUnwrapErr().message).toContain(
      "unknown interactive host nope",
    );
  });
});
