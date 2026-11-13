import { describe, expect, test } from "bun:test";
import type { InboxItem, RunOverview } from "../src/api.ts";
import {
  actionOf,
  answerCommand,
  artifactText,
  autonomyLabel,
  autonomyLevels,
  byPanelOrder,
  canAnswer,
  chordOf,
  DEFAULT_KEYS,
  duration,
  escalatedKey,
  evenTree,
  goalShown,
  gotoRows,
  groupByFeature,
  hostChoice,
  inboxChips,
  isFinished,
  keyMapOf,
  keyText,
  needsReason,
  neighborPane,
  newQuestions,
  nextWaiting,
  noHostText,
  notifies,
  optionMatches,
  paneLabel,
  panesOfRun,
  parseRoute,
  plainKey,
  questionKind,
  refusedForDirtyTree,
  repoChoice,
  resumeNotice,
  resumePlan,
  resumeStages,
  routeHash,
  stageGlyph,
  stateTone,
  stepLabel,
  toggleChoice,
  treeLeavesOf,
  wasAway,
  withoutPanes,
  withRatio,
  withTerminalAsks,
  workbenchRepos,
  workflowChoice,
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

  test("a run's panes: the conductor first, workers next, shells last; labels and state tones", () => {
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
    expect(
      ["blocked", "waiting", "working", "idle", "exited", undefined].map((s) => stateTone(s as never)),
    ).toEqual(["amber", "amber", "violet", undefined, "red", undefined]);
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
    expect(gotoRows(repos, panes as never, "blocked", "").map((r) => r.id)).toEqual(["w2:p1", "r1/q1"]);
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

describe("resuming at an earlier stage, and reading what is decided", () => {
  test("the card offers the stages the daemon names, and always the one the run stopped at", () => {
    expect(resumeStages({ stage: "check", resumable: ["plan", "approval", "check"] })).toEqual([
      "plan",
      "approval",
      "check",
    ]);
    // An older daemon names none: the stage it stopped at is still offered.
    expect(resumeStages({ stage: "check" })).toEqual(["check"]);
    expect(resumeStages({ stage: "check", resumable: ["plan"] })).toEqual(["plan", "check"]);
  });

  test("what Resume will do is said before it is done", () => {
    expect(resumePlan("check", "check")).toBe(
      "the run goes back to check with a fresh set of tries and is driven on",
    );
    expect(resumePlan("check", "plan")).toBe(
      "the run goes back to plan and works from there to check again; approvals on the way are asked again",
    );
  });

  test("the goal is shown only when the title does not already carry the whole task", () => {
    expect(goalShown('Approve the plan for "Add a discount"?', " Add a discount ")).toBe(false);
    expect(goalShown('Approve the plan for "Add a discount"?', "Add a discount\n\nwith details")).toBe(true);
    expect(goalShown("Which currency?", "Add a discount")).toBe(true);
  });

  test("a JSON artifact is indented for reading; anything else, and broken JSON, stays as written", () => {
    expect(artifactText("plan.json", '{"a":[1,{"b":2}]}')).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ]\n}',
    );
    expect(artifactText("plan.json", "{broken")).toBe("{broken");
    expect(artifactText("plan.md", '{"a":1}')).toBe('{"a":1}');
  });

  test("a pane being replaced is cut out of its tab's tree; a split left with one side is that side", () => {
    const tree = evenTree(["a", "b", "c"]);
    expect(withoutPanes(tree, new Set())).toBe(tree);
    expect(treeLeavesOf(withoutPanes(tree, new Set(["b"])) as never)).toEqual(["a", "c"]);
    expect(withoutPanes(evenTree(["a", "b"]), new Set(["a"]))).toEqual({ pane: "b" });
    expect(withoutPanes({ pane: "a" }, new Set(["a"]))).toBeUndefined();
    expect(withoutPanes(evenTree(["a", "b"]), new Set(["a", "b"]))).toBeUndefined();
    expect(withoutPanes(undefined, new Set(["a"]))).toBeUndefined();
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
