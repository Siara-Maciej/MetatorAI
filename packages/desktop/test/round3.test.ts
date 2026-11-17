import { describe, expect, test } from "bun:test";
import type { Plan, RunOverview, SystemMap, SystemPlan } from "../src/api.ts";
import {
  artifactBlocks,
  compactLines,
  GRAPH,
  goesToPane,
  graphLayout,
  groupStepText,
  idleRuns,
  linkPath,
  lintSummary,
  needsQueue,
  paneOfPrompt,
  paneStateOf,
  parseRoute,
  problemsAt,
  quietInboxText,
  type Run,
  readableReason,
  routeHash,
  sidebarRuns,
  sizeText,
  stepOf,
  systemPlanOf,
  whoWorks,
} from "../src/model.ts";
import {
  blankStep,
  conflictCurrent,
  documentText,
  itemChangeLines,
  listOf,
  mapChanges,
  moved,
  nextId,
  parseDocumentText,
  planChanges,
  refusedProblems,
  sourceOf,
  sourceText,
  stepLocked,
  systemPlanChanges,
  textOf,
  withoutStep,
  withoutSystemStep,
  withStep,
  withStepChanged,
  withStepMoved,
  withSystemStep,
  withSystemStepChanged,
} from "../src/plan-edit.ts";

const run = (runId: string, extra: Partial<Run> = {}): Run =>
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
    createdAt: "2026-11-15T10:00:00.000Z",
    updatedAt: "2026-11-15T10:00:00.000Z",
    elapsedMs: 0,
    services: [],
    ...extra,
  }) as Run;

describe("the steps of a system plan across repositories (defect 13)", () => {
  const parent = run("sys", { repo: "shop-api", workflow: "mt-system-change", children: ["a"] });
  const a = run("a", { parent: "sys", repo: "shop-api", createdAt: "2026-11-15T10:01:00.000Z" });
  const b = run("b", { parent: "sys", repo: "shop-web", createdAt: "2026-11-15T10:02:00.000Z" });

  test("a step counts out of the plan's steps when the plan is known, and never says a wrong total", () => {
    expect(stepOf(a, [a], parent, 2)).toBe("step 1/2");
    // Only one of two steps started and the plan unknown: no "step 1/1".
    expect(stepOf(a, [a], parent)).toBe("step 1");
    // A finished parent's own list of children is the whole plan.
    expect(stepOf(b, [a, b], { ...parent, status: "done", children: ["a", "b"] })).toBe("step 2/2");
    // A plan number smaller than the place is not believed.
    expect(stepOf(b, [a, b], parent, 1)).toBe("step 2");
  });

  test("a step in another repository sits under its parent, with its repository named", () => {
    const all = [parent, a, b];
    const api = sidebarRuns([parent, a], all, () => 2);
    expect(api.map((x) => [x.run.runId, x.nested, x.step, x.elsewhere])).toEqual([
      ["sys", false, undefined, undefined],
      ["a", true, "step 1/2", undefined],
      ["b", true, "step 2/2", "shop-web"],
    ]);
    // In its own repository the step is not listed again.
    expect(sidebarRuns([b], all).map((x) => x.run.runId)).toEqual([]);
    // Its parent not open: it stands alone.
    expect(sidebarRuns([b], [b]).map((x) => [x.run.runId, x.nested])).toEqual([["b", false]]);
  });

  test("the system plan of a run: by a step's child run, else by the run's task", () => {
    const plans = [
      { plan: { task: "Other" }, steps: [{ run: "x" }] },
      { plan: { task: "Add currency" }, steps: [{ run: "a" }, { run: undefined }] },
    ] as never[];
    expect(systemPlanOf(plans, parent, [a])).toBe(plans[1]);
    expect(systemPlanOf(plans, run("sys2", { task: "Add currency" }), [])).toBe(plans[1]);
    expect(systemPlanOf(plans, run("z"), [])).toBeUndefined();
  });
});

describe("panes and runs read what is true (defects 8, 14, 16, 20)", () => {
  const pane = (live: object | undefined, state?: string) =>
    ({
      process: { kind: "host", host: "scenario", agent: "mt-implementer", prompt: "" },
      runId: "r",
      ...(live ? { live } : {}),
      ...(state ? { state: { state, reason: "" } } : {}),
    }) as never;

  test("a worker that ended with code 0 finished its work; any other end is an exit", () => {
    expect(paneStateOf(pane({ alive: false, exitCode: 0 }, "exited"))).toBe("finished");
    expect(paneStateOf(pane({ alive: false, exitCode: 3 }, "exited"))).toBe("exited");
    expect(paneStateOf(pane({ alive: false }, "exited"))).toBe("exited");
    expect(paneStateOf(pane(undefined))).toBe("exited");
  });

  test("an open run nothing works on is idle: no question, no drive, no live pane, nobody at the keyboard", () => {
    const quiet = run("q", { driving: false, attention: "stopped", repo: "web" });
    const runs = [
      quiet,
      run("driven"),
      run("asking", { driving: false, attention: "you", questions: [{} as never] }),
      run("held", { driving: false, attention: "stopped", driver: "human" }),
      run("live", { driving: false, attention: "stopped" }),
      run("done", { driving: false, status: "done", attention: "done" }),
    ];
    const panes = [
      { runId: "live", live: { alive: true } },
      { runId: "q", repo: "api", live: { alive: true } },
    ] as never[];
    expect(idleRuns(runs, panes).map((r) => r.runId)).toEqual(["q"]);
    expect(quietInboxText(0, 0)).toBe(
      "No run is open. Open a finished run from the sidebar, or start a new one.",
    );
    expect(quietInboxText(2, 0)).toBe("Nothing needs you. 2 runs are working.");
    expect(quietInboxText(2, 1)).toBe("Nothing needs you. 1 run has no agent working on it:");
    expect(quietInboxText(3, 2)).toBe("Nothing needs you. 2 runs have no agent working on them:");
  });

  test("who works on a run: its person, the agent while something drives it, else nobody", () => {
    expect(whoWorks(run("a", { driver: "human", attachedBy: "ana" }), false)).toBe("ana");
    expect(whoWorks(run("a"), false)).toBe("agent");
    expect(whoWorks(run("a", { driving: false }), true)).toBe("agent");
    expect(whoWorks(run("a", { driving: false }), false)).toBe("nobody");
    expect(whoWorks(run("a", { status: "done" }), true)).toBe("nobody");
  });
});

describe("the Inbox's cards (defects 9, 12, 17, 19)", () => {
  test("Attach and answer in the pane names the pane to go to; any other answer stays on the card", () => {
    const prompt = "scenario waits for your answer in pane w1:p4: The currency? [ISO / symbol]";
    expect(paneOfPrompt(prompt)).toBe("w1:p4");
    expect(paneOfPrompt("Approve the plan?")).toBeUndefined();
    expect(goesToPane({ source: "permission" }, "Attach and answer in the pane")).toBe(true);
    expect(goesToPane({ source: "permission" }, "Leave it")).toBe(false);
    // Round 4: the daemon offers the pane on an agent's terminal question too; the answer, not the source, decides.
    expect(goesToPane({ source: "agent" }, "Attach and answer in the pane")).toBe(true);
  });

  test("a long list keeps the newest lines and counts a line repeated, so the options stay in view", () => {
    const loop = [
      "plan-approval APPROVE",
      ...Array.from({ length: 12 }, () => ["children PASS", "status FAIL: 2 steps"]).flat(),
    ];
    const { shown, hidden } = compactLines(loop, 4);
    expect(shown).toEqual([
      { text: "plan-approval APPROVE", times: 1 },
      { text: "children PASS", times: 12 },
      { text: "status FAIL: 2 steps", times: 12 },
    ]);
    expect(hidden).toBe(0);
    const many = compactLines(["a", "b", "c", "d", "e", "f"], 4);
    expect(many.shown.map((l) => l.text)).toEqual(["c", "d", "e", "f"]);
    expect(many.hidden).toBe(2);
    expect(compactLines([], 4)).toEqual({ shown: [], hidden: 0 });
  });

  test("an escalation's JSON error reads as its message and hint, with the command and the tries", () => {
    const raw =
      '`metator system plan run --run {runDir}` failed: {"ok":false,"error":{"code":"USAGE","message":"add-currency-to-prices is not approved","hint":"A person approves it."}} (loop 1 of 3)';
    expect(readableReason(raw)).toEqual({
      text: "add-currency-to-prices is not approved",
      hint: "A person approves it.",
      command: "metator system plan run --run {runDir}",
      tries: "1 of 3",
    });
    expect(readableReason("FAIL: gate `test -f x`:").text).toBe("FAIL: gate `test -f x`:");
    expect(readableReason("broken {json").text).toBe("broken {json");
    expect(readableReason(undefined).text).toContain("no reason");
  });

  test("a question on a terminal names the worker that asks and its stage", () => {
    const panes = [
      {
        id: "w1:p4",
        role: "worker",
        label: "mt-implementer-1",
        worker: { name: "mt-implementer-1", stage: "build" },
        process: { kind: "host", host: "scenario", agent: "mt-implementer", prompt: "" },
      },
    ] as never[];
    const item = {
      runId: "r",
      task: "t",
      stage: "session",
      driving: false,
      waitedMs: 3000,
      question: {
        id: "q1",
        runId: "r",
        stage: "session",
        source: "permission",
        agent: "scenario",
        prompt: "scenario waits for your answer in pane w1:p4: Which?",
        options: [],
        multiSelect: false,
        askedAt: "",
      },
    } as never;
    const rows = needsQueue([item], [{ ...run("r", { terminalAsk: "w1:p4" }), task: "Round" } as Run], panes);
    expect(rows[0]?.sub).toBe("Round · mt-implementer-1 · build · 3s");
    expect(rows[1]?.sub).toBe("answers in its terminal · mt-implementer-1 · build");
  });
});

describe("the dependencies graph (defect 15)", () => {
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  test("a child is right of its parent across lanes; the arrow ends at the child's left edge", () => {
    const sys = run("sys", { repo: "api", children: ["a", "b"] });
    const a = run("a", { repo: "api", parent: "sys", createdAt: "2026-11-15T10:01:00.000Z" });
    const b = run("b", { repo: "web", parent: "sys", createdAt: "2026-11-15T10:02:00.000Z" });
    const g = graphLayout([sys, a, b], ["api", "web"], now);
    const at = (id: string) => g.nodes.find((n) => n.run.runId === id) as { x: number; y: number };
    expect(at("a").x).toBeGreaterThan(at("sys").x);
    expect(at("b").x).toBeGreaterThan(at("sys").x);
    expect(at("b").y).toBeGreaterThan(at("sys").y);
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([
      ["sys", "a"],
      ["sys", "b"],
    ]);
    const toB = g.edges[1]?.d ?? "";
    expect(toB.startsWith(`M ${at("sys").x + GRAPH.W} `)).toBe(true);
    expect(toB.endsWith(`${at("b").x} ${at("b").y + GRAPH.H / 2}`)).toBe(true);
    expect(g.width).toBeGreaterThanOrEqual(at("b").x + GRAPH.W);
  });

  test("finished runs stay, dimmed, for a day or while linked to an open run; older ones go", () => {
    const old = run("old", { status: "done", updatedAt: "2026-11-13T10:00:00.000Z" });
    const recent = run("recent", { status: "done", updatedAt: "2026-11-15T11:00:00.000Z" });
    const parentOfOpen = run("p", { status: "done", updatedAt: "2026-11-10T10:00:00.000Z", children: ["c"] });
    const child = run("c", { parent: "p" });
    const g = graphLayout([old, recent, parentOfOpen, child], [""], now);
    expect(g.nodes.map((n) => [n.run.runId, n.finished]).sort()).toEqual([
      ["c", false],
      ["p", true],
      ["recent", true],
    ]);
  });

  test("two runs of a lane at one depth take two columns; a link never joins a card to itself", () => {
    const g = graphLayout([run("a"), run("b")], [""], now);
    expect(new Set(g.nodes.map((n) => n.x)).size).toBe(2);
    const n = g.nodes[0];
    expect(linkPath(n, n)).toBeUndefined();
    expect(linkPath(undefined, n)).toBeUndefined();
    expect(linkPath(g.nodes[0], g.nodes[1])?.startsWith("M ")).toBe(true);
  });
});

describe("artifacts and lint", () => {
  test("Markdown: headings and fenced code apart, the rest as text, never HTML", () => {
    const md = "# Plan\n\n1. A <b>test</b>\n2. Code\n\n```ts\nconst a = 1;\n```\nafter";
    expect(artifactBlocks("markdown", md)).toEqual([
      { kind: "heading", text: "Plan" },
      { kind: "text", text: "1. A <b>test</b>\n2. Code" },
      { kind: "code", text: "const a = 1;" },
      { kind: "text", text: "after" },
    ]);
    expect(artifactBlocks("markdown", "```\nnever closed")).toEqual([{ kind: "code", text: "never closed" }]);
  });

  test("JSON pretty-printed (as it is when it does not parse); YAML and text as they are", () => {
    expect(artifactBlocks("json", '{"a":1}')).toEqual([{ kind: "code", text: '{\n  "a": 1\n}' }]);
    expect(artifactBlocks("json", "{oops")).toEqual([{ kind: "code", text: "{oops" }]);
    expect(artifactBlocks("yaml", "a: 1")).toEqual([{ kind: "code", text: "a: 1" }]);
    expect(artifactBlocks("text", "hi")).toEqual([{ kind: "code", text: "hi" }]);
  });

  test("sizes and lint read in a few words; a step's problems are found by its id and field", () => {
    expect([sizeText(812), sizeText(4300), sizeText(1.5 * 1024 * 1024)]).toEqual([
      "812 B",
      "4.2 KB",
      "1.5 MB",
    ]);
    const problems = [
      { severity: "error" as const, message: "no file", step: "S1", field: "steps.0.path" },
      { severity: "warning" as const, message: "no test", step: "S1", field: "testsFirst" },
      { severity: "error" as const, message: "scope empty", field: "scope" },
    ];
    expect(lintSummary({ problems })).toBe("2 errors · 1 warning");
    expect(lintSummary({ problems: [] })).toBe("no problems");
    expect(problemsAt(problems, "S1").length).toBe(2);
    expect(problemsAt(problems, "S1", "path").map((p) => p.message)).toEqual(["no file"]);
    expect(problemsAt(problems, undefined, "scope").map((p) => p.message)).toEqual(["scope empty"]);
  });

  test("the System tab of Overview has its own address", () => {
    expect(parseRoute("#/overview/system")).toEqual({ screen: "overview", tab: "system" });
    expect(routeHash({ screen: "overview", tab: "system" })).toBe("#/overview/system");
    expect(routeHash({ screen: "overview", tab: "daemon" })).toBe("#/overview");
  });
});

describe("editing a run's plan", () => {
  const plan: Plan = {
    task: "Add currency",
    scope: ["src"],
    steps: [
      {
        id: "S1",
        action: "create",
        path: "test/a.test.ts",
        intent: "a test",
        rules: [],
        testsFirst: [],
        dependsOn: [],
      },
      {
        id: "S2",
        action: "modify",
        path: "src/a.ts",
        intent: "the code",
        rules: [],
        testsFirst: ["test/a.test.ts"],
        dependsOn: ["S1"],
      },
    ],
  };

  test("lists in one field, ids in order, a step moved one place at a time", () => {
    expect(listOf("a, b,, c\nd")).toEqual(["a", "b", "c", "d"]);
    expect(textOf(["a", "b"])).toBe("a, b");
    expect(textOf(undefined)).toBe("");
    expect(nextId(["S1", "S7", "x"], "S")).toBe("S8");
    expect(nextId([], "step-")).toBe("step-1");
    expect(moved([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moved([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moved([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });

  test("a step added at the end with the next id; removed, nothing waits on it any more", () => {
    expect(blankStep(plan).id).toBe("S3");
    expect(withStep(plan).steps.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    expect(withoutStep(plan, "S1").steps).toEqual([
      { ...(plan.steps[1] as Plan["steps"][number]), dependsOn: [] },
    ]);
    expect(withStepMoved(plan, "S2", -1).steps.map((s) => s.id)).toEqual(["S2", "S1"]);
  });

  test("a field changed; an exemplar set keeps the pattern's name, cleared drops it", () => {
    const set = withStepChanged(plan, "S2", { intent: "code", exemplar: "src/b.ts:3" });
    expect(set.steps[1]?.intent).toBe("code");
    expect(set.steps[1]?.patternSource).toEqual({ pattern: "", reason: "", exemplar: "src/b.ts:3" });
    expect(withStepChanged(set, "S2", { exemplar: " " }).steps[1]?.patternSource).toBeUndefined();
    expect(withStepChanged(plan, "S9", { intent: "x" })).toEqual(plan);
  });

  test("what a save changes, in words, before it is saved", () => {
    const after = withStepMoved(withStepChanged(withStep(plan), "S1", { path: "test/b.test.ts" }), "S2", -1);
    expect(planChanges(plan, after)).toEqual(["step added: S3", "step S1 changed: path", "steps reordered"]);
    expect(planChanges(plan, plan)).toEqual([]);
    expect(planChanges(plan, { ...plan, scope: ["src", "test"] })).toEqual(["changed: scope"]);
    expect(itemChangeLines("x", [{ id: "a" }], [])).toEqual(["x removed: a"]);
  });

  test("the plan as text without its header, and back; text that does not parse says where", () => {
    const text = documentText({ kind: "Plan", schemaVersion: 1, ...plan });
    expect(text).not.toContain("schemaVersion");
    expect(parseDocumentText(text)).toEqual({ ok: true, value: plan });
    const broken = parseDocumentText('{\n  "task": "x",\n  oops\n}');
    expect(broken.ok).toBe(false);
    // Chromium names the line; an engine that does not leaves the text as the place.
    if (!broken.ok) expect(["line 3", "(text)"]).toContain(broken.problem.field ?? "");
    const list = parseDocumentText("[1]");
    expect(list.ok).toBe(false);
  });

  test("a refused save's problems, and a conflict's version as it is now", () => {
    const problems = [{ severity: "error" as const, field: "steps.0.path", message: "required" }];
    expect(refusedProblems({ problems })).toEqual(problems);
    expect(refusedProblems(undefined)).toEqual([]);
    expect(conflictCurrent({ code: "CONFLICT", details: { current: { digest: "d2" } } })).toEqual({
      digest: "d2",
    });
    expect(conflictCurrent({ code: "USAGE", details: { current: {} } })).toBeUndefined();
  });
});

describe("editing a system plan and the map", () => {
  const plan = {
    id: "add-currency",
    task: "Add currency",
    status: "draft",
    steps: [
      {
        id: "api-change",
        app: "shop-api",
        summary: "api",
        contracts: [],
        dependsOn: [],
        status: "done",
        run: "r1",
      },
      {
        id: "web-show",
        app: "shop-web",
        summary: "web",
        contracts: [],
        dependsOn: ["api-change"],
        status: "pending",
      },
    ],
  } as unknown as SystemPlan;

  test("a step with a run is history: not changed, not removed; a new one is added", () => {
    expect(stepLocked(plan.steps[0] as never)).toBe(true);
    expect(withoutSystemStep(plan, "api-change")).toBe(plan);
    expect(withSystemStepChanged(plan, "api-change", { summary: "x" })).toEqual(plan);
    expect(withSystemStepChanged(plan, "web-show", { summary: "show it" }).steps[1]?.summary).toBe("show it");
    expect(withoutSystemStep(plan, "web-show").steps.map((s) => s.id)).toEqual(["api-change"]);
    const added = withSystemStep(plan);
    expect(added.steps[2]).toMatchObject({ id: "step-1", status: "pending", dependsOn: [] });
    expect(systemPlanChanges(plan, added)).toEqual(["step added: step-1"]);
  });

  test("where an application's code is, in one field", () => {
    expect(sourceText({ path: "apps/web" })).toBe("apps/web");
    expect(sourceText({ repo: "acme/shop-web", ref: "main", path: "web" })).toBe(
      "repo:acme/shop-web@main:web",
    );
    expect(sourceText({ repo: "acme/shop-web" })).toBe("repo:acme/shop-web");
    expect(sourceOf("repo:acme/shop-web@v2:web")).toEqual({ repo: "acme/shop-web", ref: "v2", path: "web" });
    expect(sourceOf("repo:acme/shop-web")).toEqual({ repo: "acme/shop-web" });
    expect(sourceOf(sourceText({ repo: "a/b", path: "x" }))).toEqual({ repo: "a/b", path: "x" });
    expect(sourceOf("apps/web")).toEqual({ path: "apps/web" });
    expect(sourceOf("./web")).toEqual({ path: "./web" });
    expect(sourceOf("")).toEqual({ path: "." });
  });

  test("what a save of the map changes", () => {
    const map = {
      system: "shop",
      applications: [{ id: "shop-api", kind: "service", source: { path: "." }, owners: [], consumes: [] }],
      contracts: [],
      policies: { deployOrder: "providers-first", breaking: "expand-contract" },
    } as unknown as SystemMap;
    const after = { ...map, applications: [{ ...map.applications[0], kind: "worker" }] } as SystemMap;
    expect(mapChanges(map, after)).toEqual(["application shop-api changed: kind"]);
  });
});

// Keep the type import used.
export type { RunOverview };

describe("groupStepText", () => {
  test("the system plan's step count wins over the children started so far", () => {
    expect(groupStepText({ step: 1, of: 1 }, 2, false)).toBe("step 1 of 2");
  });
  test("without a plan, an open parent's total is not known yet", () => {
    expect(groupStepText({ step: 1, of: 1 }, undefined, false)).toBe("step 1");
  });
  test("a finished parent's children are all there", () => {
    expect(groupStepText({ step: 2, of: 3 }, undefined, true)).toBe("step 2 of 3");
  });
  test("a plan smaller than the step does not shrink the count", () => {
    expect(groupStepText({ step: 3, of: 3 }, 2, false)).toBe("step 3");
  });
});
