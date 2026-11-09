import { describe, expect, test } from "bun:test";
import {
  CLOSE_SESSION,
  DEFAULT_PATHS,
  DriverLock,
  err,
  InitRun,
  MetatorError,
  NUDGE,
  NUDGE_AGAIN,
  ok,
  PtyBroker,
  RunJournal,
  RunRepository,
  Supervisor,
  SupervisorPolicySchema,
  WorkflowCatalog,
} from "@metator/core";
import { FakePty, FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world(over: Partial<ReturnType<typeof SupervisorPolicySchema.parse>> = {}) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-02T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  /** The conductor panes started, in order, like a FakeInteractiveHost would record them. */
  const started: { pty: FakePty }[] = [];
  const timers: { fn: () => void }[] = [];
  const broker = new PtyBroker({
    repo,
    journal,
    idleMs: 1000,
    after: (_ms, fn) => {
      const t = { fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  /** Which runs have a driver file, and whether that process lives. */
  const drives = new Map<string, { pid: number; alive: boolean }>();
  const restarted: string[] = [];
  const waiting = { you: 0 };
  const supervisor = new Supervisor({
    policy: SupervisorPolicySchema.parse(over),
    repo,
    drivers: {
      status: async (runId) => {
        const d = drives.get(runId);
        return ok(d ? { pid: d.pid, host: "fake", startedAt: "x", alive: d.alive } : null);
      },
    },
    journal,
    broker,
    overview: {
      execute: async () =>
        ok({
          runs: Array.from({ length: waiting.you }, () => ({ attention: "you" as const })),
          conversations: [],
          counts: {},
        }) as never,
    },
    restart: async (runId) => {
      restarted.push(runId);
      drives.set(runId, { pid: 99, alive: true });
      return ok({ stage: "build" });
    },
  });
  const init = (task: string) => new InitRun(catalog, repo, clock).execute({ workflow: "demo", task });
  const idle = async () => {
    timers.at(-1)?.fn();
    await Bun.sleep(5);
  };
  const open = (runId: string) => {
    const pty = new FakePty(1000 + started.length + 1);
    started.push({ pty });
    return broker
      .start({ paneId: "w1:p1", runId, role: "conductor", host: "fake", sessionId: "fake-1", pty })
      ._unsafeUnwrap();
  };
  const host = { started };
  return {
    fs,
    repo,
    journal,
    host,
    broker,
    timers,
    drives,
    restarted,
    waiting,
    supervisor,
    init,
    idle,
    lock: new DriverLock(repo, journal, clock),
    open,
  };
}

describe("Supervisor", () => {
  test("a drive that died is started again, up to the policy's attempts, then the supervisor says it gave up", async () => {
    const w = world({ respawn: { enabled: true, maxAttempts: 2 } });
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    w.drives.set(run.runId, { pid: 1, alive: false });
    const first = (await w.supervisor.tick())._unsafeUnwrap();
    expect([first.revived, first.gaveUp]).toEqual([[{ runId: run.runId, stage: "build", attempt: 1 }], []]);
    expect(w.restarted).toEqual([run.runId]);
    // Alive now: nothing to do.
    expect((await w.supervisor.tick())._unsafeUnwrap().revived).toEqual([]);
    w.drives.set(run.runId, { pid: 99, alive: false });
    expect((await w.supervisor.tick())._unsafeUnwrap().revived[0]?.attempt).toBe(2);
    w.drives.set(run.runId, { pid: 99, alive: false });
    const third = (await w.supervisor.tick())._unsafeUnwrap();
    expect([third.revived, third.gaveUp]).toEqual([[], [run.runId]]);
    expect(w.restarted.length).toBe(2);
    const activity = (await w.journal.activity(run.runId))._unsafeUnwrap();
    expect(activity.map((a) => a.type)).toEqual(["restart", "restart", "error"]);
    expect(activity.at(-1)?.text).toContain(
      "gave up: its drive died 2 time(s), the policy allows 2 restart(s)",
    );
    // Said once: another tick adds no second error line.
    await w.supervisor.tick();
    expect((await w.journal.activity(run.runId))._unsafeUnwrap().length).toBe(3);
    // A drive that left on purpose (no file) and a finished run are left alone.
    const w2 = world({ respawn: { enabled: false, maxAttempts: 3 } });
    const r2 = (await w2.init("x"))._unsafeUnwrap();
    w2.drives.set(r2.runId, { pid: 1, alive: false });
    expect((await w2.supervisor.tick())._unsafeUnwrap().revived).toEqual([]);
  });

  test("an idle session is nudged once; still idle, a person is asked; their answer closes it or nudges again", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    w.open(run.runId);
    const pty = w.host.started[0]?.pty;
    await w.idle();
    const first = (await w.supervisor.tick())._unsafeUnwrap();
    expect([first.nudged, first.asked]).toEqual([[run.runId], []]);
    expect(pty?.typed).toEqual([`${NUDGE}\r`]);
    expect(w.broker.status("w1:p1")?.idle).toBe(false);
    // Idle again after the nudge: the person is asked, once.
    await w.idle();
    const second = (await w.supervisor.tick())._unsafeUnwrap();
    expect([second.nudged, second.asked]).toEqual([[], [run.runId]]);
    expect((await w.supervisor.tick())._unsafeUnwrap().asked).toEqual([]);
    const q = (await w.journal.questions(run.runId))._unsafeUnwrap()[0];
    expect(q?.options.map((o) => o.label)).toEqual([NUDGE_AGAIN, CLOSE_SESSION, "Other"]);
    await w.journal.answer(run.runId, q?.id as string, { choices: [NUDGE_AGAIN], by: "maciej" });
    const third = (await w.supervisor.tick())._unsafeUnwrap();
    expect(third.nudged).toEqual([run.runId]);
    expect(pty?.typed.length).toBe(2);
    // Idle once more, asked again; this time: close.
    await w.idle();
    await w.supervisor.tick();
    const again = (await w.journal.questions(run.runId))._unsafeUnwrap().find((x) => !x.answer);
    await w.journal.answer(run.runId, again?.id as string, { choices: [CLOSE_SESSION], by: "maciej" });
    const fourth = (await w.supervisor.tick())._unsafeUnwrap();
    expect(fourth.closed).toEqual([run.runId]);
    expect(pty?.killed).toBe(true);
    const idle = (await w.journal.activity(run.runId))._unsafeUnwrap().filter((a) => a.type === "idle");
    expect(idle.map((a) => a.origin)).toEqual(["pty", "run", "pty", "pty"]);
  });

  test("a person at the keyboard is never nudged over; output ends the episode", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    w.open(run.runId);
    await w.lock.attach({ runId: run.runId, by: "maciej" });
    await w.idle();
    expect((await w.supervisor.tick())._unsafeUnwrap().nudged).toEqual([]);
    expect(w.host.started[0]?.pty.typed).toEqual([]);
    await w.lock.release({ runId: run.runId });
    expect((await w.supervisor.tick())._unsafeUnwrap().nudged).toEqual([run.runId]);
    w.host.started[0]?.pty.print("working again");
    expect((await w.supervisor.tick())._unsafeUnwrap().asked).toEqual([]);
    await w.idle();
    // A new episode after output: a nudge again, not the question.
    expect((await w.supervisor.tick())._unsafeUnwrap().nudged).toEqual([run.runId]);
  });

  test("host prompts (R3) tick with the supervisor: their report rides along, their error is the tick's", async () => {
    const w = world();
    const report = { asked: [], attached: [], resolved: ["w1:p1"] };
    const withPrompts = new Supervisor({
      policy: SupervisorPolicySchema.parse({}),
      repo: w.repo,
      drivers: { status: async () => ok(null) },
      journal: w.journal,
      broker: w.broker,
      overview: { execute: async () => ok({ runs: [], conversations: [], counts: {} }) as never },
      restart: async () => ok({ stage: "build" }),
      prompts: { tick: async () => ok(report) },
    });
    expect((await withPrompts.tick())._unsafeUnwrap().prompts).toEqual(report);
    expect((await w.supervisor.tick())._unsafeUnwrap().prompts).toBeUndefined();
    const failing = new Supervisor({
      policy: SupervisorPolicySchema.parse({}),
      repo: w.repo,
      drivers: { status: async () => ok(null) },
      journal: w.journal,
      broker: w.broker,
      overview: { execute: async () => ok({ runs: [], conversations: [], counts: {} }) as never },
      restart: async () => ok({ stage: "build" }),
      prompts: { tick: async () => err(new MetatorError("COMMAND_FAILED", "the screen could not be read")) },
    });
    expect((await failing.tick())._unsafeUnwrapErr().message).toBe("the screen could not be read");
  });

  test("the attention budget: how many runs wait for a person against the WIP limit", async () => {
    const w = world({ wipLimit: 2 });
    w.waiting.you = 3;
    expect((await w.supervisor.tick())._unsafeUnwrap().attention).toEqual({
      waiting: 3,
      limit: 2,
      over: true,
    });
    w.waiting.you = 2;
    expect((await w.supervisor.tick())._unsafeUnwrap().attention.over).toBe(false);
  });
});
