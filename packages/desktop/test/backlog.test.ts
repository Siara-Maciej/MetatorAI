import { describe, expect, test } from "bun:test";
import {
  ANALYSE,
  type BacklogItem,
  backlogRows,
  CREATE_ITEM,
  childRows,
  childrenProgress,
  FILES_UNKNOWN,
  freshnessText,
  freshnessTone,
  fromPlanButton,
  IMPLEMENT,
  itemButtons,
  itemOfPlan,
  itemOfStep,
  itemWord,
  MAKE_PLAN,
  OPEN_ITEM,
  PLAN_STEP,
  planLines,
  pointsAt,
  REANALYSE,
  REVIEW_THEN_IMPLEMENT,
  rowSub,
  type StepLike,
  shownRoute,
  stepDetail,
  stepsOfView,
  waitsText,
  whyDisabled,
} from "../src/features/backlog/model.ts";
import { firstLevel, lookOf } from "../src/shared/model/look.ts";
import { parseRoute, routeHash } from "../src/shared/model/route.ts";
import { finishedText, isFinished, runStateOf } from "../src/shared/model/runs.ts";

const item = (id: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  title: `Item ${id}`,
  status: "open",
  ...over,
});
const snap = { file: ".metator/issues/i001/analysis.md", at: "2026-11-20T10:00:00Z", commit: "abc" };
const planSnap = { ...snap, file: ".metator/issues/i001/plan.json", runId: "r1", kind: "plan" as const };

describe("freshness badge", () => {
  test("fresh, stale with the changed files by name, old with its days", () => {
    expect(freshnessText({ state: "fresh" })).toBe("fresh");
    expect(freshnessText({ state: "stale", changed: ["src/invoice.ts"] })).toBe("stale: invoice.ts");
    expect(freshnessText({ state: "old", days: 15 })).toBe("old: 15 days");
    expect(freshnessText({ state: "old", days: 1 })).toBe("old: 1 day");
  });
  test("a stale badge names three files, then how many more", () => {
    const changed = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    expect(freshnessText({ state: "stale", changed })).toBe("stale: a.ts, b.ts, c.ts +2");
    expect(freshnessText({ state: "stale", changed: changed.slice(0, 3) })).toBe("stale: a.ts, b.ts, c.ts");
    // A package that changed with no cited file named: stale alone.
    expect(freshnessText({ state: "stale", changed: [] })).toBe("stale");
  });
  test("fresh is green, stale red (it blocks), old amber (it only warns)", () => {
    expect(freshnessTone({ state: "fresh" })).toBe("green");
    expect(freshnessTone({ state: "stale", changed: [] })).toBe("red");
    expect(freshnessTone({ state: "old", days: 20 })).toBe("amber");
  });
});

describe("the buttons of an item", () => {
  test("an item with nothing yet: Analyse, Make plan, Implement, all enabled", () => {
    const b = itemButtons(item("i001"));
    expect(b.analyse).toEqual({ label: ANALYSE });
    expect(b.plan).toEqual({ label: MAKE_PLAN, disabled: undefined });
    expect(b.implement).toEqual({ label: IMPLEMENT, disabled: undefined });
  });
  test("with an analysis: Re-analyse; a fresh or old one leaves Make plan enabled", () => {
    for (const f of [{ state: "fresh" as const }, { state: "old" as const, days: 30 }]) {
      const b = itemButtons(item("i001", { analysis: snap, freshness: { analysis: f } }));
      expect(b.analyse?.label).toBe(REANALYSE);
      expect(b.plan?.disabled).toBeUndefined();
    }
  });
  test("a stale analysis disables Make plan with the files that changed", () => {
    const b = itemButtons(
      item("i001", {
        analysis: snap,
        freshness: { analysis: { state: "stale", changed: ["src/invoice.ts", "src/tax.ts"] } },
      }),
    );
    expect(b.plan?.disabled).toBe("the analysis is stale: src/invoice.ts, src/tax.ts; re-analyse first");
    expect(b.analyse?.label).toBe(REANALYSE);
    // Implement does not depend on the analysis.
    expect(b.implement?.disabled).toBeUndefined();
  });
  test("a stale plan: Implement reviews the plan first; a fresh one implements", () => {
    const stale = itemButtons(
      item("i001", { plan: planSnap, freshness: { plan: { state: "stale", changed: ["a.ts"] } } }),
    );
    expect(stale.implement).toEqual({ label: REVIEW_THEN_IMPLEMENT, disabled: undefined });
    const fresh = itemButtons(item("i001", { plan: planSnap, freshness: { plan: { state: "fresh" } } }));
    expect(fresh.implement?.label).toBe(IMPLEMENT);
    // An old plan only warns: it implements.
    const old = itemButtons(
      item("i001", { plan: planSnap, freshness: { plan: { state: "old", days: 40 } } }),
    );
    expect(old.implement?.label).toBe(IMPLEMENT);
  });
  test("an item that waits for others cannot be implemented yet, and says for what", () => {
    const all = [item("i002", { title: "Price model" }), item("i003", { title: "API endpoint" })];
    const b = itemButtons(item("i004", { waitsFor: ["i002", "i003"] }), all);
    expect(b.implement?.disabled).toBe("waits for Price model, API endpoint");
    expect(b.plan?.disabled).toBeUndefined();
  });
  test("a parent with children starts them one by one: no plan and no start of its own", () => {
    const parent = item("i001", { children: ["i002"] });
    const b = itemButtons(parent, [parent, item("i002", { parent: "i001" })]);
    expect(b.implement?.disabled).toBe("its parts start one by one: implement them");
    expect(b.plan?.disabled).toBe("its parts start one by one: implement them");
    expect(b.analyse?.disabled).toBeUndefined();
  });
  test("only an open item has them", () => {
    for (const status of ["proposed", "in-progress", "done", "dropped"] as const)
      expect(itemButtons(item("i001", { status }))).toEqual({});
  });
});

describe("parents and children", () => {
  const parent = item("i001", { title: "Currency in prices", children: ["i002", "i003", "i004"] });
  const all = [
    parent,
    item("i002", { title: "Price model", parent: "i001", status: "done" }),
    item("i003", { title: "API endpoint", parent: "i001", status: "in-progress" }),
    item("i004", { title: "Price tag", parent: "i001", waitsFor: ["i002", "i003"] }),
  ];
  test('the parent says "N of M done"; a dropped child counts as done', () => {
    expect(childrenProgress(parent, all)).toBe("1 of 3 done");
    const dropped = all.map((i) => (i.id === "i003" ? { ...i, status: "dropped" as const } : i));
    expect(childrenProgress(parent, dropped)).toBe("2 of 3 done");
    expect(childrenProgress(item("i009"), all)).toBeUndefined();
  });
  test("the daemon's count wins when it sends one", () => {
    expect(childrenProgress({ ...parent, progress: { done: 3, of: 3 } }, all)).toBe("3 of 3 done");
    expect(childrenProgress({ ...parent, progress: { done: 0, of: 0 } }, all)).toBe("1 of 3 done");
  });
  test("without the daemon's list, the children are the items that name the parent", () => {
    const bare = { ...parent, children: undefined };
    expect(childrenProgress(bare, all)).toBe("1 of 3 done");
  });
  test("each child: one word and what it waits for, by title", () => {
    expect(childRows(parent, all)).toEqual([
      { id: "i002", title: "Price model", word: "done" },
      { id: "i003", title: "API endpoint", word: "working" },
      { id: "i004", title: "Price tag", word: "waits", waits: "waits for Price model, API endpoint" },
    ]);
  });
  test("waits for an item not in the list names its id", () => {
    expect(waitsText({ waitsFor: ["i099"] }, all)).toBe("waits for i099");
    expect(waitsText({ waitsFor: [] }, all)).toBeUndefined();
  });
  test("a row's second line: the parent's progress, a child's wait, nothing else", () => {
    expect(rowSub(parent, all)).toBe("1 of 3 done");
    expect(rowSub(all[3] as BacklogItem, all)).toBe("waits for Price model, API endpoint");
    expect(rowSub(all[1] as BacklogItem, all)).toBeUndefined();
  });
  test("the list puts each child right under its parent, in the parent's part", () => {
    const loose = item("i005", { title: "Loose" });
    const rows = backlogRows([...all, loose, item("i006", { status: "proposed" })]);
    expect(rows.open.map((r) => [r.item.id, r.child])).toEqual([
      ["i001", false],
      ["i002", true],
      ["i003", true],
      ["i004", true],
      ["i005", false],
    ]);
    expect(rows.proposals.map((r) => r.item.id)).toEqual(["i006"]);
    // The done child is under its open parent, not among the finished.
    expect(rows.finished).toEqual([]);
    // A finished parent takes its children along; a child whose parent is gone stands alone.
    const done = backlogRows([
      { ...parent, status: "done" },
      ...all.slice(1).map((i) => ({ ...i, status: "done" as const })),
      item("i007", { parent: "i099" }),
    ]);
    expect(done.finished.map((r) => r.item.id)).toEqual(["i001", "i002", "i003", "i004"]);
    expect(done.open.map((r) => [r.item.id, r.child])).toEqual([["i007", false]]);
  });
});

describe("the word of an item", () => {
  test("by its status, then what it waits for, its plan, its analysis", () => {
    expect(itemWord(item("i1", { status: "proposed" }))).toBe("proposed");
    expect(itemWord(item("i1", { status: "in-progress" }))).toBe("working");
    expect(itemWord(item("i1", { status: "done" }))).toBe("done");
    expect(itemWord(item("i1", { status: "dropped" }))).toBe("dropped");
    expect(itemWord(item("i1"))).toBe("open");
    expect(itemWord(item("i1", { analysis: snap, freshness: { analysis: { state: "fresh" } } }))).toBe(
      "analysed",
    );
    expect(
      itemWord(item("i1", { analysis: snap, freshness: { analysis: { state: "stale", changed: [] } } })),
    ).toBe("stale");
    expect(
      itemWord(item("i1", { analysis: snap, plan: planSnap, freshness: { plan: { state: "fresh" } } })),
    ).toBe("plan ready");
    expect(
      itemWord(item("i1", { plan: planSnap, freshness: { plan: { state: "stale", changed: ["a.ts"] } } })),
    ).toBe("plan stale");
    expect(itemWord(item("i1", { plan: planSnap, waitsFor: ["i0"] }))).toBe("waits");
  });
});

describe("a plan view's Backlog item", () => {
  const parent = item("i001", { plan: planSnap });
  const child = item("i002", { parent: "i001", plan: { ...planSnap, runId: "r1" } });
  test("Create Backlog item until one is made, then Open its Backlog item (the parent)", () => {
    expect(fromPlanButton([], "r1")).toEqual({ label: CREATE_ITEM });
    expect(fromPlanButton([child, parent], "r1")).toEqual({ label: OPEN_ITEM, itemId: "i001" });
    expect(itemOfPlan([child], "r1")).toBeUndefined();
    expect(fromPlanButton([parent], "r2")).toEqual({ label: CREATE_ITEM });
  });
  test("the route opens the Backlog on that item", () => {
    expect(routeHash({ screen: "backlog", id: "i001" })).toBe("#/backlog/i001");
    expect(parseRoute("#/backlog/i001")).toEqual({ screen: "backlog", id: "i001" });
    expect(parseRoute("#/backlog")).toEqual({ screen: "backlog" });
    expect(routeHash({ screen: "backlog" })).toBe("#/backlog");
  });
});

describe("a system plan step's Backlog part", () => {
  test("the item whose step names the plan and the step", () => {
    const parts = [
      item("i002", { step: { runId: "s1", plan: "cents", stepId: "api-model" } }),
      item("i003", { step: { runId: "s1", plan: "cents", stepId: "api-docs" } }),
      item("i004", { step: { runId: "s2", plan: "other", stepId: "api-model" } }),
    ];
    expect(itemOfStep(parts, "cents", "api-model")?.id).toBe("i002");
    expect(itemOfStep(parts, "other", "api-model")?.id).toBe("i004");
    expect(itemOfStep(parts, "cents", "nope")).toBeUndefined();
  });
});

describe("a system plan step's detail", () => {
  const steps: StepLike[] = [
    {
      id: "api-model",
      app: "shop-api",
      task: "A price carries its currency",
      dependsOn: [],
      status: "pending",
      files: ["src/price.ts", "openapi.yaml"],
      contracts: [{ id: "prices-api", role: "expand" }],
    },
    {
      id: "web-tag",
      app: "shop-web",
      task: "The price tag shows the currency",
      dependsOn: ["api-model"],
      status: "pending",
    },
  ];
  test("what the step already has: summary, app, contracts, what it waits for, its files", () => {
    expect(stepDetail({ steps }, "api-model")).toEqual({
      id: "api-model",
      summary: "A price carries its currency",
      app: "shop-api",
      contracts: ["expand prices-api"],
      after: [],
      files: ["src/price.ts", "openapi.yaml"],
      word: "pending",
      planLines: [],
      button: { label: PLAN_STEP },
    });
  });
  test("no files from the analysis: they are not known until planned; dependsOn by summary", () => {
    const d = stepDetail({ steps }, "web-tag");
    expect(d?.files).toBe(FILES_UNKNOWN);
    expect(d?.after).toEqual(["A price carries its currency"]);
    expect(d?.contracts).toEqual([]);
    expect(stepDetail({ steps: [{ ...(steps[1] as StepLike), files: [] }] }, "web-tag")?.files).toBe(
      FILES_UNKNOWN,
    );
  });
  test("planning, then planned with its plan in lines: no button; started: its run, no button", () => {
    const at = (over: Partial<StepLike>) =>
      stepDetail({ steps: [{ ...(steps[0] as StepLike), ...over }] }, "api-model");
    const planning = at({ planRunId: "p1", planRun: { runId: "p1", status: "active", stage: "plan" } });
    expect([planning?.word, planning?.planRunId, planning?.button, planning?.planLines]).toEqual([
      "planning",
      "p1",
      undefined,
      [],
    ]);
    const planned = at({
      planRunId: "p1",
      planRun: {
        runId: "p1",
        status: "planned",
        steps: [
          { id: "S1", action: "create", path: "test/price.test.ts", intent: "a failing test" },
          { id: "S2", action: "modify", path: "src/price.ts", intent: "the currency" },
        ],
      },
    });
    expect(planned?.word).toBe("planned");
    expect(planned?.button).toBeUndefined();
    expect(planned?.planLines).toEqual([
      "1 a failing test · test/price.test.ts",
      "2 the currency · src/price.ts",
    ]);
    // A plan run known only by its id (the view has not read it yet) is planning.
    expect(at({ planRunId: "p1" })?.word).toBe("planning");
    const running = at({ status: "running", run: "c1" });
    expect([running?.word, running?.run, running?.button]).toEqual(["running", "c1", undefined]);
    const done = at({ status: "done" });
    expect([done?.word, done?.button]).toEqual(["done", undefined]);
    expect(stepDetail({ steps }, "nope")).toBeUndefined();
  });
  test("a plan run that ended without a plan gives the button back", () => {
    for (const status of ["aborted", "escalated"]) {
      const d = stepDetail(
        { steps: [{ ...(steps[0] as StepLike), planRunId: "p1", planRun: { runId: "p1", status } }] },
        "api-model",
      );
      expect([d?.word, d?.button]).toEqual(["pending", { label: PLAN_STEP }]);
    }
  });
  test("the view's step with what the plan document says of it", () => {
    const merged = stepsOfView({
      plan: {
        steps: [
          { id: "api-model", contracts: [{ id: "prices-api", role: "expand" }], planRunId: "p9" },
          { id: "web-tag" },
        ],
      },
      steps: [
        { id: "api-model", app: "shop-api", task: "A", dependsOn: [], status: "pending" },
        { id: "web-tag", app: "shop-web", task: "B", dependsOn: [], status: "pending", planRunId: "p2" },
      ],
    });
    expect(merged.map((s) => [s.id, s.planRunId, s.contracts])).toEqual([
      ["api-model", "p9", [{ id: "prices-api", role: "expand" }]],
      ["web-tag", "p2", undefined],
    ]);
  });
  test("a plan in lines", () => {
    expect(planLines({ steps: [{ intent: "a failing test", path: "test/price.test.ts" }] })).toEqual([
      "1 a failing test · test/price.test.ts",
    ]);
    expect(planLines(undefined)).toEqual([]);
    expect(planLines({})).toEqual([]);
  });
});

describe("a button that starts an agent shows its terminal", () => {
  test("a run's pane on its Terminal tab; a pane with no run on the workbench", () => {
    expect(shownRoute({ runId: "r1", paneId: "w1:p2" })).toEqual({
      screen: "run",
      runId: "r1",
      tab: "terminal",
      pane: "w1:p2",
    });
    expect(shownRoute({ runId: "r1" })).toEqual({ screen: "run", runId: "r1", tab: "terminal" });
    expect(shownRoute({ paneId: "w3:p1" })).toEqual({ screen: "grid", pane: "w3:p1" });
    expect(shownRoute({})).toBeUndefined();
  });
});

describe("a planned run (`--until plan`)", () => {
  test('is finished, reads "plan ready", and is done on the first level', () => {
    const run = { status: "planned", attention: "done" } as const;
    expect(isFinished(run)).toBe(true);
    expect(runStateOf(run)).toBe("plan ready");
    expect(firstLevel("plan ready")).toBe("done");
    expect(lookOf("run", "plan ready").tone).toBe("teal");
    expect(finishedText({ status: "planned", stage: "plan-approval", elapsedMs: 60_000 })).toContain(
      "Plan ready",
    );
  });
});

describe("whyDisabled", () => {
  test("buttons that share a reason say it once, without their names", () => {
    const why = "its parts start one by one: implement them";
    expect(
      whyDisabled([
        { label: "Make plan", disabled: why },
        { label: "Implement", disabled: why },
      ]),
    ).toEqual(["Its parts start one by one: implement them"]);
  });
  test("different reasons keep each button's name; enabled buttons say nothing", () => {
    expect(
      whyDisabled([
        { label: "Make plan", disabled: "the analysis is stale; re-analyse first" },
        { label: "Implement", disabled: "waits for Price model" },
        { label: "Analyse" },
        undefined,
      ]),
    ).toEqual(["Make plan: the analysis is stale; re-analyse first", "Implement: waits for Price model"]);
  });
  test("one disabled button keeps its name", () => {
    expect(whyDisabled([{ label: "Implement", disabled: "waits for A" }, { label: "Make plan" }])).toEqual([
      "Implement: waits for A",
    ]);
  });
});

describe("pointsAt", () => {
  test("files stay text; runs are listed once, without the item's own run or its plan's run", () => {
    const got = pointsAt({
      runId: "r-own",
      plan: {
        file: "plan.json",
        at: "2026-11-22T00:00:00.000Z",
        runId: "r-plan",
        kind: "plan",
      },
      refs: [
        { file: "src/a.ts", line: 3 },
        { run: "r-plan" },
        { run: "r-own" },
        { run: "r-from", step: "S1" },
        { run: "r-from" },
        { note: "see review" },
      ],
    });
    expect(got.files).toEqual([{ file: "src/a.ts", line: 3 }, { note: "see review" }]);
    expect(got.runs).toEqual(["r-from"]);
  });
});
