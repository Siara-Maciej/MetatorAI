import { describe, expect, test } from "bun:test";
import type { InboxItem, RunOverview } from "../src/api.ts";
import {
  actionOf,
  answerCommand,
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
  finishedText,
  flattenState,
  gotoRows,
  groupByFeature,
  helpRows,
  hostChoice,
  inboxChips,
  isFinished,
  keyLabel,
  keyMapOf,
  keyText,
  LOOKS,
  lookOf,
  menuCommands,
  needsPerson,
  needsReason,
  neighborPane,
  newQuestions,
  nextWaiting,
  nextWaitingTab,
  noHostText,
  notifies,
  openRuns,
  optionMatches,
  paneLabel,
  paneStateOf,
  panesOfRun,
  parseRoute,
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
  routeHash,
  runCounts,
  runIdOf,
  runPhase,
  SHELL_KEYS,
  SHELL_QUIET_MS,
  sameRepo,
  stageGlyph,
  stepLabel,
  tabOfPane,
  tabOfRun,
  toastOf,
  toggleChoice,
  treeLeavesOf,
  WORKBENCH_COMMANDS,
  wasAway,
  withRatio,
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

  test("stage glyphs", () => {
    expect(
      ["done", "current", "waiting", "stopped", "next"]
        .map((state) => stageGlyph({ state: state as never }))
        .join(""),
    ).toBe("✓⟳?✕·");
  });

  test("routes parse and print both ways; anything unknown is the inbox", () => {
    expect(parseRoute("#/session/2026%2Fa")).toEqual({ screen: "session", runId: "2026/a" });
    expect(parseRoute("#/session/r/w1%3Ap2")).toEqual({ screen: "session", runId: "r", pane: "w1:p2" });
    expect(parseRoute("#/grid/p")).toEqual({ screen: "grid", group: "p" });
    expect(parseRoute("#/grid")).toEqual({ screen: "grid" });
    expect(parseRoute("#/briefing/r")).toEqual({ screen: "briefing", runId: "r" });
    expect(parseRoute("#/briefing")).toEqual({ screen: "inbox" });
    expect(parseRoute("")).toEqual({ screen: "inbox" });
    expect(parseRoute("#/nope")).toEqual({ screen: "inbox" });
    for (const hash of [
      "#/inbox",
      "#/inbox/r%2Fq001",
      "#/session/r",
      "#/session/r/w1%3Ap2",
      "#/grid",
      "#/grid/p",
      "#/graph",
      "#/supervisor",
      "#/briefing/r",
    ])
      expect(routeHash(parseRoute(hash))).toBe(hash);
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
    // The stage bar's glyph is the table's.
    for (const state of ["done", "current", "waiting", "stopped", "next"] as const)
      expect(stageGlyph({ state })).toBe(LOOKS.stage[state].glyph);
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
  test("session, plan, changes and briefing are about a run; the list screens are not", () => {
    expect(RUN_TABS.map((t) => t.screen)).toEqual(["session", "plan", "review", "briefing"]);
    for (const t of RUN_TABS) expect(runIdOf({ screen: t.screen, runId: "r1" })).toBe("r1");
    expect(runIdOf({ screen: "inbox" })).toBeUndefined();
    expect(runIdOf({ screen: "grid", pane: "p" })).toBeUndefined();
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
