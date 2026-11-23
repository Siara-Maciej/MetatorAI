/** Analysis and plan in the Backlog (ADR-0096), on the in-memory file system. */
import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { BacklogWork } from "../src/application/backlog-work.ts";
import { IssueSnapshots } from "../src/application/issue-snapshots.ts";
import { Issues } from "../src/application/issues.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { SystemPlanStore } from "../src/application/system-plans.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { SystemPlan } from "../src/domain/system-plan.ts";
import type { Thread } from "../src/domain/thread.ts";

const FEATURE = `kind: Workflow
schemaVersion: 3
id: mt-feature
stages:
  - id: plan
    produces: [plan.json]
  - id: plan-gate
  - id: plan-approval
    hitl: true
  - id: build
`;
const PLAN = JSON.stringify({
  kind: "Plan",
  schemaVersion: 1,
  task: "Round prices",
  scope: ["src/**"],
  steps: [
    {
      id: "S1",
      action: "modify",
      path: "src/price.ts",
      intent: "round half up",
      testsFirst: ["test/price.test.ts"],
    },
  ],
});

function world() {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/mt-feature.yml": FEATURE,
    "src/price.ts": "export const round = 1;\n",
    "test/price.test.ts": "test\n",
  });
  const clock = new FixedClock(new Date("2026-11-22T09:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const catalog = new (require("../src/application/workflow-catalog.ts").WorkflowCatalog)(fs, DEFAULT_PATHS);
  const initRun = new InitRun(catalog, repo, clock);
  const advance = new AdvanceRun(catalog, repo, clock);
  const issues = new Issues({
    fs,
    paths: DEFAULT_PATHS,
    clock,
    journal: new RunJournal(fs, repo, clock),
    repo,
    initRun,
  });
  const changed: string[] = [];
  const snapshots = new IssueSnapshots({
    fs,
    hasher: { sha256: (t) => `h:${t.length}:${t.slice(0, 20)}` },
    vcs: { changedFiles: async () => ok(changed) },
    head: async () => ok("c0ffee"),
    workspace: { packages: async () => ok([{ name: "shop", dir: "src" }]) },
    clock,
    staleDays: async () => 14,
  });
  const threads = new Map<string, Thread>();
  const made: { title: string; from?: unknown; carry?: string; pane?: boolean }[] = [];
  const thread = (id: string, state: "open" | "closed", summary = ""): Thread => ({
    id,
    title: id,
    state,
    createdAt: "2026-11-20T09:00:00.000Z",
    updatedAt: "2026-11-20T09:00:00.000Z",
    summary,
    runs: [],
    issues: [],
    mrs: [],
    panes: [],
    facts: [],
  });
  const systemPlans = new SystemPlanStore(fs, "metator/system/plans");
  const stepsAsked: Record<string, unknown>[] = [];
  const work = new BacklogWork({
    issues,
    snapshots,
    fs,
    dir: DEFAULT_PATHS.issues,
    runs: repo,
    systemPlans,
    steps: {
      execute: async (input) => {
        stepsAsked.push(input as Record<string, unknown>);
        return ok({
          plan: (await systemPlans.load(input.id))._unsafeUnwrap(),
          step: input.step,
          app: "web",
          root: "/src/web",
          run: `20261122-mt-feature-step-${input.step}${input.plan ? "-plan" : ""}`,
          task: "t",
          session: { paneId: "w3:p1", host: "claude" },
        });
      },
    },
    threads: {
      show: async (id) => {
        const t = threads.get(id);
        return t ? ok(t) : err(MetatorError.notFound(`thread ${id}`));
      },
      create: async (input) => {
        made.push({
          title: input.title ?? "",
          ...(input.from ? { from: input.from } : {}),
          ...(input.carry ? { carry: input.carry } : {}),
          ...(input.pane !== undefined ? { pane: input.pane } : {}),
        });
        const t = thread(`20261122-new-${made.length}`, "open");
        threads.set(t.id, t);
        return ok({ thread: t });
      },
      addRun: async (id, runId) => {
        const t = threads.get(id) as Thread;
        const next = { ...t, runs: [...t.runs, runId] };
        threads.set(id, next);
        return ok(next);
      },
      addIssue: async (id, issue) => {
        const t = threads.get(id) as Thread;
        const next = { ...t, issues: [...t.issues, issue] };
        threads.set(id, next);
        return ok(next);
      },
      ofRun: async (runId) => [...threads.values()].find((t) => t.runs.includes(runId)),
    },
    facts: {
      dependents: async (file) => ok(file === "src/price.ts" ? ["src/cart.ts", "src/invoice.ts"] : []),
      similar: async () =>
        ok([
          {
            pattern: "money-helper",
            title: "",
            file: "src/money.ts",
            line: 3,
            exemplar: true,
            score: 1,
            reasons: [],
          },
        ]),
    },
    clock,
  });
  return { fs, clock, repo, advance, issues, work, changed, threads, thread, made, systemPlans, stepsAsked };
}

const ANALYSIS = "Prices round in src/price.ts:1; the test is test/price.test.ts:1.";

async function planned(w: ReturnType<typeof world>, id: string) {
  const plan = (await w.work.plan(id))._unsafeUnwrap();
  await w.fs.write(`${w.repo.runDir(plan.runId)}/plan.json`, PLAN);
  for (const event of [{ type: "PASS" }, { type: "PASS" }, { type: "APPROVE", by: "ana" }] as const)
    (await w.advance.execute({ runId: plan.runId, event }))._unsafeUnwrap();
  return plan.runId;
}

describe("BacklogWork: analysis", () => {
  test("recorded from the chat: a new open item, proposed by mt-chat, in the thread, with the text and the facts", async () => {
    const w = world();
    w.threads.set("20261122-prices", w.thread("20261122-prices", "open"));
    const item = (
      await w.work.analyze({ title: "Round prices", text: ANALYSIS, by: "ana", threadId: "20261122-prices" })
    )._unsafeUnwrap();
    expect(item).toMatchObject({
      id: "i001",
      status: "open",
      proposedBy: { agent: "mt-chat" },
      decidedBy: { by: "ana", decision: "added" },
      threadId: "20261122-prices",
      freshness: { analysis: { state: "fresh" } },
    });
    expect(item.analysis?.cites.map((c) => c.path)).toEqual(["src/price.ts", "test/price.test.ts"]);
    expect(item.analysis?.packages).toEqual(["shop"]);
    expect(w.threads.get("20261122-prices")?.issues).toEqual(["i001"]);
    const text = (await w.fs.read(".metator/issues/i001/analysis.md"))._unsafeUnwrap();
    expect(text).toBe(
      `${ANALYSIS}\n\n## Deterministic facts\n\nRecorded by MetatorAI at 2026-11-22T09:00:00.000Z, commit c0ffee.\n\n- Cited files (2): \`src/price.ts\`, \`test/price.test.ts\`\n- Packages: shop\n- Dependents (\`metator graph dependents --transitive\`): \`src/price.ts\` 2, \`test/price.test.ts\` 0\n- Exemplars (\`metator similar\`): \`src/price.ts\` → money-helper (\`src/money.ts:3\`), \`test/price.test.ts\` → money-helper (\`src/money.ts:3\`)\n`,
    );
  });

  test("an edit of a cited file makes it stale, and Make plan is refused until it is analysed again", async () => {
    const w = world();
    (await w.work.analyze({ title: "Round prices", text: ANALYSIS, by: "ana" }))._unsafeUnwrap();
    await w.fs.write("src/price.ts", "export const round = 2;\n");
    w.changed.push("src/price.ts");
    const refused = await w.work.plan("i001");
    expect(refused._unsafeUnwrapErr().message).toBe("the analysis is stale: src/price.ts; re-analyse first");
    const again = (await w.work.analyze({ issue: "i001", text: ANALYSIS, by: "ana" }))._unsafeUnwrap();
    expect(again.freshness.analysis).toEqual({ state: "fresh" });
    expect(again.analysis?.dirty).toEqual([{ path: "src/price.ts", sha256: expect.any(String) }]);
    expect((await w.work.plan("i001")).isOk()).toBe(true);
  });

  test("without a text or a title nothing is made", async () => {
    const w = world();
    expect((await w.work.analyze({ text: " ", title: "x", by: "ana" }))._unsafeUnwrapErr().code).toBe(
      "USAGE",
    );
    expect((await w.work.analyze({ text: ANALYSIS, by: "ana" }))._unsafeUnwrapErr().message).toBe(
      "a new item needs a title: --title <words>, or name one with --issue <id>",
    );
    expect((await w.issues.list())._unsafeUnwrap()).toEqual([]);
  });
});

describe("BacklogWork: plan and implement", () => {
  test("Make plan: a run of the item's workflow that stops planned; the next read links the plan", async () => {
    const w = world();
    (await w.work.analyze({ title: "Round prices", text: ANALYSIS, by: "ana" }))._unsafeUnwrap();
    const plan = (await w.work.plan("i001"))._unsafeUnwrap();
    expect(plan.issue).toMatchObject({ status: "in-progress", runId: plan.runId });
    const record = (await w.repo.load(plan.runId))._unsafeUnwrap();
    expect([record.workflow.id, record.until]).toEqual(["mt-feature", "plan"]);
    expect((await w.fs.read(`${w.repo.runDir(plan.runId)}/task.md`))._unsafeUnwrap()).toContain(
      `## Analysis\n\n${ANALYSIS}`,
    );
    await w.fs.write(`${w.repo.runDir(plan.runId)}/plan.json`, PLAN);
    for (const event of [{ type: "PASS" }, { type: "PASS" }, { type: "APPROVE", by: "ana" }] as const)
      await w.advance.execute({ runId: plan.runId, event });
    const item = (await w.work.detail("i001"))._unsafeUnwrap();
    expect(item).toMatchObject({
      status: "open",
      plan: { runId: plan.runId, kind: "plan", file: ".metator/issues/i001/plan.json" },
      freshness: { plan: { state: "fresh" } },
      planRun: { runId: plan.runId, status: "planned", stage: "planned" },
      planSummary: "Round prices\n\n- S1 modify src/price.ts: round half up\n",
    });
    expect(item.plan?.cites.map((c) => c.path)).toEqual(["src/price.ts", "test/price.test.ts"]);
  });

  test("told that its run stopped planned, the item takes the plan as the code is then", async () => {
    const w = world();
    (await w.work.analyze({ title: "Round prices", text: ANALYSIS, by: "ana" }))._unsafeUnwrap();
    const runId = await planned(w, "i001");
    (await w.work.planned(runId))._unsafeUnwrap();
    // Edited after the plan was taken: the plan is stale, not taken again from the edited file.
    await w.fs.write("src/price.ts", "export const round = 3;\n");
    w.changed.push("src/price.ts");
    expect((await w.work.detail("i001"))._unsafeUnwrap().freshness.plan).toEqual({
      state: "stale",
      changed: ["src/price.ts"],
    });
    (await w.work.planned("20261122-unknown"))._unsafeUnwrap();
  });

  test("a bug is planned with mt-bugfix", async () => {
    const w = world();
    await w.fs.write(
      ".github/metator/workflows/mt-bugfix.yml",
      FEATURE.replace("id: mt-feature", "id: mt-bugfix"),
    );
    (await w.issues.add({ title: "Crash", labels: ["bug"], by: "ana" }))._unsafeUnwrap();
    const plan = (await w.work.plan("i001"))._unsafeUnwrap();
    expect((await w.repo.load(plan.runId))._unsafeUnwrap().workflow.id).toBe("mt-bugfix");
  });

  test("Implement: a fresh plan starts at build; a stale one at its review; none, the whole workflow", async () => {
    const w = world();
    for (const t of ["A", "B", "C"]) (await w.issues.add({ title: t, by: "ana" }))._unsafeUnwrap();
    const a = await planned(w, "i001");
    const b = await planned(w, "i002");
    const fresh = (await w.work.implement("i001", { by: "ana", worktree: false }))._unsafeUnwrap();
    expect(fresh.mode).toBe("plan-from");
    const run = (await w.repo.load(fresh.runId))._unsafeUnwrap();
    expect([run.state.stage, run.planFrom]).toEqual(["build", { run: a, from: "build" }]);
    await w.fs.write("src/price.ts", "changed\n");
    w.changed.push("src/price.ts");
    const stale = (await w.work.implement("i002", { by: "ana", worktree: false }))._unsafeUnwrap();
    expect(stale.mode).toBe("plan-review");
    expect((await w.repo.load(stale.runId))._unsafeUnwrap().state.stage).toBe("plan-gate");
    expect((await w.repo.load(stale.runId))._unsafeUnwrap().planFrom).toEqual({ run: b, from: "review" });
    const none = (await w.work.implement("i003", { by: "ana", worktree: false }))._unsafeUnwrap();
    expect([none.mode, (await w.repo.load(none.runId))._unsafeUnwrap().state.stage]).toEqual(["new", "plan"]);
  });

  test("the run continues in the item's open thread; a closed one gives a new thread that carries it", async () => {
    const w = world();
    w.threads.set("20261120-open", w.thread("20261120-open", "open"));
    w.threads.set("20261120-old", w.thread("20261120-old", "closed", "Decided: half up."));
    (
      await w.work.analyze({ title: "A", text: ANALYSIS, by: "ana", threadId: "20261120-open" })
    )._unsafeUnwrap();
    (
      await w.work.analyze({ title: "B", text: ANALYSIS, by: "ana", threadId: "20261120-old" })
    )._unsafeUnwrap();
    const inOpen = (await w.work.implement("i001", { by: "ana", worktree: false }))._unsafeUnwrap();
    expect(inOpen.thread).toEqual({ id: "20261120-open" });
    expect(w.threads.get("20261120-open")?.runs).toEqual([inOpen.runId]);
    const fromClosed = (
      await w.work.implement("i002", { by: "ana", worktree: false, chat: true })
    )._unsafeUnwrap();
    expect(fromClosed.thread).toEqual({ id: "20261122-new-1" });
    expect(w.made).toEqual([
      {
        title: "B",
        from: { issue: "i002", thread: "20261120-old" },
        carry: 'Backlog item i002 "B" started. Decided: half up. Analysis: .metator/issues/i002/analysis.md.',
        pane: true,
      },
    ]);
    expect(fromClosed.issue.threadId).toBe("20261122-new-1");
    expect(w.threads.get("20261122-new-1")?.runs).toEqual([fromClosed.runId]);
  });

  test("Make plan of an item analysed in a chat: the plan run is in that chat's thread, and Implement after it too", async () => {
    const w = world();
    w.threads.set("20261123-new-chat-2", w.thread("20261123-new-chat-2", "open"));
    w.threads.set("20261120-old", w.thread("20261120-old", "closed"));
    (
      await w.work.analyze({ title: "Mugs", text: ANALYSIS, by: "ana", threadId: "20261123-new-chat-2" })
    )._unsafeUnwrap();
    (
      await w.work.analyze({ title: "Cups", text: ANALYSIS, by: "ana", threadId: "20261120-old" })
    )._unsafeUnwrap();
    (await w.work.analyze({ title: "Plates", text: ANALYSIS, by: "ana" }))._unsafeUnwrap();
    const planRun = await planned(w, "i001");
    expect(w.threads.get("20261123-new-chat-2")?.runs).toEqual([planRun]);
    const built = (await w.work.implement("i001", { by: "ana", worktree: false }))._unsafeUnwrap();
    expect(built.thread).toEqual({ id: "20261123-new-chat-2" });
    expect(w.threads.get("20261123-new-chat-2")?.runs).toEqual([planRun, built.runId]);
    // A closed thread takes no plan run, and an item without a thread makes none: no thread is made.
    (await w.work.plan("i002"))._unsafeUnwrap();
    (await w.work.plan("i003"))._unsafeUnwrap();
    expect([w.threads.get("20261120-old")?.runs, w.made]).toEqual([[], []]);
  });
});

describe("BacklogWork: items from a plan", () => {
  const system: SystemPlan = {
    id: "rename-refunds",
    task: "Rename refunds",
    status: "approved",
    strategies: [],
    steps: [
      {
        id: "billing-change",
        app: "billing",
        summary: "Rename in billing",
        contracts: [],
        dependsOn: [],
        status: "pending",
      },
      {
        id: "web-change",
        app: "web",
        summary: "Rename in web",
        contracts: [],
        dependsOn: ["billing-change"],
        status: "pending",
      },
    ],
  };

  test("a plan run: one parent with the plan's summary, snapshot and thread; asked again, refused", async () => {
    const w = world();
    const run = (
      await new InitRun(
        new (require("../src/application/workflow-catalog.ts").WorkflowCatalog)(w.fs, DEFAULT_PATHS),
        w.repo,
        w.clock,
      ).execute({ workflow: "mt-feature", task: "Round prices" })
    )._unsafeUnwrap();
    await w.fs.write(`${w.repo.runDir(run.runId)}/plan.json`, PLAN);
    w.threads.set("20261122-chat", { ...w.thread("20261122-chat", "open"), runs: [run.runId] });
    const made = (await w.work.fromPlan({ runId: run.runId, by: "ana" }))._unsafeUnwrap();
    expect(made.parent).toMatchObject({
      id: "i001",
      title: "Round prices",
      body: "Round prices\n\n- S1 modify src/price.ts: round half up\n",
      status: "open",
      threadId: "20261122-chat",
      refs: [{ run: run.runId }],
      plan: { runId: run.runId, kind: "plan", file: ".metator/issues/i001/plan.json" },
      children: [],
    });
    expect(made.children).toEqual([]);
    expect(w.threads.get("20261122-chat")?.issues).toEqual(["i001"]);
    expect((await w.work.fromPlan({ runId: run.runId, by: "ana" }))._unsafeUnwrapErr().message).toBe(
      `the plan of run ${run.runId} is already in the Backlog as i001`,
    );
  });

  test("a system run: a parent and a child per step; a child waits; it starts its step; the parent ends by itself", async () => {
    const w = world();
    (await w.systemPlans.save(system))._unsafeUnwrap();
    const run = (
      await new InitRun(
        new (require("../src/application/workflow-catalog.ts").WorkflowCatalog)(w.fs, DEFAULT_PATHS),
        w.repo,
        w.clock,
      ).execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    const made = (await w.work.fromPlan({ runId: run.runId, by: "ana" }))._unsafeUnwrap();
    expect(made.parent).toMatchObject({
      id: "i001",
      plan: { kind: "system-plan", file: ".metator/issues/i001/system-plan.yml" },
      children: ["i002", "i003"],
      progress: { done: 0, of: 2 },
    });
    expect(made.children.map((c) => [c.id, c.parent, c.dependsOn, c.waitsFor, c.step?.stepId])).toEqual([
      ["i002", "i001", [], [], "billing-change"],
      ["i003", "i001", ["i002"], ["i002"], "web-change"],
    ]);
    expect((await w.work.detail("i001"))._unsafeUnwrap().planSummary).toBe(
      "Rename refunds\n\n- billing-change (billing): Rename in billing\n- web-change (web): Rename in web (after billing-change)\n",
    );
    expect((await w.work.implement("i001", { by: "ana" }))._unsafeUnwrapErr().message).toBe(
      "issue i001 is the parent of i002, i003: start its children",
    );
    expect((await w.work.implement("i003", { by: "ana" }))._unsafeUnwrapErr().message).toBe(
      "issue i003 waits for i002 (open): start it when they are done",
    );
    const started = (await w.work.implement("i002", { by: "ana" }))._unsafeUnwrap();
    expect(w.stepsAsked).toEqual([{ id: "rename-refunds", step: "billing-change", parent: run.runId }]);
    expect([started.issue.status, started.session]).toEqual([
      "in-progress",
      { paneId: "w3:p1", host: "claude" },
    ]);
    // The step's run is done: its item is done; the other child is closed by a person; the parent ends.
    const p = (await w.systemPlans.load("rename-refunds"))._unsafeUnwrap();
    (
      await w.systemPlans.save({
        ...p,
        steps: p.steps.map((s, i) => (i === 0 ? { ...s, status: "done" as const } : s)),
      })
    )._unsafeUnwrap();
    expect((await w.work.detail("i002"))._unsafeUnwrap().status).toBe("done");
    (await w.issues.close("i003", { by: "ana" }))._unsafeUnwrap();
    expect((await w.work.detail("i001"))._unsafeUnwrap()).toMatchObject({
      status: "done",
      progress: { done: 2, of: 2 },
    });
  });

  test("a run without a plan has nothing to make an item from", async () => {
    const w = world();
    const run = (
      await new InitRun(
        new (require("../src/application/workflow-catalog.ts").WorkflowCatalog)(w.fs, DEFAULT_PATHS),
        w.repo,
        w.clock,
      ).execute({ workflow: "mt-feature", task: "Nothing yet" })
    )._unsafeUnwrap();
    expect((await w.work.fromPlan({ runId: run.runId, by: "ana" }))._unsafeUnwrapErr().message).toBe(
      `run ${run.runId} has no plan yet: no plan.json and no system plan nothing-yet`,
    );
  });
});
