import { describe, expect, test } from "bun:test";
import type { InboxItem, RunOverview } from "../src/api.ts";
import {
  actionOf,
  answerCommand,
  answeredText,
  autonomyLabel,
  autonomyLevels,
  byPanelOrder,
  byStage,
  canAnswer,
  chordOf,
  chordText,
  closesWorkspace,
  DEFAULT_KEYS,
  duration,
  escalatedKey,
  evenTree,
  filterKeys,
  finishedText,
  flattenState,
  gotoRows,
  groupByFeature,
  helpRows,
  hostChoice,
  inboxChips,
  isFinished,
  isFirstRun,
  isIntake,
  keyLabel,
  keyMapOf,
  keyText,
  LOOKS,
  lookOf,
  menuCommands,
  needsPerson,
  needsQueue,
  needsReason,
  neighborPane,
  newQuestions,
  nextWaiting,
  nextWaitingTab,
  noHostText,
  notifies,
  openRuns,
  optionMatches,
  paneAsRun,
  paneLabel,
  paneNote,
  paneStateOf,
  panesOfRun,
  parseRoute,
  pickedNeed,
  plainKey,
  plural,
  portsText,
  questionKind,
  RUN_TABS,
  refusalText,
  refusedForDirtyTree,
  repoChoice,
  repoOfTab,
  resumeNotice,
  retryHost,
  rollUp,
  routeHash,
  runCounts,
  runLine,
  runPhase,
  runStateOf,
  runTabFor,
  runWithPanes,
  SHELL_KEYS,
  SHELL_QUIET_MS,
  sameRepo,
  seenFrom,
  seenKey,
  sidebarRuns,
  stepLabel,
  stepNeed,
  tabOfPane,
  tabOfRun,
  terminalKey,
  toastOf,
  toggleChoice,
  treeLeavesOf,
  WORKBENCH_COMMANDS,
  wasAway,
  withRatio,
  withSeen,
  withTerminalAsks,
  workbenchRepos,
  workflowChoice,
  workspaceOfPane,
} from "../src/model.ts";

const run = (runId: string, extra: Partial<RunOverview> = {}): RunOverview =>
  ({
    runId,
    workflow: "mt-feature",
    task: runId,
    autonomy: "L0",
    status: "active",
    stage: "build",
    attention: "driving",
    stages: [],
    questions: [],
    driving: true,
    driver: "agent",
    died: false,
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    elapsedMs: 0,
    services: [],
    ...extra,
  }) as RunOverview;

describe("panel order and groups", () => {
  test("waits for you first, then working, stopped, escalated, finished; newest first within", () => {
    const runs = [
      run("a", { attention: "done" }),
      run("b", { attention: "stopped" }),
      run("c", { attention: "you", updatedAt: "2026-11-02T09:00:00.000Z" }),
      run("d", { attention: "you", updatedAt: "2026-11-02T11:00:00.000Z" }),
      run("e", { attention: "driving" }),
      run("f", { attention: "escalated" }),
      run("g", { attention: "aborted" }),
    ];
    expect(byPanelOrder(runs).map((r) => r.runId)).toEqual(["d", "c", "e", "b", "f", "a", "g"]);
  });

  test("steps of one parent form a feature group in start order; a parent of unknown runs stands alone", () => {
    const runs = [
      run("p"),
      run("s2", { parent: "p", createdAt: "2026-11-02T12:00:00.000Z", status: "done" }),
      run("s1", { parent: "p", createdAt: "2026-11-02T11:00:00.000Z" }),
      run("x", { parent: "gone" }),
      run("q", { children: ["elsewhere"] }),
    ];
    const g = groupByFeature(runs);
    expect(g.groups).toEqual([
      { parent: "p", steps: [runs[2] as RunOverview, runs[1] as RunOverview], done: 1 },
    ]);
    expect(g.standalone.map((r) => r.runId)).toEqual(["x", "q"]);
    expect(stepLabel(runs[1] as RunOverview, g.groups)).toBe("step 2/2");
    expect(stepLabel(runs[3] as RunOverview, g.groups)).toBeUndefined();
  });

  test("the next session that waits, after the current one, around the end", () => {
    const runs = [run("a", { attention: "you" }), run("b"), run("c", { attention: "you" })];
    expect(nextWaiting(runs, undefined)?.runId).toBe("a");
    expect(nextWaiting(runs, "a")?.runId).toBe("c");
    expect(nextWaiting(runs, "c")?.runId).toBe("a");
    expect(nextWaiting([run("b")], "b")).toBeUndefined();
  });
});

describe("inbox rows and the card", () => {
  const item = (q: Partial<InboxItem["question"]>, driving = false): InboxItem =>
    ({
      runId: "r",
      task: "t",
      stage: "s",
      driving,
      waitedMs: 0,
      question: {
        id: "q001",
        runId: "r",
        stage: "s",
        source: "gate",
        prompt: "?",
        options: [],
        multiSelect: false,
        askedAt: "",
        ...q,
      },
    }) as InboxItem;

  test("kind and chips come from the question and its card", () => {
    expect([
      questionKind({ source: "gate" }),
      questionKind({ source: "permission" }),
      questionKind({ source: "agent" }),
    ]).toEqual(["APPROVAL", "PERMISSION", "QUESTION"]);
    expect(
      inboxChips(
        item(
          {
            source: "permission",
            card: {
              task: "t",
              done: [],
              artifacts: [],
              reversible: false,
              blastRadius: { files: 3, areas: ["src"] },
              costOfDelay: ["blocks wave 2"],
            },
          },
          true,
        ),
      ),
    ).toEqual(["not reversible", "touches 3 files", "can be allowed always", "blocks wave", "agent idle"]);
    expect(inboxChips(item({}))).toEqual([]);
  });

  test("the footer command is what the button does: the answer to the question, a gate's too", () => {
    const q = { id: "q002", runId: "20261102-mt-feature-a" };
    // A gate's card answers its question as any other: Reject must not read as an approval.
    expect(answerCommand(q, "Reject", "alice")).toBe(
      "metator run answer q002 --run 20261102-mt-feature-a --choice Reject --by alice",
    );
    expect(answerCommand(q, "half even", "")).toBe(
      'metator run answer q002 --run 20261102-mt-feature-a --choice "half even" --by <you>',
    );
    // Several choices of a multi-select question, and the reason Reject carries.
    expect(answerCommand(q, ["unit", "e2e"], "alice")).toBe(
      "metator run answer q002 --run 20261102-mt-feature-a --choice unit e2e --by alice",
    );
    expect(answerCommand(q, ["Reject"], "alice", " cap in cents ")).toBe(
      'metator run answer q002 --run 20261102-mt-feature-a --choice Reject --text "cap in cents" --by alice',
    );
    expect(answerCommand(q, [], "alice")).toContain("--choice … --by alice");
  });

  test("notify.channel off silences every announcement; anything else, or no options yet, does not", () => {
    expect(notifies([{ key: "notify.channel", value: "off" }])).toBe(false);
    expect(notifies([{ key: "notify.channel", value: "app" }])).toBe(true);
    expect(notifies([])).toBe(true);
  });

  test("new questions are the ones not seen before", () => {
    const before = [{ id: "q001", runId: "r" }];
    const after = [
      { id: "q001", runId: "r", prompt: "old" },
      { id: "q002", runId: "r", prompt: "new" },
    ];
    expect(newQuestions(before, after).map((q) => q.prompt)).toEqual(["new"]);
  });
});

describe("formatting and routes", () => {
  test("durations read in the largest unit that fits", () => {
    expect([duration(3000), duration(240_000), duration(7_500_000), duration(3 * 86_400_000)]).toEqual([
      "3s",
      "4 min",
      "2 h 05",
      "3 d",
    ]);
    expect(duration(-5)).toBe("0s");
  });

  test("routes parse and print both ways; anything unknown is the inbox", () => {
    expect(parseRoute("#/run/2026%2Fa")).toEqual({ screen: "run", runId: "2026/a", tab: "overview" });
    expect(parseRoute("#/run/r/terminal/w1%3Ap2")).toEqual({
      screen: "run",
      runId: "r",
      tab: "terminal",
      pane: "w1:p2",
    });
    expect(parseRoute("#/run/r/changes/src/a%20b.ts")).toEqual({
      screen: "run",
      runId: "r",
      tab: "changes",
      file: "src/a b.ts",
    });
    // A tab the page does not have is its first one.
    expect(parseRoute("#/run/r/nope")).toEqual({ screen: "run", runId: "r", tab: "overview" });
    expect(parseRoute("#/run")).toEqual({ screen: "inbox" });
    expect(parseRoute("#/grid/p")).toEqual({ screen: "grid", group: "p" });
    expect(parseRoute("#/grid")).toEqual({ screen: "grid" });
    expect(parseRoute("#/overview/dependencies")).toEqual({ screen: "overview", tab: "dependencies" });
    expect(parseRoute("")).toEqual({ screen: "inbox" });
    expect(parseRoute("#/nope")).toEqual({ screen: "inbox" });
    for (const hash of [
      "#/inbox",
      "#/inbox/r%2Fq001",
      "#/run/r/overview",
      "#/run/r/terminal",
      "#/run/r/terminal/w1%3Ap2",
      "#/run/r/plan",
      "#/run/r/changes",
      "#/run/r/changes/src/discount.ts",
      "#/run/r/activity",
      "#/grid",
      "#/grid/p",
      "#/grid/pane:w1%3Ap2",
      "#/overview",
      "#/overview/dependencies",
      "#/mrs",
      "#/mrs/gh-45",
      "#/backlog",
      "#/settings",
    ])
      expect(routeHash(parseRoute(hash))).toBe(hash);
  });

  test("the routes a run's four screens and the two overview screens once had land on the right tab", () => {
    expect(parseRoute("#/session/r")).toEqual({ screen: "run", runId: "r", tab: "terminal" });
    expect(parseRoute("#/session/r/w1%3Ap2")).toEqual({
      screen: "run",
      runId: "r",
      tab: "terminal",
      pane: "w1:p2",
    });
    expect(parseRoute("#/plan/r")).toEqual({ screen: "run", runId: "r", tab: "plan" });
    expect(parseRoute("#/review/r/src/a.ts")).toEqual({
      screen: "run",
      runId: "r",
      tab: "changes",
      file: "src/a.ts",
    });
    expect(parseRoute("#/review/r")).toEqual({ screen: "run", runId: "r", tab: "changes" });
    expect(parseRoute("#/briefing/r")).toEqual({ screen: "run", runId: "r", tab: "overview" });
    expect(parseRoute("#/briefing")).toEqual({ screen: "inbox" });
    expect(parseRoute("#/supervisor")).toEqual({ screen: "overview", tab: "daemon" });
    expect(parseRoute("#/graph")).toEqual({ screen: "overview", tab: "dependencies" });
    expect(routeHash(parseRoute("#/session/r"))).toBe("#/run/r/terminal");
  });

  test("away means ten minutes or more since the person last looked", () => {
    expect(wasAway(undefined, 1_000_000)).toBe(false);
    expect(wasAway(0, 599_999)).toBe(false);
    expect(wasAway(0, 600_000)).toBe(true);
  });

  test("a run's panes: the conductor first, workers next, shells last; labels", () => {
    const pane = (
      id: string,
      role: "conductor" | "worker" | "shell",
      runId = "r1",
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      workspace: "w1",
      tab: "t1",
      role,
      label: role,
      cwd: "/repo",
      runId,
      process: {
        kind: "host" as const,
        host: "copilot",
        agent: role === "conductor" ? "mt-orchestrator" : "mt-planner",
        prompt: "",
      },
      ...extra,
    });
    const panes = [
      pane("w1:p3", "shell"),
      pane("w1:p10", "worker", "r1", { worker: { name: "mt-planner-2", stage: "plan" } }),
      pane("w1:p2", "worker", "r1", { worker: { name: "mt-planner-1", stage: "plan" } }),
      pane("w2:p4", "conductor", "r2"),
      pane("w1:p1", "conductor"),
    ];
    expect(panesOfRun(panes, "r1").map((p) => p.id)).toEqual(["w1:p1", "w1:p2", "w1:p10", "w1:p3"]);
    expect(panesOfRun(panes, "r1").map(paneLabel)).toEqual([
      "agent · mt-orchestrator",
      "mt-planner-1",
      "mt-planner-2",
      "shell",
    ]);
  });
});

describe("settings view logic (S1)", () => {
  const opt = (key: string, source: "default" | "user" | "repo" | "run" = "default") => ({
    key,
    value: 1,
    source,
    definition: {
      key,
      kind: "number" as const,
      scope: "user" as const,
      title: `${key} title`,
      description: "how wide the sidebar is",
      default: 1,
      restart: "none" as const,
      fixed: false,
    },
    layers: {},
  });
  test("search matches the key, the title or the description, ignoring case", () => {
    expect(optionMatches(opt("ui.paneBorders"), "SIDEBAR")).toBe(true);
    expect(optionMatches(opt("ui.paneBorders"), "wide")).toBe(true);
    expect(optionMatches(opt("ui.paneBorders"), "zoom")).toBe(false);
    expect(optionMatches(opt("ui.paneBorders"), "  ")).toBe(true);
  });
});

describe("workbench view logic (S6)", () => {
  const ws = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    cwd: "/repo",
    tabs: [{ id: `${id}:t1`, label: "main", panes: [`${id}:p1`] }],
    ...extra,
  });
  test("repositories get their run workspaces as task tabs; a loose run workspace stands alone", () => {
    const repos = workbenchRepos(
      [
        ws("w1"),
        ws("w2", { runId: "r1", group: "w1", cwd: "/repo/.metator/wt/r1" }),
        ws("w3", { runId: "r2", cwd: "/repo" }),
        ws("w4", { runId: "r3", cwd: "/elsewhere" }),
      ] as never,
      [
        run("r1", { attention: "you", worktree: { id: "r1", path: ".metator/wt/r1", branch: "metator/r1" } }),
        run("r2"),
      ],
      "shop",
    );
    expect(repos.map((r) => [r.id, r.tabs.map((t) => `${t.kind}:${t.label}`), r.attention])).toEqual([
      ["w1", ["task:r1", "task:r2", "shell:main"], "you"],
      ["repo", ["task:w4"], undefined],
    ]);
    expect(repos[0]?.tabs[0]).toMatchObject({
      branch: "metator/r1",
      worktree: ".metator/wt/r1",
      runId: "r1",
    });
  });
  test("chords read like the options spell them; the keymap falls back to the defaults", () => {
    expect(chordOf({ key: "b", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe(
      "ctrl+b",
    );
    expect(chordOf({ key: "Enter", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe(
      "shift+enter",
    );
    expect(chordOf({ key: "[", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBe("[");
    expect(chordOf({ key: "Shift", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe("");
    const map = keyMapOf([
      { key: "keys.zoom", value: ["prefix+F"] },
      { key: "ui.paneLabels", value: true },
    ]);
    expect(actionOf(map, "f", true)).toBe("zoom");
    expect(actionOf(map, "z", true)).toBeUndefined();
    expect(actionOf(map, "ctrl+b", false)).toBe("prefix");
    expect(actionOf(DEFAULT_KEYS, "v", true)).toBe("splitRight");
  });
  test("focus moves along the tree's leaves and wraps; an even tree splits panes in halves", () => {
    const tree = evenTree(["a", "b", "c"]);
    expect(treeLeavesOf(tree as never)).toEqual(["a", "b", "c"]);
    expect(neighborPane(tree, "c", 1)).toBe("a");
    expect(neighborPane(tree, "a", -1)).toBe("c");
    expect(neighborPane(tree, undefined, 1)).toBe("a");
    expect(neighborPane(undefined, "a", 1)).toBeUndefined();
    const resized = withRatio(tree as never, [], 0.95);
    expect("ratio" in resized && resized.ratio).toBe(0.9);
  });
  test("go-to rows: every pane and open question, filtered by state or text", () => {
    const repos = workbenchRepos(
      [
        ws("w1"),
        ws("w2", {
          runId: "r1",
          group: "w1",
          tabs: [{ id: "w2:t1", label: "run", panes: ["w2:p1", "w2:p2"] }],
        }),
      ] as never,
      [
        run("r1", {
          questions: [
            {
              id: "q1",
              runId: "r1",
              stage: "plan",
              source: "agent",
              prompt: "Round how?",
              options: [],
              multiSelect: false,
              askedAt: "",
            },
          ],
        }),
      ],
    );
    const panes = [
      {
        id: "w2:p1",
        tab: "w2:t1",
        role: "conductor",
        label: "session",
        cwd: "/",
        runId: "r1",
        process: { kind: "host", host: "copilot", agent: "mt-orchestrator", prompt: "" },
        live: { alive: true },
        state: { state: "blocked", reason: "Allow?" },
      },
      {
        id: "w2:p2",
        tab: "w2:t1",
        role: "shell",
        label: "sh",
        cwd: "/",
        process: { kind: "command", argv: ["sh"] },
        live: { alive: true },
        state: { state: "idle", reason: "" },
      },
    ] as never[];
    const all = gotoRows(repos, panes as never, "all", "");
    expect(all.map((r) => [r.kind, r.label])).toEqual([
      ["pane", "agent · mt-orchestrator"],
      ["pane", "sh"],
      ["question", "Round how?"],
    ]);
    expect(gotoRows(repos, panes as never, "asks", "").map((r) => r.id)).toEqual(["w2:p1", "r1/q1"]);
    expect(gotoRows(repos, panes as never, "idle", "").map((r) => r.id)).toEqual(["w2:p2"]);
    expect(gotoRows(repos, panes as never, "all", "round").map((r) => r.id)).toEqual(["r1/q1"]);
  });
});

describe("what waits for a person (D2)", () => {
  const pane = (id: string, runId: string | undefined, state: string, repo?: string) => ({
    id,
    ...(runId ? { runId } : {}),
    ...(repo ? { repo } : {}),
    state: { state, reason: "the screen shows a question" },
  });

  test("a run whose agent asks in its terminal waits for you, with the pane to open", () => {
    const runs = [
      run("asks", { attention: "driving" }),
      run("works", { attention: "driving" }),
      run("card", { attention: "you", questions: [{ id: "q001" }] as never }),
      run("over", { attention: "done", status: "done" }),
    ];
    const out = withTerminalAsks(runs, [
      pane("w1:p1", "asks", "blocked"),
      pane("w2:p1", "works", "working"),
      pane("w3:p1", "card", "blocked"),
      pane("w4:p1", "over", "blocked"),
      pane("w5:p1", undefined, "blocked"),
    ] as never);
    expect(out.map((r) => [r.runId, r.attention, r.terminalAsk])).toEqual([
      ["asks", "you", "w1:p1"],
      ["works", "driving", undefined],
      // A question that already has a card is answered there: no second row.
      ["card", "you", undefined],
      ["over", "done", undefined],
    ]);
    // The next waiting session (the g key) and the panel's order see it as any other.
    expect(nextWaiting(out, undefined)?.runId).toBe("asks");
  });

  test("in a folder a pane counts only for the run of its own repository", () => {
    const runs = [{ ...run("r", { attention: "driving" }), repo: "be" }];
    expect(withTerminalAsks(runs, [pane("w1:p1", "r", "blocked", "fe")] as never)[0]?.terminalAsk).toBe(
      undefined,
    );
    expect(withTerminalAsks(runs, [pane("w1:p1", "r", "blocked", "be")] as never)[0]?.terminalAsk).toBe(
      "w1:p1",
    );
  });
});

describe("keys (D7)", () => {
  const key = (k: string, extra: Record<string, unknown> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra }) as never;

  test("a single-letter shortcut is the bare key: no Ctrl, Cmd or Alt, and not while typing in a field", () => {
    expect(plainKey(key("g"))).toBe("g");
    expect(plainKey(key("r", { ctrlKey: true }))).toBeUndefined();
    expect(plainKey(key("r", { metaKey: true }))).toBeUndefined();
    expect(plainKey(key("d", { altKey: true }))).toBeUndefined();
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"])
      expect(plainKey(key("a", { target: { tagName } }))).toBeUndefined();
    expect(plainKey(key("a", { target: { tagName: "DIV", isContentEditable: true } }))).toBeUndefined();
    expect(plainKey(key("a", { target: { tagName: "BUTTON" } }))).toBe("a");
  });
});

describe("answers (D8)", () => {
  test("a multi-select question toggles choices; a single-select one replaces the choice", () => {
    expect(toggleChoice(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleChoice(["a", "b"], "a", true)).toEqual(["b"]);
    expect(toggleChoice(["a"], "b", false)).toEqual(["b"]);
    expect(toggleChoice(["a"], "a", false)).toEqual(["a"]);
  });

  test("Reject and Other need the reason they promise; nothing chosen is no answer", () => {
    expect([needsReason(["Approve"]), needsReason(["Reject"]), needsReason(["a", "Other"])]).toEqual([
      false,
      true,
      true,
    ]);
    expect(canAnswer([], "")).toBe(false);
    expect(canAnswer(["Approve"], "")).toBe(true);
    expect(canAnswer(["Reject"], "  ")).toBe(false);
    expect(canAnswer(["Reject"], "the cap is wrong")).toBe(true);
  });
});

describe("hosts, workflows and repositories (D1, D5, D10)", () => {
  const status = [
    { id: "copilot", command: "copilot", installed: false },
    { id: "claude", command: "claude", installed: true },
    { id: "opencode", command: "opencode", installed: false },
  ];

  test("a new session starts on the first host of the order that is installed", () => {
    expect(hostChoice(["copilot", "claude", "opencode"], status)).toBe("claude");
    expect(hostChoice(["opencode"], status)).toBe("claude");
    expect(hostChoice(["copilot"], [status[0] as (typeof status)[number]])).toBeUndefined();
    // A daemon that does not say what is installed (an older one): the order decides, as before.
    expect(hostChoice(["copilot", "claude"], undefined, ["claude", "copilot"])).toBe("copilot");
  });

  test("with no host installed the app says what was looked for and where the guide is", () => {
    expect(noHostText(status.map((h) => ({ ...h, installed: false })))).toBe(
      "No AI host is installed. The daemon looked for copilot, claude and opencode and found none. " +
        'Install one of them (the guide page "Copilot and Claude Code", site/guide/hosts.md, says how), ' +
        "then try again.",
    );
  });

  test("a run from the backlog starts on a workflow the repository has", () => {
    expect(workflowChoice(["mt-bugfix", "mt-feature"], undefined)).toBe("mt-feature");
    expect(workflowChoice(["demo", "other"], undefined)).toBe("demo");
    expect(workflowChoice(["demo", "other"], "other")).toBe("other");
    expect(workflowChoice(["demo"], "gone")).toBe("demo");
    expect(workflowChoice([], "gone")).toBeUndefined();
  });

  test("the repository of the list screens: the remembered one while it exists, else the first", () => {
    const repos = [{ name: "be" }, { name: "fe" }];
    expect(repoChoice(repos, "fe")).toBe("fe");
    expect(repoChoice(repos, "gone")).toBe("be");
    expect(repoChoice(repos, null)).toBe("be");
    expect(repoChoice([], "fe")).toBeUndefined();
  });

  test("an autonomy level reads with words beside it", () => {
    expect(autonomyLabel("L0")).toBe("L0: every approval waits for you");
    expect(autonomyLabel("L1")).toBe("L1: skips the approvals the workflow lets it skip");
    expect(autonomyLabel("L2")).toBe("L2: no person at hand; only the approvals that are never skipped wait");
    expect(autonomyLabel("L9")).toBe("L9");
  });

  test("a key reads as it is pressed: the prefix key first, then the letter", () => {
    expect(keyText(DEFAULT_KEYS, "newShell")).toBe("ctrl+b then c");
    expect(keyText({ ...DEFAULT_KEYS, prefix: ["ctrl+a"] }, "goto")).toBe("ctrl+a then g");
    expect(keyText({ newShell: ["ctrl+shift+s"] }, "newShell")).toBe("ctrl+shift+s");
    expect(keyText({ newShell: ["prefix+c"] }, "newShell")).toBe("the prefix key then c");
    expect(keyText(DEFAULT_KEYS, "nothing")).toBeUndefined();
  });

  test("the form offers the autonomy levels the workflow runs at; L0 and L1 when the daemon does not say", () => {
    expect(autonomyLevels({ autonomy: ["L0"] })).toEqual(["L0"]);
    expect(autonomyLevels({ autonomy: ["L0", "L1", "L2"] })).toEqual(["L0", "L1", "L2"]);
    expect(autonomyLevels({})).toEqual(["L0", "L1"]);
    expect(autonomyLevels({ autonomy: [] })).toEqual(["L0", "L1"]);
    expect(autonomyLevels(undefined)).toEqual(["L0", "L1"]);
  });
});

describe("escalated runs (F1, D9)", () => {
  test("an escalated run is not finished; done and aborted are", () => {
    const by = (status: string) => isFinished({ status });
    expect(["active", "escalated", "done", "aborted"].map(by)).toEqual([false, false, true, true]);
  });

  test("its key in the inbox never collides with a question's, and tells repositories apart", () => {
    expect(escalatedKey({ runId: "r1" })).toBe("escalated::r1");
    expect(escalatedKey({ runId: "r1", repo: "beta" })).toBe("escalated:beta:r1");
  });

  test("Resume says nothing when a drive started, and why when none did", () => {
    expect(resumeNotice("r1", { started: true })).toBeUndefined();
    expect(resumeNotice("r1", undefined)).toBeUndefined();
    expect(resumeNotice("r1", { error: "AI host copilot cannot start here", hint: "Install it." })).toBe(
      "Run r1 is resumed, but no agent works on it: AI host copilot cannot start here Install it.",
    );
  });
});

describe("a start refused for uncommitted changes", () => {
  test("only the tree check offers the start from the last commit", () => {
    expect(refusedForDirtyTree({ details: { check: "tree" } })).toBe(true);
    expect(refusedForDirtyTree({ details: { check: "git" } })).toBe(false);
    expect(refusedForDirtyTree({})).toBe(false);
    expect(refusedForDirtyTree(undefined)).toBe(false);
  });
});

describe("one vocabulary for states", () => {
  const pane = (
    kind: "host" | "command",
    state?: string,
    live: { alive: boolean } | null = { alive: true },
  ) =>
    ({
      process: kind === "host" ? { kind, host: "copilot", agent: "a", prompt: "" } : { kind, argv: ["sh"] },
      runId: "r1",
      ...(live ? { live } : {}),
      ...(state ? { state: { state, reason: "" } } : {}),
    }) as never;

  test("an agent that asks reads `asks`, whether on its screen or on a card; never `blocked`", () => {
    expect(paneStateOf(pane("host", "blocked"))).toBe("asks");
    expect(paneStateOf(pane("host", "waiting"))).toBe("asks");
    expect(paneStateOf(pane("host", "working"))).toBe("working");
    expect(paneStateOf(pane("host", "idle"))).toBe("idle");
  });

  test("an idle shell is idle: never waiting for you, never working, whatever its run asks", () => {
    // The daemon marks every pane of a run with an open question `waiting`, its shells too.
    expect(paneStateOf(pane("command", "waiting"))).toBe("idle");
    expect(paneStateOf(pane("command", "blocked"))).toBe("idle");
    // A live shell the daemon says nothing about is not "working".
    expect(paneStateOf(pane("command"))).toBe("idle");
    expect(paneStateOf(pane("command", "idle"))).toBe("idle");
    // A shell works only while it prints: the daemon calls it working for 15 s after its last
    // output, the app for two.
    const at = Date.parse("2026-11-13T10:00:00.000Z");
    const printing = (agoMs: number) =>
      ({
        process: { kind: "command", argv: ["sh"] },
        live: { alive: true, lastOutputAt: new Date(at - agoMs).toISOString() },
        state: { state: "working", reason: "output just now" },
      }) as never;
    expect(paneStateOf(printing(500), at)).toBe("working");
    expect(paneStateOf(printing(SHELL_QUIET_MS), at)).toBe("idle");
    expect(paneStateOf(printing(14_000), at)).toBe("idle");
    // With no time of its last output a shell is idle.
    expect(paneStateOf(pane("command", "working"))).toBe("idle");
    // An agent the daemon has not sensed yet is at work.
    expect(paneStateOf(pane("host"))).toBe("working");
  });

  test("a pane with no live process has exited", () => {
    expect(paneStateOf(pane("host", "working", { alive: false }))).toBe("exited");
    expect(paneStateOf(pane("command", undefined, null))).toBe("exited");
    expect(paneStateOf(pane("host", "exited"))).toBe("exited");
  });

  test("every state has one glyph and one colour; an unknown one is a faint dot", () => {
    expect(lookOf("pane", "asks")).toEqual({ glyph: "?", tone: "amber" });
    expect(lookOf("pane", "idle").tone).toBe("faint");
    expect(lookOf("stage", "current")).toEqual({ glyph: "⟳", tone: "violet" });
    expect(lookOf("issue", "open")).toEqual({ glyph: "○" });
    expect(lookOf("file", "deleted")).toEqual({ glyph: "D", tone: "red" });
    expect(lookOf("note", "nonsense")).toEqual({ glyph: "·", tone: "faint" });
    expect(lookOf("thread", undefined)).toEqual({ glyph: "·", tone: "faint" });
    // The run's five words and what needs you each have their look.
    expect(Object.keys(LOOKS.run)).toEqual(["needs you", "working", "escalated", "done", "idle"]);
    expect(lookOf("run", "done")).toEqual({ glyph: "✓", tone: "green" });
    expect(lookOf("need", "escalated").tone).toBe("red");
  });
});

describe("counts every screen agrees on", () => {
  const runs = [
    run("a", { attention: "you" }),
    run("b", { attention: "driving" }),
    run("c", { attention: "escalated", status: "escalated" }),
    run("d", { attention: "stopped" }),
    run("e", { attention: "done", status: "done" }),
    run("f", { attention: "aborted", status: "aborted" }),
  ];

  test("an escalated run needs a person, and is counted among the runs that need you", () => {
    expect(runs.filter(needsPerson).map((r) => r.runId)).toEqual(["a", "c"]);
    expect(runCounts(runs)).toEqual({
      needYou: 2,
      working: 1,
      escalated: 1,
      stopped: 1,
      finished: 2,
      open: 4,
    });
    expect(runCounts([])).toEqual({ needYou: 0, working: 0, escalated: 0, stopped: 0, finished: 0, open: 0 });
  });

  test("the open runs are every run that is not finished, the escalated one included", () => {
    expect(openRuns(runs).map((r) => r.runId)).toEqual(["a", "b", "c", "d"]);
    expect(openRuns(runs)).toHaveLength(runCounts(runs).open);
  });

  test("no repository and an empty name are the same repository", () => {
    expect(sameRepo(undefined, "")).toBe(true);
    expect(sameRepo("fe", "fe")).toBe(true);
    expect(sameRepo("fe", undefined)).toBe(false);
  });

  test("counts read with their noun; a refusal reads with its hint", () => {
    expect([plural(1, "run"), plural(2, "run"), plural(0, "reply", "replies")]).toEqual([
      "1 run",
      "2 runs",
      "0 replies",
    ]);
    expect(refusalText({ message: "no", hint: "try again" })).toBe("no try again");
    expect(refusalText(undefined)).toBe("the daemon refused");
    expect(refusalText({}, "the run was not closed")).toBe("the run was not closed");
  });
});

describe("the screens of one run", () => {
  test("one page per run with five tabs, each with one letter", () => {
    expect(RUN_TABS.map((t) => [t.tab, t.key])).toEqual([
      ["overview", "o"],
      ["terminal", "t"],
      ["plan", "p"],
      ["changes", "d"],
      ["activity", "l"],
    ]);
    // From the sidebar a run opens where the work is; a finished one on its summary.
    expect(runTabFor(run("a"))).toBe("terminal");
    expect(runTabFor(run("a", { status: "escalated" }))).toBe("terminal");
    expect(runTabFor(run("a", { status: "done" }))).toBe("overview");
  });

  test("an escalated or finished run has no driver to show", () => {
    expect(runPhase(run("a"))).toBe("active");
    expect(runPhase(run("a", { status: "escalated" }))).toBe("escalated");
    expect(runPhase(run("a", { status: "done" }))).toBe("finished");
    expect(runPhase(run("a", { status: "aborted" }))).toBe("finished");
    expect(finishedText(run("a", { status: "done", elapsedMs: 120_000 }))).toBe(
      "Done: every stage passed, in 2 min.",
    );
    expect(finishedText(run("a", { status: "aborted", stage: "build", reason: "not worth it" }))).toBe(
      "Closed as aborted at build: not worth it.",
    );
  });

  test("events group by the stage they happened in, in order of first appearance", () => {
    const e = (stage: string | undefined, text: string) => ({ ...(stage ? { stage } : {}), text });
    expect(byStage([e("plan", "1"), e("build", "2"), e("plan", "3"), e(undefined, "4")])).toEqual([
      ["plan", [e("plan", "1"), e("plan", "3")]],
      ["build", [e("build", "2")]],
      ["run", [e(undefined, "4")]],
    ]);
  });
});

describe("the workbench's commands and small decisions (S6)", () => {
  const ws = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    cwd: "/repo",
    tabs: [{ id: `${id}:t1`, label: "shell", panes: [`${id}:p1`] }],
    ...extra,
  });
  const repos = workbenchRepos(
    [
      ws("w1", {
        tabs: [
          { id: "w1:t1", label: "shell", panes: ["w1:p1"] },
          { id: "w1:t2", label: "other", panes: ["w1:p2"] },
        ],
      }),
      ws("w2", { runId: "r1", group: "w1" }),
      ws("w3", { runId: "r2", group: "w1" }),
      ws("w4", { cwd: "/elsewhere" }),
    ] as never,
    [run("r1", { attention: "driving" }), run("r2", { attention: "escalated", status: "escalated" })],
  );

  test("a pane and a run lead to their tab, a tab to its sidebar entry", () => {
    expect(tabOfPane(repos, "w2:p1")?.runId).toBe("r1");
    expect(tabOfPane(repos, "nope")).toBeUndefined();
    expect(tabOfRun(repos, "r2")?.key).toBe("w3:t1");
    expect(repoOfTab(repos, "w3:t1")?.id).toBe("w1");
    expect(repoOfTab(repos, "w4:t1")?.id).toBe("w4");
  });

  test("the next waiting tab is the next that needs a person, escalated included, around the end", () => {
    expect(nextWaitingTab(repos, "w2:t1")?.key).toBe("w3:t1");
    expect(nextWaitingTab(repos, "w3:t1")?.key).toBe("w3:t1");
    expect(nextWaitingTab(repos, undefined)?.key).toBe("w3:t1");
    expect(nextWaitingTab(workbenchRepos([ws("w1")] as never, []), "w1:t1")).toBeUndefined();
  });

  test("closing a run's tab or the last tab of a workspace closes the workspace; a shared one only its panes", () => {
    const tab = (key: string) => repos.flatMap((r) => r.tabs).find((t) => t.key === key) as never;
    expect(closesWorkspace(repos, tab("w2:t1"))).toBe(true);
    expect(closesWorkspace(repos, tab("w4:t1"))).toBe(true);
    expect(closesWorkspace(repos, tab("w1:t2"))).toBe(false);
  });

  test("the toast is the first open question of a tab shown here that was not dismissed", () => {
    const item = (runId: string, id: string) => ({ runId, question: { id } }) as never;
    const inbox = [item("gone", "q0"), item("r1", "q1"), item("r2", "q2")];
    expect(toastOf(inbox, repos, [], true)).toBe(inbox[1]);
    expect(toastOf(inbox, repos, ["r1/q1"], true)).toBe(inbox[2]);
    expect(toastOf(inbox, repos, ["r1/q1", "r2/q2"], true)).toBeUndefined();
    // notify.channel: off
    expect(toastOf(inbox, repos, [], false)).toBeUndefined();
  });

  test("a dead pane starts again on its host while it is installed, else on the order's first installed", () => {
    const status = [
      { id: "copilot", installed: false },
      { id: "claude", installed: true },
    ];
    expect(retryHost("claude", ["copilot", "claude"], status)).toBe("claude");
    expect(retryHost("copilot", ["copilot", "claude"], status)).toBe("claude");
    expect(retryHost("copilot", ["copilot"], [{ id: "copilot", installed: false }])).toBeUndefined();
    // An older daemon does not say what is installed: the pane's own host is tried.
    expect(retryHost("copilot", [], undefined)).toBe("copilot");
  });

  test("every command is named once; every default key runs a command or is the prefix", () => {
    const ids = WORKBENCH_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of Object.keys(DEFAULT_KEYS)) expect(["prefix", ...ids]).toContain(action);
  });

  test("the pane menu offers the keyboard one way at a time, and says why a command cannot run", () => {
    const base = { attached: false, taken: false, zoomed: false };
    const agent = { runId: "r1", role: "conductor" as const, asks: false };
    const free = menuCommands(["pane"], { ...base, pane: agent });
    expect(free.map((c) => c.id)).toEqual([
      "attach",
      "zoom",
      "splitRight",
      "splitDown",
      "copyMode",
      "plan",
      "changes",
      "editor",
      "taskFromHere",
      "closePane",
    ]);
    expect(free[0]).toMatchObject({ label: "Take the keyboard", disabled: false });
    // A conductor is not closed from the menu; the plan has a line above it.
    expect(free.find((c) => c.id === "closePane")?.disabled).toBe(true);
    expect(free.find((c) => c.id === "plan")?.separator).toBe(true);
    // The agent asks on its screen: taking the keyboard is the answer.
    expect(menuCommands(["pane"], { ...base, pane: { ...agent, asks: true } })[0]?.label).toBe(
      "Answer here (take the keyboard)",
    );
    // Someone else holds the keyboard.
    expect(menuCommands(["pane"], { ...base, taken: true, pane: agent })[0]).toMatchObject({
      id: "attach",
      disabled: true,
    });
    // The person holds it: the menu gives it back, and a zoomed pane unzooms.
    const mine = menuCommands(["pane"], { attached: true, taken: true, zoomed: true, pane: agent });
    expect(mine.slice(0, 2).map((c) => c.label)).toEqual(["Give the keyboard back", "Unzoom"]);
    // A shell of no run: nothing to take, no plan, no changes; it can be closed.
    const shell = menuCommands(["pane"], { ...base, pane: { role: "shell", asks: false } });
    expect(shell.filter((c) => c.disabled).map((c) => c.id)).toEqual(["release", "plan", "changes"]);
  });

  test("the tab menus: new tabs everywhere; on a tab also a shell pane and closing it", () => {
    const base = { attached: false, taken: false, zoomed: false };
    expect(menuCommands(["tab"], base).map((c) => c.id)).toEqual(["newShellTab", "newTab", "backlog"]);
    const own = menuCommands(["tab", "tab-own"], { ...base, tab: { kind: "task", runId: "r1", panes: 2 } });
    expect(own.map((c) => c.id)).toEqual(["newShellTab", "newTab", "backlog", "newShell", "closeTab"]);
    expect(own.at(-1)?.label).toBe("Close tab (its panes; the worktree stays)");
    // An empty shell tab has nothing to close.
    expect(
      menuCommands(["tab-own"], { ...base, tab: { kind: "shell", panes: 0 } }).find(
        (c) => c.id === "closeTab",
      ),
    ).toMatchObject({ label: "Close tab", disabled: true });
  });

  test("keys read as they are pressed, with the real prefix key, in the menus and the help", () => {
    expect(chordText(DEFAULT_KEYS, "prefix+z")).toBe("ctrl+b z");
    expect(chordText(DEFAULT_KEYS, "f5")).toBe("f5");
    expect(keyLabel(DEFAULT_KEYS, "zoom")).toBe("ctrl+b z");
    expect(keyLabel(DEFAULT_KEYS, "editor")).toBeUndefined();
    const rebound = keyMapOf([
      { key: "keys.prefix", value: ["ctrl+a"] },
      { key: "keys.zoom", value: ["prefix+f", "f11"] },
    ]);
    const rows = helpRows(rebound);
    expect(rows[0]).toEqual({
      id: "prefix",
      keys: "ctrl+a",
      label: "The prefix: press it, then a key below",
    });
    expect(rows.find((r) => r.id === "zoom")).toEqual({ id: "zoom", keys: "ctrl+a f / f11", label: "Zoom" });
    // No row says the word "prefix" for a key, and a command with no key is left out.
    expect(rows.slice(1).some((r) => r.keys.includes("prefix"))).toBe(false);
    expect(rows.some((r) => r.id === "editor")).toBe(false);
    expect(rows.find((r) => r.id === "help")?.keys).toBe("ctrl+a ?");
    // The help of every screen lists `?` first.
    expect(SHELL_KEYS[0]?.keys).toBe("?");
  });
});

describe("the daemon's state, flattened", () => {
  const broken = { runId: "r9", file: ".metator/runs/r9/state.json", message: "not a RunRecord" };

  test("one repository: its runs as they are, and the runs it could not read", () => {
    const flat = flattenState({
      runs: [run("a")],
      conversations: [],
      counts: {} as never,
      unreadable: [broken],
    });
    expect(flat.runs.map((r) => [r.runId, r.repo])).toEqual([["a", undefined]]);
    expect(flat.repos).toEqual([]);
    expect(flat.unreadable).toEqual([broken]);
  });

  test("a folder: every run and every unreadable run with its repository; an older daemon names none", () => {
    const flat = flattenState({
      folder: "/work",
      repos: [
        { name: "fe", path: "/work/fe", runs: [run("a")], unreadable: [broken] },
        { name: "be", path: "/work/be", runs: [run("b")] },
        { name: "bad", path: "/work/bad", error: "no config" },
      ],
    });
    expect(flat.runs.map((r) => [r.runId, r.repo])).toEqual([
      ["a", "fe"],
      ["b", "be"],
    ]);
    expect(flat.repos.map((r) => r.name)).toEqual(["fe", "be", "bad"]);
    expect(flat.unreadable).toEqual([{ ...broken, repo: "fe" }]);
    expect(flattenState(undefined)).toEqual({ runs: [], repos: [], unreadable: [] });
  });
});

describe("shapes the daemon passes through from core (ADR-0085)", () => {
  test("a service's ports are named: they read `name port`, or `no port`", () => {
    expect(portsText({ web: 3000, db: 5432 })).toBe("web 3000, db 5432");
    expect(portsText({})).toBe("no port");
  });

  test("a pane names its tab, and the tab its workspace", () => {
    expect(workspaceOfPane({ tab: "w2:t1" })).toBe("w2");
    expect(workspaceOfPane({ tab: "w12:t3" })).toBe("w12");
  });
});

describe("the sidebar: one state that rolls up (wave 2)", () => {
  test("a run reads one of five words; done is a finished run not opened since it finished", () => {
    const at = "2026-11-13T10:00:00.000Z";
    expect(runStateOf(run("a", { attention: "you" }))).toBe("needs you");
    expect(runStateOf(run("a", { attention: "driving" }))).toBe("working");
    expect(runStateOf(run("a", { attention: "escalated", status: "escalated" }))).toBe("escalated");
    expect(runStateOf(run("a", { attention: "stopped" }))).toBe("idle");
    const done = run("a", { attention: "done", status: "done", updatedAt: at });
    expect(runStateOf(done)).toBe("done");
    // Opened before it finished: still news. Opened after: quiet.
    expect(runStateOf(done, "2026-11-13T09:59:59.000Z")).toBe("done");
    expect(runStateOf(done, at)).toBe("idle");
    expect(runStateOf(done, "2026-11-13T10:05:00.000Z")).toBe("idle");
    // An aborted run is not news: the person closed it.
    expect(runStateOf(run("a", { attention: "aborted", status: "aborted" }))).toBe("idle");
  });

  test("states roll up pane → run → repository: a person is needed first, then work, then news, then quiet", () => {
    expect(rollUp([])).toBe("idle");
    expect(rollUp(["idle", "done", "working"])).toBe("working");
    expect(rollUp(["working", "escalated", "done"])).toBe("escalated");
    expect(rollUp(["escalated", "needs you", "working"])).toBe("needs you");
    expect(rollUp(["idle", "done"])).toBe("done");
    expect((["asks", "working", "idle", "exited"] as const).map(paneAsRun)).toEqual([
      "needs you",
      "working",
      "idle",
      "idle",
    ]);
    // A stopped run whose worker pane asks needs you; one whose pane works is working.
    const stopped = run("a", { attention: "stopped" });
    expect(runWithPanes(stopped, ["idle", "asks"])).toBe("needs you");
    expect(runWithPanes(stopped, ["working", "exited"])).toBe("working");
    expect(runWithPanes(stopped, [])).toBe("idle");
    // The panes of a finished run say nothing about it.
    const done = run("a", { attention: "done", status: "done" });
    expect(runWithPanes(done, ["working"])).toBe("done");
    // A repository is the roll-up of its runs.
    expect(rollUp([runWithPanes(stopped, ["working"]), runStateOf(done)])).toBe("working");
  });

  test("what was opened is kept as a map that survives bad storage and never grows without end", () => {
    expect(seenKey({ runId: "r", repo: "fe" })).toBe("fe/r");
    expect(seenKey({ runId: "r" })).toBe("/r");
    expect(seenFrom(null)).toEqual({});
    expect(seenFrom("not json")).toEqual({});
    expect(seenFrom("[1,2]")).toEqual({});
    expect(seenFrom('{"/a":"2026-11-13T10:00:00.000Z","/b":5}')).toEqual({
      "/a": "2026-11-13T10:00:00.000Z",
    });
    const three = withSeen(withSeen(withSeen({}, "/a", "1"), "/b", "2"), "/c", "3", 2);
    expect(three).toEqual({ "/c": "3", "/b": "2" });
    expect(withSeen({ "/a": "1" }, "/a", "9")).toEqual({ "/a": "9" });
  });

  const question = (runId: string, id: string, source: "gate" | "agent" | "permission", extra = {}) =>
    ({
      runId,
      task: `task of ${runId}`,
      stage: "build",
      driving: false,
      waitedMs: 65_000,
      question: {
        id,
        runId,
        stage: "build",
        source,
        prompt: `prompt ${id}`,
        options: [],
        multiSelect: false,
        askedAt: "",
      },
      ...extra,
    }) as never;

  test("what needs you is one queue: questions, then terminal asks, then escalated runs", () => {
    const runs = [
      run("r1", { task: "Add the discount" }),
      { ...run("r2", { task: "Round the totals", attention: "you" }), terminalAsk: "w2:p1" },
      run("r3", {
        task: "Check the totals",
        status: "escalated",
        attention: "escalated",
        stage: "check",
        reason: "gate failed",
      }),
    ];
    const rows = needsQueue(
      [question("r1", "q1", "gate"), question("r1", "q2", "permission", { repo: "fe" })],
      runs,
    );
    expect(rows.map((r) => [r.key, r.kind, r.title])).toEqual([
      ["r1/q1", "approval", "prompt q1"],
      ["r1/q2", "permission", "prompt q2"],
      ["terminal::r2", "terminal", "Round the totals"],
      ["escalated::r3", "escalated", "Check the totals"],
    ]);
    // One dim line: the run's task, the stage and how long it has waited; a question of a
    // repository the state does not list falls back to the item's own task.
    expect(rows[0]?.sub).toBe("Add the discount · build · 1 min");
    expect(rows[1]?.sub).toBe("task of r1 · fe · build · 1 min");
    expect(rows[2]).toMatchObject({ sub: "answers in its terminal · build", pane: "w2:p1" });
    expect(rows[3]).toMatchObject({ sub: "stopped at check · r3", hint: "gate failed" });
    // The hover of a question carries what the card's chips say.
    expect(rows[1]?.hint).toBe("prompt q2 · can be allowed always");
    expect(terminalKey({ runId: "r2", repo: "fe" })).toBe("terminal:fe:r2");
    expect(needsQueue([], [run("a")])).toEqual([]);
  });

  test("the Inbox shows the picked row, else the first; j/k and the arrows move around the ends", () => {
    const rows = needsQueue([question("r1", "q1", "gate"), question("r1", "q2", "agent")], [run("r1")]);
    expect(pickedNeed(rows, "r1/q2")?.key).toBe("r1/q2");
    expect(pickedNeed(rows, "gone")?.key).toBe("r1/q1");
    expect(pickedNeed(rows, undefined)?.key).toBe("r1/q1");
    expect(pickedNeed([], "x")).toBeUndefined();
    expect(stepNeed(rows, undefined, 1)?.key).toBe("r1/q2");
    expect(stepNeed(rows, "r1/q2", 1)?.key).toBe("r1/q1");
    expect(stepNeed(rows, "r1/q1", -1)?.key).toBe("r1/q2");
    expect(stepNeed([], undefined, 1)).toBeUndefined();
  });

  test("the runs of a repository: who needs a person first, the steps of a split run under it", () => {
    const runs = [
      run("p", { createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" }),
      run("s2", { parent: "p", createdAt: "2026-11-02T10:02:00.000Z", attention: "you" }),
      run("s1", { parent: "p", createdAt: "2026-11-02T10:01:00.000Z" }),
      run("solo", { attention: "you", updatedAt: "2026-11-02T11:00:00.000Z" }),
      run("orphan", { parent: "gone", attention: "stopped" }),
    ];
    expect(sidebarRuns(runs).map((x) => [x.run.runId, x.nested, x.step])).toEqual([
      ["solo", false, undefined],
      ["p", false, undefined],
      ["s1", true, "step 1/2"],
      ["s2", true, "step 2/2"],
      ["orphan", false, undefined],
    ]);
    expect(sidebarRuns([])).toEqual([]);
  });

  test("one dim line under a run: its step, that it asks on its terminal, stage · host · age", () => {
    expect(runLine({ stage: "build", host: "copilot", elapsedMs: 240_000 })).toBe("build · copilot · 4 min");
    expect(runLine({ stage: "plan", elapsedMs: 5000, terminalAsk: "w1:p1" }, "step 2/3")).toBe(
      "step 2/3 · asks in its terminal · plan · no host · 5s",
    );
  });

  test("the agent a run begins with is ready for a task: idle, never asks", () => {
    const intake = (state?: string) =>
      ({
        process: { kind: "host", host: "copilot", agent: "mt-orchestrator", prompt: "" },
        live: { alive: true },
        ...(state ? { state: { state, reason: "" } } : {}),
      }) as never;
    expect(isIntake(intake())).toBe(true);
    expect(isIntake({ process: { kind: "command", argv: ["sh"] } } as never)).toBe(false);
    expect(isIntake({ ...(intake() as object), runId: "r1" } as never)).toBe(false);
    expect(paneStateOf(intake("blocked"))).toBe("idle");
    expect(paneStateOf(intake("waiting"))).toBe("idle");
    expect(paneStateOf(intake("working"))).toBe("working");
    expect(paneNote(intake(), "idle")).toBe("ready for your task");
    expect(paneNote(intake(), "working")).toBeUndefined();
    expect(paneNote({ ...(intake() as object), runId: "r1" } as never, "idle")).toBeUndefined();
  });

  test("with no run and nothing to decide the app offers to start; an answer is confirmed in words", () => {
    expect(isFirstRun([], [])).toBe(true);
    expect(isFirstRun([run("a")], [])).toBe(false);
    expect(isFirstRun([], [{}])).toBe(false);
    expect(answeredText(["Approve"])).toBe("Answered: Approve. The run goes on.");
    expect(answeredText(["EUR", "USD"])).toBe("Answered: EUR, USD. The run goes on.");
  });

  test("the help filters by a key or by what it does; each letter of the shell means one thing", () => {
    expect(filterKeys(SHELL_KEYS, "")).toHaveLength(SHELL_KEYS.length);
    expect(filterKeys(SHELL_KEYS, "ATTACH").map((k) => k.keys)).toEqual(["a / c"]);
    expect(filterKeys(helpRows(DEFAULT_KEYS), "zoom").map((k) => k.id)).toEqual(["zoom"]);
    expect(filterKeys(helpRows(DEFAULT_KEYS), "ctrl+b z").map((k) => k.id)).toEqual(["zoom"]);
    expect(filterKeys(SHELL_KEYS, "no such thing")).toEqual([]);
    // No single letter is listed twice among the keys of every screen, and the run's tabs use theirs.
    const letters = SHELL_KEYS.flatMap((k) => k.keys.split(/[\s/]+/)).filter((k) => /^[a-z?]$/.test(k));
    expect(new Set(letters).size).toBe(letters.length);
    for (const t of RUN_TABS) expect(letters).toContain(t.key);
  });
});
