import { describe, expect, test } from "bun:test";
import {
  filterValues,
  groupRows,
  NO_FILTER,
  passes,
  REPO_HUES,
  repoMark,
  rowsBelow,
  showing,
  type TerminalFilter,
  terminalRows,
  terminalTasks,
  terminalViewFromStorage,
  toggleFilter,
  toggleHidden,
  toggleTaskHidden,
} from "../src/features/terminals/terminals.ts";
import type { PaneView } from "../src/shared/api/api.ts";
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

// A task given in a chat with a session in shop-api (a worker that asks, one that finished) and
// one in billing; and a run of its own in web-app whose conductor is its main terminal.
const runs = [
  run("sys", { children: ["api", "bill"], repo: "platform", task: "Invoice discounts" }),
  run("api", { parent: "sys", repo: "shop-api" }),
  run("bill", { parent: "sys", repo: "billing" }),
  run("web", { repo: "web-app", task: "Fix the flaky checkout" }),
];
const chat = pane({ role: "apps", label: "chat", startedRun: "sys", repo: "platform" });
const api = pane({ role: "conductor", runId: "api", repo: "shop-api" });
const asking = pane({
  runId: "api",
  repo: "shop-api",
  worker: { name: "mt-implementer-1", stage: "build" },
  state: { state: "blocked" } as never,
});
const done = pane({
  runId: "api",
  repo: "shop-api",
  worker: { name: "mt-test-author-1", stage: "build" },
  live: { alive: false, sessionId: "x", exitCode: 0 } as never,
  ended: { at: "2026-11-19T10:05:00.000Z", reason: "collected" },
});
const bill = pane({ role: "conductor", runId: "bill", repo: "billing" });
const web = pane({ role: "conductor", runId: "web", repo: "web-app" });
const webWorker = pane({
  runId: "web",
  repo: "web-app",
  worker: { name: "mt-diagnostician-1", stage: "diagnose" },
});
const NOW = Date.parse("2026-11-19T10:00:01.000Z");
const tasks = terminalTasks(runs, [chat, api, asking, done, bill, web, webWorker]);
const rows = terminalRows(tasks, NOW);
const keyOf = (p: { id: string; repo?: string }) => `${p.repo}|${p.id}`;
const byPane = (p: { id: string; repo?: string }) => rows.find((r) => r.key === keyOf(p));

describe("every terminal as a row (round 22)", () => {
  test("each task's terminals in order, with repository, role, state and name", () => {
    expect(rows.map((r) => [r.repo, r.role, r.state, r.name])).toEqual([
      ["platform", "apps", "working", "main terminal"],
      ["shop-api", "conductor", "working", "shop-api · conductor"],
      ["shop-api", "worker", "asks", "mt-implementer-1"],
      ["shop-api", "worker", "finished", "mt-test-author-1"],
      ["billing", "conductor", "working", "billing · conductor"],
      ["web-app", "conductor", "working", "main terminal"],
      ["web-app", "worker", "working", "mt-diagnostician-1"],
    ]);
  });

  test("a session's conductor was started from the main terminal, a sub-terminal from its conductor", () => {
    expect(byPane(chat)?.parent).toBeUndefined();
    expect(byPane(api)?.parent).toBe(keyOf(chat));
    expect(byPane(asking)?.parent).toBe(keyOf(api));
    expect(byPane(bill)?.parent).toBe(keyOf(chat));
    // A run of its own: its conductor is the main terminal, its workers hang from it.
    expect(byPane(web)?.parent).toBeUndefined();
    expect(byPane(webWorker)?.parent).toBe(keyOf(web));
    expect(byPane(webWorker)?.session?.runId).toBe("web");
  });

  test("what is below a terminal, nearest first: the main terminal sees the asking worker", () => {
    expect(rowsBelow(rows, keyOf(chat)).map((r) => r.name)).toEqual([
      "shop-api · conductor",
      "billing · conductor",
      "mt-implementer-1",
      "mt-test-author-1",
    ]);
    expect(
      rowsBelow(rows, keyOf(chat))
        .filter((r) => r.state === "asks")
        .map((r) => r.key),
    ).toEqual([keyOf(asking)]);
    expect(rowsBelow(rows, keyOf(asking))).toEqual([]);
  });

  test("an ended pane with a non-zero code reads exited; a paused one paused", () => {
    const failed = pane({
      runId: "web",
      repo: "web-app",
      live: { alive: false, sessionId: "f", exitCode: 1 } as never,
    });
    const paused = pane({
      runId: "web",
      repo: "web-app",
      live: undefined,
      paused: { at: "x", why: "daemon-stopped" },
    } as never);
    const r = terminalRows(terminalTasks(runs, [web, failed, paused]), NOW);
    expect(r.map((x) => x.state)).toEqual(["working", "exited", "paused"]);
  });
});

describe("the filter bar", () => {
  const repos = ["platform", "shop-api", "billing", "web-app"];
  test("a click hides a value and shows it again", () => {
    const hidden = toggleFilter(NO_FILTER, "repo", "billing", false, repos);
    expect(hidden.hide.repo).toEqual(["billing"]);
    expect(rows.filter((r) => passes(r, hidden)).map((r) => r.repo)).not.toContain("billing");
    expect(toggleFilter(hidden, "repo", "billing", false, repos).hide.repo).toEqual([]);
  });

  test("hiding the last shown value shows them all: the bar never hides everything", () => {
    const one: TerminalFilter = {
      ...NO_FILTER,
      hide: { ...NO_FILTER.hide, repo: ["platform", "shop-api", "billing"] },
    };
    expect(toggleFilter(one, "repo", "web-app", false, repos).hide.repo).toEqual([]);
  });

  test("Alt+click shows only that value; Alt+click on the only one shows all; in every dimension", () => {
    for (const [d, value, values] of [
      ["repo", "shop-api", repos],
      ["state", "asks", ["working", "asks", "finished"]],
      ["role", "worker", ["apps", "conductor", "worker"]],
    ] as const) {
      const only = toggleFilter(NO_FILTER, d, value, true, values);
      expect(only.hide[d]).toEqual(values.filter((v) => v !== value));
      expect(toggleFilter(only, d, value, true, values).hide[d]).toEqual([]);
      // Alt+click on another value moves the one shown there.
      const other = values.find((v) => v !== value) as string;
      expect(toggleFilter(only, d, other, true, values).hide[d]).toEqual(values.filter((v) => v !== other));
    }
    const asks = toggleFilter(NO_FILTER, "state", "asks", true, ["working", "asks", "finished"]);
    expect(rows.filter((r) => passes(r, asks)).map((r) => r.name)).toEqual(["mt-implementer-1"]);
  });

  test("words: every word must be in the terminal's name, repository, task, role or state", () => {
    const f = (text: string) => rows.filter((r) => passes(r, { ...NO_FILTER, text })).map((r) => r.name);
    expect(f("test-author")).toEqual(["mt-test-author-1"]);
    expect(f("BILLING conductor")).toEqual(["billing · conductor"]);
    expect(f("flaky diagnostician")).toEqual(["mt-diagnostician-1"]);
    expect(f("  ")).toHaveLength(rows.length);
  });

  test("showing a hidden terminal changes the filter just enough", () => {
    const f: TerminalFilter = {
      hide: { repo: ["shop-api", "billing"], state: ["asks"], role: [] },
      text: "web",
      panes: [keyOf(asking), keyOf(bill)],
    };
    const shown = showing(f, byPane(asking) as never);
    expect(shown).toEqual({
      hide: { repo: ["billing"], state: [], role: [] },
      text: "",
      panes: [keyOf(bill)],
    });
    expect(passes(byPane(asking) as never, shown)).toBe(true);
    // Words it holds stay.
    expect(showing({ ...NO_FILTER, text: "implementer" }, byPane(asking) as never).text).toBe("implementer");
  });

  test("the chips: each value once, in the order met, with its count", () => {
    expect(filterValues(rows, "state")).toEqual([
      { value: "working", count: 5 },
      { value: "asks", count: 1 },
      { value: "finished", count: 1 },
    ]);
  });
});

describe("the tree's eye", () => {
  test("on a terminal: it and every terminal below it hidden; again: all shown", () => {
    const hidden = toggleHidden(NO_FILTER, rows, keyOf(api));
    expect(hidden.panes).toEqual([keyOf(api), keyOf(asking), keyOf(done)]);
    expect(rows.filter((r) => passes(r, hidden)).map((r) => r.name)).toEqual([
      "main terminal",
      "billing · conductor",
      "main terminal",
      "mt-diagnostician-1",
    ]);
    expect(toggleHidden(hidden, rows, keyOf(api)).panes).toEqual([]);
  });

  test("on the main terminal: the whole task's tree; a branch shown again leaves the rest hidden", () => {
    const all = toggleHidden(NO_FILTER, rows, keyOf(chat));
    expect(all.panes).toHaveLength(5);
    expect(toggleHidden(all, rows, keyOf(api)).panes).toEqual([keyOf(chat), keyOf(bill)]);
  });

  test("a click on a hidden terminal shows only it, the rest of its branch stays hidden", () => {
    const hidden = toggleHidden(NO_FILTER, rows, keyOf(api));
    expect(showing(hidden, byPane(asking) as never).panes).toEqual([keyOf(api), keyOf(done)]);
  });

  test("on a task: every terminal of the task, or all of them shown when all are hidden", () => {
    const one = toggleTaskHidden(NO_FILTER, rows, "web");
    expect(one.panes).toEqual([keyOf(web), keyOf(webWorker)]);
    expect(toggleTaskHidden(one, rows, "web").panes).toEqual([]);
    // Partly hidden: the eye hides the rest.
    const partly = toggleHidden(NO_FILTER, rows, keyOf(webWorker));
    expect(toggleTaskHidden(partly, rows, "web").panes).toEqual([keyOf(webWorker), keyOf(web)]);
    expect(toggleTaskHidden(NO_FILTER, rows, "nothing").panes).toEqual([]);
  });
});

describe("groups", () => {
  test("by task: its main terminal, then a group per repository session", () => {
    const g = groupRows(rows, "task");
    expect(g.map((x) => [x.title, x.rows.map((r) => r.name)])).toEqual([
      ["Invoice discounts", ["main terminal"]],
      ["Fix the flaky checkout", ["main terminal"]],
    ]);
    expect(g[0]?.sessions?.map((s) => [s.title, s.repo, s.rows.length])).toEqual([
      ["shop-api session", "shop-api", 3],
      ["billing session", "billing", 1],
    ]);
    expect(g[1]?.sessions?.map((s) => [s.title, s.rows.map((r) => r.name)])).toEqual([
      ["web-app session", ["mt-diagnostician-1"]],
    ]);
  });

  test("by repository, by state (what asks first), flat; empty groups left out", () => {
    expect(groupRows(rows, "repo").map((g) => [g.title, g.rows.length])).toEqual([
      ["platform", 1],
      ["shop-api", 3],
      ["billing", 1],
      ["web-app", 2],
    ]);
    expect(groupRows(rows, "state").map((g) => g.title)).toEqual(["asks", "working", "finished"]);
    expect(groupRows(rows, "flat").map((g) => g.rows.length)).toEqual([rows.length]);
    expect(groupRows([], "flat")).toEqual([]);
  });
});

describe("a repository's mark", () => {
  test("two letters from its words, the same hue every time, from the hues of repositories", () => {
    expect(repoMark("shop-api").letters).toBe("SA");
    expect(repoMark("billing").letters).toBe("BI");
    expect(repoMark("this repository").letters).toBe("··");
    expect(repoMark("shop-api").hue).toBe(repoMark("shop-api").hue);
    expect(REPO_HUES).toContain(repoMark("web-app").hue);
  });

  test("the folder's repositories never share a hue, whatever order they are given in", () => {
    const folder = ["web-app", "shop-api", "billing", "platform", "shop-web"];
    const hues = folder.map((r) => repoMark(r, folder).hue);
    expect(new Set(hues).size).toBe(folder.length);
    expect(repoMark("billing", folder).hue).toBe(REPO_HUES[0] as string);
    expect(repoMark("shop-api", [...folder].reverse()).hue).toBe(repoMark("shop-api", folder).hue);
    // One the folder does not list takes a hue from its name.
    expect(REPO_HUES).toContain(repoMark("elsewhere", folder).hue);
  });
});

describe("the filter kept by the window", () => {
  test("read back as written; anything unreadable is no filter, grouped by task", () => {
    const kept = {
      filter: { hide: { repo: ["billing"], state: ["finished"], role: [] }, text: "api", panes: ["x|w1:p1"] },
      grouping: "state",
    };
    expect(terminalViewFromStorage(JSON.stringify(kept))).toEqual(kept as never);
    for (const raw of [
      null,
      "",
      "{",
      "[]",
      '{"grouping":"sideways","filter":{"hide":{"repo":[1,"x"]},"text":3}}',
    ])
      expect(terminalViewFromStorage(raw).grouping).toBe("task");
    expect(
      terminalViewFromStorage('{"filter":{"hide":{"repo":[1,"x"]},"text":3,"panes":["a",2]}}').filter,
    ).toEqual({
      hide: { repo: ["x"], state: [], role: [] },
      text: "",
      panes: ["a"],
    });
  });
});
