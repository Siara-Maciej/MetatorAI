import { afterEach, describe, expect, test } from "bun:test";
import { type LayoutView, ok, type SupervisorReport } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { COALESCE_MS, createEventHub, type EventMessage, TOPICS, topic } from "../src/serve/events.ts";
import { type Call, dispatcher, type Route, route } from "../src/serve/http.ts";
import { paneTopics, ROUTE_TOPICS, routeTopics, UNKNOWN_ROUTE } from "../src/serve/route-topics.ts";
import { ROUTES } from "../src/serve/server.ts";
import { createSweep, layoutSignature } from "../src/serve/sweep.ts";
import { startTimers, supervisorTopics, topicsOf } from "../src/serve/timers.ts";

/** A hand-run clock: what `after` scheduled runs when the test says so. */
function manual() {
  const due: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    due,
    after: (ms: number, fn: () => void) => {
      const t = { ms, fn, cancelled: false };
      due.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    /** Runs everything scheduled that is still on. */
    run: () => {
      for (const t of due.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

describe("the event hub (ADR-0110)", () => {
  test("a subscriber gets hello with the epoch and the last seq first", () => {
    const clock = manual();
    const hub = createEventHub({ after: clock.after, epoch: "e1" });
    const seen: EventMessage[] = [];
    hub.subscribe((m) => seen.push(m));
    expect(seen).toEqual([{ type: "hello", epoch: "e1", seq: 0 }]);
    hub.publish(["state"]);
    clock.run();
    const late: EventMessage[] = [];
    hub.subscribe((m) => late.push(m));
    expect(late).toEqual([{ type: "hello", epoch: "e1", seq: 1 }]);
  });

  test("what is published within the window goes out as one message, sorted and each once", () => {
    const clock = manual();
    const hub = createEventHub({ after: clock.after, epoch: "e1" });
    const seen: EventMessage[] = [];
    hub.subscribe((m) => seen.push(m));
    hub.publish(["layout", "state"]);
    hub.publish(["inbox", "state", ""]);
    hub.publish([]);
    // One flush scheduled for the whole window, at the window's length.
    expect(clock.due.map((t) => t.ms)).toEqual([COALESCE_MS]);
    expect(seen).toHaveLength(1);
    clock.run();
    expect(seen.slice(1)).toEqual([
      { type: "changed", epoch: "e1", seq: 1, topics: ["inbox", "layout", "state"] },
    ]);
    hub.publish(["activity:r1"]);
    clock.run();
    expect(seen.at(-1)).toEqual({ type: "changed", epoch: "e1", seq: 2, topics: ["activity:r1"] });
    expect(hub.seq()).toBe(2);
  });

  test("nothing published sends nothing; seq moves even with nobody listening; unsubscribed hears nothing", () => {
    const clock = manual();
    const hub = createEventHub({ after: clock.after });
    hub.publish([]);
    expect(clock.due).toEqual([]);
    hub.publish(["state"]);
    clock.run();
    expect(hub.seq()).toBe(1);
    const seen: EventMessage[] = [];
    const off = hub.subscribe((m) => seen.push(m));
    off();
    hub.publish(["inbox"]);
    clock.run();
    expect(seen.map((m) => m.type)).toEqual(["hello"]);
    expect(hub.seq()).toBe(2);
  });

  test("each daemon start has its own epoch; stop drops what waits", () => {
    const clock = manual();
    const a = createEventHub({ after: clock.after });
    const b = createEventHub({ after: clock.after });
    expect(a.epoch).not.toBe(b.epoch);
    const seen: EventMessage[] = [];
    a.subscribe((m) => seen.push(m));
    a.publish(["state"]);
    a.stop();
    clock.run();
    expect(seen.map((m) => m.type)).toEqual(["hello"]);
    expect(a.seq()).toBe(0);
  });

  test("with the real clock, a burst is one message after the window", async () => {
    const hub = createEventHub({ windowMs: 20 });
    const seen: EventMessage[] = [];
    hub.subscribe((m) => seen.push(m));
    hub.publish(["state"]);
    await Bun.sleep(5);
    hub.publish(["inbox"]);
    await Bun.sleep(60);
    expect(seen.slice(1)).toEqual([
      { type: "changed", epoch: hub.epoch, seq: 1, topics: ["inbox", "state"] },
    ]);
  });
});

describe("topics", () => {
  test("a repo-scoped topic carries its repository in a folder; one spanning the daemon never does", () => {
    expect(topic("layout")).toBe("layout");
    expect(topic("layout", { repo: "shop" })).toBe("layout@shop");
    expect(topic("state", { repo: "shop" })).toBe("state");
    expect(topic("inbox", { repo: "shop" })).toBe("inbox");
    expect(topic("activity", { runId: "r1" })).toBe("activity:r1");
    expect(topic("activity", { runId: "r1", repo: "shop" })).toBe("activity:r1@shop");
    expect(Object.keys(TOPICS)).toEqual([
      "state",
      "inbox",
      "layout",
      "threads",
      "options",
      "plans",
      "reviews",
      "backlog",
      "activity",
    ]);
  });
});

describe("what a request publishes, by its route", () => {
  test("each kind of route names its topics; a run's route names its activity", () => {
    expect(routeTopics("/runs", {})).toEqual(["state", "inbox", "layout"]);
    expect(routeTopics("/runs/:run/answer", { run: "r1" })).toEqual([
      "state",
      "inbox",
      "layout",
      "activity:r1",
    ]);
    expect(routeTopics("/runs/:run/plan/lint", { run: "r1" })).toEqual(["plans", "state"]);
    expect(routeTopics("/panes", {})).toEqual(["layout"]);
    expect(routeTopics("/panes/:pane/close", { pane: "w1:p1" })).toEqual(["layout"]);
    expect(routeTopics("/panes/:pane/answer", { pane: "w1:p1" })).toEqual(["layout", "inbox", "state"]);
    expect(routeTopics("/tabs/:tab/tree", {})).toEqual(["layout"]);
    expect(routeTopics("/workspaces/:workspace/close", {})).toEqual(["layout"]);
    expect(routeTopics("/threads", {})).toEqual(["threads", "layout", "state"]);
    expect(routeTopics("/threads/:id/close", {})).toEqual(["threads", "layout", "state"]);
    expect(routeTopics("/options/:key+", {})).toEqual(["options"]);
    expect(routeTopics("/issues", {})).toEqual(["backlog"]);
    expect(routeTopics("/issues/:issue/start", {})).toEqual(["backlog", "state", "inbox", "layout"]);
    expect(routeTopics("/system/plans/:plan/approve", {})).toEqual(["plans", "state", "inbox"]);
    expect(routeTopics("/system/map", {})).toEqual(["plans", "state", "inbox"]);
    expect(routeTopics("/reviews/:id/dismiss", {})).toEqual(["reviews", "inbox", "state", "layout"]);
    expect(routeTopics("/mrs/:request/send", {})).toEqual(["reviews", "inbox", "state", "layout"]);
    expect(routeTopics("/scratch/drop", {})).toEqual(["state"]);
  });

  test("in a folder the repo-scoped topics carry the repository", () => {
    expect(routeTopics("/runs/:run/stop", { run: "r1" }, "shop")).toEqual([
      "state",
      "inbox",
      "layout@shop",
      "activity:r1@shop",
    ]);
    expect(routeTopics("/options/:key+", {}, "shop")).toEqual(["options@shop"]);
  });

  test("a route no row names publishes the state, the inbox and the layout", () => {
    expect(UNKNOWN_ROUTE).toEqual(["state", "inbox", "layout"]);
    expect(routeTopics("/somewhere/new", {})).toEqual(["state", "inbox", "layout"]);
  });

  test("every route of the daemon that changes something has its own row", () => {
    const changing = ROUTES.filter((r) => r.method !== "GET").map((r) => r.pattern);
    const unnamed = changing.filter((p) => !ROUTE_TOPICS.some((row) => row.pattern.test(p)));
    expect(unnamed).toEqual([]);
    expect(changing.length).toBeGreaterThan(50);
  });

  test("the dispatcher tells of every answered request that is not a GET, with its params", async () => {
    const told: [string, Readonly<Record<string, string>>][] = [];
    const routes: Route[] = [
      route({ method: "GET", pattern: "/runs/:run/board", handler: () => ok({}) }),
      route({ method: "POST", pattern: "/runs/:run/stop", handler: () => ok({}) }),
    ];
    const dispatch = dispatcher(routes, {
      daemon: {} as never,
      containerFor: () => ok({} as MetatorContainer),
      answered: (r: Route, call: Call) => told.push([r.pattern, call.params]),
    });
    for (const [method, path] of [
      ["GET", "/runs/r1/board"],
      ["POST", "/runs/r1/stop"],
      ["POST", "/nowhere"],
    ] as const) {
      const url = new URL(`http://localhost${path}`);
      await dispatch(new Request(url, { method, ...(method === "POST" ? { body: "{}" } : {}) }), url, path);
    }
    expect(told).toEqual([["/runs/:run/stop", { run: "r1" }]]);
  });
});

describe("what the daemon's own sources publish", () => {
  test("a pane's change is the layout; a run's pane also its state and activity", () => {
    expect(paneTopics({ paneId: "w1:p1", change: "started" })).toEqual(["layout"]);
    expect(paneTopics({ paneId: "w1:p1", runId: "r1", change: "exited" })).toEqual([
      "layout",
      "state",
      "activity:r1",
    ]);
    expect(paneTopics({ paneId: "w1:p1", runId: "r1", change: "idle" }, "shop")).toEqual([
      "layout@shop",
      "state",
      "activity:r1@shop",
    ]);
  });

  const report = (over: Partial<SupervisorReport> = {}): SupervisorReport => ({
    revived: [],
    gaveUp: [],
    nudged: [],
    asked: [],
    closed: [],
    attention: { waiting: 0, limit: 3, over: false },
    resumed: [],
    unreadable: [],
    ...over,
  });

  test("a supervisor's tick that did something publishes its runs; one that did nothing, nothing", () => {
    expect(supervisorTopics(report())).toEqual([]);
    expect(supervisorTopics(report({ prompts: { asked: [], attached: [], resolved: [] } }))).toEqual([]);
    expect(supervisorTopics(report({ nudged: ["w1:p1"] }))).toEqual(["state", "inbox", "layout"]);
    expect(
      supervisorTopics(
        report({ prompts: { asked: [{ paneId: "p", questionId: "q" }], attached: [], resolved: [] } }),
      ),
    ).toEqual(["state", "inbox", "layout"]);
    expect(
      supervisorTopics(
        report({
          revived: [{ runId: "r1", stage: "build", attempt: 1 }],
          resumed: [{ runId: "r1", paneId: "p", attempt: 1 }],
          gaveUp: ["r2"],
        }),
        "shop",
      ),
    ).toEqual(["state", "inbox", "layout@shop", "activity:r1@shop", "activity:r2@shop"]);
    expect(topicsOf(["threads"], ["r9"])).toEqual(["threads", "activity:r9"]);
  });

  const real = globalThis.setInterval;
  afterEach(() => {
    globalThis.setInterval = real;
  });

  test("the sweep of finished panes publishes what it ended, told, noted, mailed and resumed", async () => {
    const ticks: (() => void)[] = [];
    globalThis.setInterval = ((fn: () => void) => {
      ticks.push(fn);
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    let busy = true;
    const c = {
      resolve: (name: string) =>
        ({
          config: {
            config: {
              intake: { everyMs: 0, rules: [] },
              reviews: { everyMs: 0 },
              codehost: { sources: [], review: { watch: false, everyMs: 0 } },
            },
          },
          panes: { endFinished: async () => ok(busy ? [{ ended: "w1:p1", runId: "r1" }] : []) },
          chatNotices: {
            tick: async () => ok(busy ? [{ paneId: "w2:p1", runId: "r1", event: "done" }] : []),
          },
          threads: { noteRuns: async () => ok(busy ? [{ thread: "t1", runId: "r1", event: "done" }] : []) },
          paneMail: { tick: async () => ok([]) },
          resumeNotices: { tick: async () => ok(busy ? [{ paneId: "w1:p2", runId: "r3" }] : []) },
        })[name],
    } as unknown as MetatorContainer;
    const published: string[][] = [];
    const timers = startTimers({
      repos: () => ["shop"],
      containerFor: () => ok(c),
      superviseMs: 0,
      intakeMs: 0,
      reviewsMs: 0,
      sweepMs: 1000,
      changed: (t) => published.push([...t]),
    });
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      ticks[0]?.();
      await Bun.sleep(10);
      expect(published).toEqual([
        ["layout@shop", "state"],
        ["layout@shop"],
        ["threads", "state"],
        ["layout@shop", "state", "activity:r3@shop"],
      ]);
      busy = false;
      published.length = 0;
      ticks[0]?.();
      await Bun.sleep(10);
      expect(published).toEqual([]);
    } finally {
      process.stderr.write = stderr;
      timers.stop();
    }
  });
});

describe("the daemon's one sweep", () => {
  function sweepWith(texts: Map<string, string>) {
    const changed: string[][] = [];
    const every: { ms: number; fn: () => void; stopped: boolean }[] = [];
    let reads = 0;
    const sweep = createSweep({
      everyMs: 100,
      read: async () => {
        reads += 1;
        return new Map(texts);
      },
      changed: (t) => changed.push([...t]),
      every: (ms, fn) => {
        const t = { ms, fn, stopped: false };
        every.push(t);
        return () => {
          t.stopped = true;
        };
      },
    });
    return { sweep, changed, every, reads: () => reads };
  }

  test("the first look only learns; a text that differs after is its topic changed", async () => {
    const texts = new Map([
      ["state", "s1"],
      ["inbox", "i1"],
      ["layout", "l1"],
    ]);
    const w = sweepWith(texts);
    const release = w.sweep.hold();
    await w.sweep.tick();
    expect(w.changed).toEqual([]);
    texts.set("state", "s2");
    texts.set("layout", "l2");
    await w.sweep.tick();
    expect(w.changed).toEqual([["state", "layout"]]);
    await w.sweep.tick();
    expect(w.changed).toHaveLength(1);
    release();
  });

  test("it runs only while held: one clock for every holder, stopped when the last lets go, and it forgets", async () => {
    const texts = new Map([["state", "s1"]]);
    const w = sweepWith(texts);
    expect(w.every).toEqual([]);
    const a = w.sweep.hold();
    const b = w.sweep.hold();
    expect(w.every.map((t) => [t.ms, t.stopped])).toEqual([[100, false]]);
    a();
    a();
    expect(w.every[0]?.stopped).toBe(false);
    b();
    expect(w.every[0]?.stopped).toBe(true);
    // Held again: the first look learns again, a change while nobody held it is not announced.
    texts.set("state", "s2");
    w.sweep.hold();
    await w.sweep.tick();
    expect(w.changed).toEqual([]);
  });

  test("a listener gets each text that differs, the first one too; a look under way is not started twice", async () => {
    const texts = new Map([["state", "s1"]]);
    const w = sweepWith(texts);
    const heard: string[] = [];
    const off = w.sweep.listen("state", (t) => heard.push(t));
    await w.sweep.tick();
    texts.set("state", "s2");
    await Promise.all([w.sweep.tick(), w.sweep.tick()]);
    expect(heard).toEqual(["s1", "s2"]);
    const before = w.reads();
    await Promise.all([w.sweep.tick(), w.sweep.tick()]);
    expect(w.reads()).toBe(before + 1);
    off();
    expect(w.every[0]?.stopped).toBe(true);
  });

  test("a read that fails is skipped; the next look goes on", async () => {
    let fail = true;
    const changed: string[][] = [];
    const sweep = createSweep({
      everyMs: 100,
      read: async () => {
        if (fail) throw new Error("disk");
        return new Map([["state", "s"]]);
      },
      changed: (t) => changed.push([...t]),
      every: () => () => {},
    });
    sweep.hold();
    await sweep.tick();
    fail = false;
    await sweep.tick();
    expect(changed).toEqual([]);
    sweep.stop();
  });

  test("the layout's signature ignores what moves on its own and keeps what a person sees change", () => {
    const pane = {
      id: "w1:p1",
      workspace: "w1",
      label: "conductor",
      role: "conductor",
      process: { kind: "command", argv: ["sh"] },
    };
    const live = (at: string, idle = false) => ({
      paneId: "w1:p1",
      role: "conductor" as const,
      host: "fake",
      sessionId: "s1",
      pid: 1,
      alive: true,
      idle,
      lastOutputAt: at,
    });
    const view = (l: ReturnType<typeof live>, state: { state: string; reason: string }) =>
      ({ workspaces: [], panes: [{ ...pane, live: l, state }] }) as unknown as LayoutView;
    const quiet1 = layoutSignature(
      view(live("2026-11-02T10:00:00Z"), { state: "idle", reason: "quiet for 3 s" }),
    );
    const quiet2 = layoutSignature(
      view(live("2026-11-02T10:00:09Z"), { state: "idle", reason: "quiet for 9 s" }),
    );
    expect(quiet2).toBe(quiet1);
    const working = layoutSignature(
      view(live("2026-11-02T10:00:09Z"), { state: "working", reason: "output just now" }),
    );
    expect(working).not.toBe(quiet1);
    const asks = (reason: string) =>
      layoutSignature(view(live("2026-11-02T10:00:09Z"), { state: "blocked", reason }));
    expect(asks("Bash: ls")).not.toBe(asks("Bash: rm"));
    expect(
      layoutSignature(view(live("2026-11-02T10:00:09Z", true), { state: "idle", reason: "x" })),
    ).not.toBe(quiet1);
  });
});
