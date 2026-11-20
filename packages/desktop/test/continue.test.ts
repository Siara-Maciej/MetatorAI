import { describe, expect, test } from "bun:test";
import type { InboxItem, PaneView } from "../src/api.ts";
import { commandText, needsQueue, paneStateOf, type Run } from "../src/model.ts";
import {
  continueText,
  isEnded,
  pausedBanner,
  pausedOf,
  subBadge,
  terminalTasks,
  toContinue,
} from "../src/terminals.ts";

const run = (runId: string, extra: Partial<Run> = {}): Run =>
  ({ runId, task: `task ${runId}`, status: "active", driving: false, ...extra }) as Run;
let n = 0;
const pane = (extra: Record<string, unknown>): PaneView =>
  ({
    id: `w1:p${++n}`,
    tab: "w1:t1",
    role: "worker",
    label: "pane",
    cwd: "/x",
    process: { kind: "host", host: "claude", agent: "mt-implementer", prompt: "", sessionId: `c${n}` },
    createdAt: "2026-11-20T10:00:00.000Z",
    live: { alive: true, sessionId: `s${n}`, lastOutputAt: "2026-11-20T10:00:00.000Z" },
    state: { state: "working" },
    ...extra,
  }) as never;
const stopped = { at: "2026-11-20T10:05:00.000Z", why: "daemon-stopped" };
const gone = { alive: false, sessionId: "x" };

describe("a paused pane (round 11)", () => {
  test("is not ended: it reads paused, says why in the neutral banner, and continues in place", () => {
    const p = pane({ paused: stopped, live: gone });
    expect(pausedOf(p)?.why).toBe("daemon-stopped");
    expect(isEnded(p)).toBe(false);
    expect(paneStateOf(p as never)).toBe("paused");
    expect(pausedBanner(p)).toBe("Paused — the daemon stopped");
    expect(pausedBanner(pane({ paused: { at: "", why: "process-lost" }, live: gone }))).toBe(
      "Paused — its process was lost",
    );
    // An ended pane stays ended, paused or not; a live one is neither.
    expect(paneStateOf(pane({ paused: stopped, ended: { at: "", reason: "collected" } }) as never)).toBe(
      "finished",
    );
    expect(pausedBanner(pane({}))).toBeUndefined();
  });

  test("a session's badge counts its paused sub-terminals", () => {
    const subs = [pane({ paused: stopped, live: gone }), pane({ paused: stopped, live: gone }), pane({})];
    expect(subBadge({ subs } as never)).toBe("3 sub-terminals · 1 working · 2 paused");
  });
});

describe("Continue task (round 11)", () => {
  const runs = [
    run("sys", { children: ["api", "web"], repo: "shop-api", driving: true }),
    run("api", { parent: "sys", repo: "shop-api" }),
    run("web", { parent: "sys", repo: "shop-web" }),
  ];
  test("offered while a terminal of the task is paused or one of its runs has nothing driving it", () => {
    const apiConductor = pane({ role: "conductor", runId: "api", repo: "shop-api" });
    const webConductor = pane({ role: "conductor", runId: "web", repo: "shop-web" });
    const worker = pane({ runId: "api", repo: "shop-api", paused: stopped, live: gone });
    const t = terminalTasks(runs, [apiConductor, webConductor, worker])[0];
    expect(toContinue(t as never, runs)).toEqual({ paused: 1, undriven: 0 });
    // The web session's conductor paused: its run has nothing driving it any more.
    const pausedWeb = pane({
      role: "conductor",
      runId: "web",
      repo: "shop-web",
      paused: stopped,
      live: gone,
    });
    const t2 = terminalTasks(runs, [apiConductor, pausedWeb])[0];
    expect(toContinue(t2 as never, runs)).toEqual({ paused: 1, undriven: 1 });
    // Everything live and driven: nothing to continue; a finished run is not undriven.
    const t3 = terminalTasks(runs, [apiConductor, webConductor])[0];
    expect(toContinue(t3 as never, runs)).toEqual({ paused: 0, undriven: 0 });
    const done = runs.map((r) => (r.runId === "web" ? { ...r, status: "done" as const } : r));
    expect(toContinue(terminalTasks(done, [apiConductor])[0] as never, done)).toEqual({
      paused: 0,
      undriven: 0,
    });
  });

  test("its notice says what it resumed and what it skipped", () => {
    expect(
      continueText({
        resumed: [
          { paneId: "w1:p1", role: "conductor" },
          { paneId: "w1:p2", role: "worker" },
        ],
        drives: [{ runId: "sys", host: "claude" }],
        skipped: [{ paneId: "w2:p1", why: "its run is done" }],
      }),
    ).toBe("Continued: resumed 2 terminals, restarted 1 drive. Skipped 1: w2:p1 (its run is done).");
    expect(continueText({ resumed: [], drives: [], skipped: [] })).toBe("Nothing needed continuing.");
  });
});

describe("a host's command on a card (round 11)", () => {
  const long =
    'metator run delegate build --agent mt-implementer --card "Add src/currency.ts exporting the list of\n  supported currencies; a test first; summary of at most 10 lines." --run 20261120-mt-feature-x';
  test("the start of the whole command, cut to about two lines with …, the whole one a click away", () => {
    const c = commandText({ prompt: 'summary of at most 10 lines." --run …', command: long });
    expect(c.short.startsWith("metator run delegate build --agent mt-implementer")).toBe(true);
    expect(c.short.endsWith("…")).toBe(true);
    expect(c.short.length).toBeLessThanOrEqual(160);
    expect(c.full).toBe(long);
    expect(c.cut).toBe(true);
    // A short one is whole; without a command the prompt is shown.
    expect(commandText({ prompt: "Bash: ls src", command: "ls src" })).toEqual({
      short: "ls src",
      full: "ls src",
      cut: false,
    });
    expect(commandText({ prompt: "Bash: ls src" }).short).toBe("Bash: ls src");
  });

  test("the queue's line of a host's question is the start of its command too", () => {
    const item = {
      runId: "r",
      repo: "shop-api",
      stage: "build",
      waitedMs: 0,
      driving: false,
      question: {
        id: "q1",
        runId: "r",
        source: "permission",
        prompt: 'mt-orchestrator waits for your answer in pane w1:p1: mode" below: Run shell command',
        command: long,
        options: [{ label: "Yes" }],
        askedAt: "",
      },
    } as unknown as InboxItem;
    const title = needsQueue([item], [])[0]?.title ?? "";
    expect(title.startsWith("metator run delegate build")).toBe(true);
    expect(title).not.toContain('mode" below');
  });
});
