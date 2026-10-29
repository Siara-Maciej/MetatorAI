import { describe, expect, test } from "bun:test";
import { FakeAgentHost, InMemoryFileSystem } from "@metator/testing";
import {
  ApproveRefactorPlan,
  CreateRefactorPlan,
  LintRefactorPlan,
  ProposeRefactorPlan,
  RefactorPlanStore,
  RunRefactorPlan,
  SimulateRefactorPlan,
  SyncRefactorPlan,
} from "../src/application/architecture-plans.ts";
import { type ArchitectureInput, manifestOf, type ResolvedImport } from "../src/domain/architecture.ts";
import {
  describeMove,
  goalMet,
  lintRefactorPlan,
  nextWave,
  orderedMoves,
  planDigest,
  planId,
  plannerPrompt,
  type RefactorPlan,
  RefactorPlanSchema,
  simulatePlan,
} from "../src/domain/architecture-plan.ts";
import { EMPTY_POLICY } from "../src/domain/architecture-policy.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const imp = (from: string, to: string): ResolvedImport => ({ from, to, specifier: "@x/p", typeOnly: false });

/** cart ⇄ pricing through pricing/src/rules.ts. */
function input(): ArchitectureInput {
  return {
    files: [
      "packages/cart/src/index.ts",
      "packages/cart/src/total.ts",
      "packages/pricing/src/index.ts",
      "packages/pricing/src/rules.ts",
    ],
    imports: [
      imp("packages/cart/src/index.ts", "packages/pricing/src/index.ts"),
      imp("packages/pricing/src/rules.ts", "packages/cart/src/total.ts"),
    ],
    externals: [],
    unresolved: [],
    manifests: {
      packages: [
        manifestOf("packages/cart", {
          name: "@x/cart",
          private: true,
          main: "x",
          dependencies: { "@x/pricing": "*" },
        }),
        manifestOf("packages/pricing", {
          name: "@x/pricing",
          private: true,
          main: "x",
          dependencies: { "@x/cart": "*" },
        }),
      ],
    },
    policy: EMPTY_POLICY,
    policySource: null,
    today: "2026-10-29",
  };
}

/** A plan from raw fields (moves without a status are pending, as in a file). */
const plan = (over: Record<string, unknown> = {}): RefactorPlan =>
  RefactorPlanSchema.parse({
    id: "break-cycle",
    title: "Break the pricing cycle",
    goal: "no-cycles",
    moves: [
      {
        id: "m1",
        move: { type: "move", files: ["packages/pricing/src/rules.ts"], to: "@x/cart" },
        why: "Cart rules belong to cart.",
        citations: ["packages/pricing/src/rules.ts:1"],
        wave: 1,
      },
    ],
    ...over,
  });
const exists = () => true;

describe("plan basics", () => {
  test("ids from titles; a digest that changes with the moves only", () => {
    expect(planId("Złamać cykl: Pricing → Cart!")).toBe("zlamac-cykl-pricing-cart");
    expect(planId("???")).toBe("plan");
    expect(planId("a".repeat(60))).toHaveLength(48);
    const p = plan();
    expect(planDigest(p)).toMatch(/^[0-9a-f]{8}$/);
    expect(planDigest({ ...p, title: "other", status: "approved" } as RefactorPlan)).toBe(planDigest(p));
    expect(planDigest({ moves: [{ ...(p.moves[0] as RefactorPlan["moves"][number]), wave: 2 }] })).not.toBe(
      planDigest(p),
    );
  });

  test("moves run wave by wave, in file order within a wave; next wave skips done waves", () => {
    const m = (id: string, wave: number, status: "pending" | "done" | "running" = "pending") => ({
      ...(plan().moves[0] as RefactorPlan["moves"][number]),
      id,
      wave,
      status,
    });
    const p = plan({ moves: [m("b", 2), m("a", 1, "done"), m("c", 2, "running"), m("d", 3)] });
    expect(orderedMoves(p).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(nextWave(p)).toEqual({ wave: 2, moves: [m("b", 2)] });
    expect(nextWave(plan({ moves: [m("a", 1, "done")] }))).toBeUndefined();
  });

  test("goals", () => {
    const s = (cycles: number, errors: number, warnings: number) => ({
      packages: 0,
      apps: 0,
      edges: 0,
      cycles,
      errors,
      warnings,
      excepted: 0,
      score: 0,
    });
    expect(goalMet("no-cycles", s(1, 1, 0), s(0, 1, 0))).toBe(true);
    expect(goalMet("no-errors", s(0, 2, 0), s(0, 1, 0))).toBe(false);
    expect(goalMet("fewer-violations", s(0, 2, 2), s(0, 2, 1))).toBe(true);
    expect(goalMet("fewer-violations", s(0, 2, 2), s(0, 2, 2))).toBe(false);
  });

  test("descriptions and the planner prompt", () => {
    expect(describeMove({ type: "invert", from: "@x/a", to: "@x/b" })).toBe(
      "Invert the dependency @x/a → @x/b: a port in @x/a, its implementation in @x/b",
    );
    expect(describeMove({ type: "declare", package: "@x/a", dependency: "zod" })).toBe("Declare zod in @x/a");
    const prompt = plannerPrompt({
      plan: "metator/arch/plans/p.yml",
      goal: "no-cycles",
      report: ".metator/arch/report.md",
    });
    expect(prompt).toContain("goal no-cycles");
    expect(prompt).toContain("metator/arch/plans/p.yml");
    expect(prompt).toContain("Do not approve the plan");
  });
});

describe("simulatePlan and lint", () => {
  test("simulate writes each move's effect and the result", () => {
    const s = simulatePlan(input(), plan());
    expect(s.moves[0]?.effect).toMatchObject({ fixed: ["cycle:@x/cart,@x/pricing"], rewrites: 1 });
    expect(s.result).toEqual({
      before: expect.objectContaining({ cycles: 1 }),
      after: expect.objectContaining({ cycles: 0 }),
    });
  });

  test("a simulated plan that reaches its goal is clean", () => {
    expect(lintRefactorPlan(simulatePlan(input(), plan()), input(), exists)).toEqual([]);
  });

  test("effects must be current; the result too", () => {
    const problems = lintRefactorPlan(plan(), input(), exists);
    expect(problems.map((p) => [p.move, p.message])).toEqual([
      ["m1", "the effect is missing or out of date: run `metator arch plan simulate`"],
    ]);
    const s = simulatePlan(input(), plan());
    const stale = lintRefactorPlan({ ...s, result: undefined }, input(), exists);
    expect(stale.map((p) => p.message)).toEqual([
      "the result is missing or out of date: run `metator arch plan simulate`",
    ]);
  });

  test("structure: no moves, duplicate ids, gaps in waves, missing citations, impossible moves", () => {
    expect(lintRefactorPlan(plan({ moves: [] }), input(), exists).map((p) => p.message)).toContain(
      "the plan has no moves",
    );
    const m1 = plan().moves[0] as RefactorPlan["moves"][number];
    const bad = plan({
      moves: [
        m1,
        { ...m1, wave: 3 },
        {
          ...m1,
          id: "m2",
          move: { type: "merge", from: "@x/ghost", into: "@x/cart" },
          wave: 3,
          citations: ["nope.ts:4"],
        },
      ],
    });
    expect(lintRefactorPlan(bad, input(), (p) => p !== "nope.ts").map((p) => p.message)).toEqual([
      "two moves are named m1",
      "waves must be 1, 2, 3 … without gaps; wave 3 follows 1",
      "nope.ts:4 does not exist",
      "merge @x/ghost into @x/cart: there is no package @x/ghost",
    ]);
  });

  test("a later move may use a package an earlier one creates", () => {
    const p = plan({
      moves: [
        {
          id: "extract",
          move: {
            type: "extract",
            files: ["packages/pricing/src/rules.ts"],
            package: { name: "@x/rules", dir: "packages/rules" },
          },
          why: "Rules are their own concern.",
          citations: ["packages/pricing/src/rules.ts"],
          wave: 1,
        },
        {
          id: "move-total",
          move: { type: "move", files: ["packages/cart/src/total.ts"], to: "@x/rules" },
          why: "Totals follow the rules.",
          citations: ["packages/cart/src/total.ts"],
          wave: 2,
        },
      ],
    });
    const problems = lintRefactorPlan(simulatePlan(input(), p), input(), exists);
    expect(problems.filter((x) => x.severity === "error")).toEqual([]);
  });

  test("a goal not reached and an error the plan adds are errors; a useless move is a warning", () => {
    const useless = plan({
      goal: "no-errors",
      moves: [
        {
          id: "noop",
          move: { type: "declare", package: "@x/cart", dependency: "@x/pricing" },
          why: "Nothing.",
          citations: ["packages/cart/src/index.ts"],
          wave: 1,
        },
      ],
    });
    const problems = lintRefactorPlan(simulatePlan(input(), useless), input(), exists);
    expect(problems.map((p) => [p.severity, p.move, p.message])).toEqual([
      ["warning", "noop", "the move fixes nothing on its own"],
      [
        "error",
        undefined,
        "the plan does not reach its goal no-errors: 1 cycle(s), 1 error(s), 0 warning(s) after it",
      ],
    ]);
    const worse = plan({
      goal: "fewer-violations",
      moves: [
        {
          id: "w",
          move: { type: "move", files: ["packages/cart/src/index.ts"], to: "@x/pricing" },
          why: "x",
          citations: ["packages/cart/src/index.ts"],
          wave: 1,
        },
      ],
    });
    const added = lintRefactorPlan(simulatePlan(input(), worse), input(), exists).map((p) => p.message);
    expect(added.some((m) => m.startsWith("the plan adds") || m.startsWith("the plan does not reach"))).toBe(
      true,
    );
  });

  test("a plan that reaches its goal but adds an error is refused", () => {
    const p = plan({
      moves: [
        plan().moves[0] as RefactorPlan["moves"][number],
        {
          id: "cart-entry-to-app",
          move: {
            type: "extract",
            files: ["packages/cart/src/total.ts"],
            package: { name: "@x/web", dir: "apps/web" },
          },
          why: "x",
          citations: ["packages/cart/src/total.ts"],
          wave: 2,
        },
      ],
    });
    const problems = lintRefactorPlan(simulatePlan(input(), p), input(), exists);
    expect(problems.filter((x) => x.severity === "error").map((x) => x.message)).toEqual([
      "the plan adds app-import:@x/cart→@x/web: @x/cart depends on the application @x/web; applications sit on top and nothing imports them",
    ]);
  });

  test("an approval covers exactly the moves it was given", () => {
    const s = simulatePlan(input(), plan());
    const approved = {
      ...s,
      status: "approved" as const,
      approval: { by: "maciej", at: "x", digest: planDigest(s) },
    };
    expect(lintRefactorPlan(approved, input(), exists)).toEqual([]);
    const edited = { ...approved, moves: approved.moves.map((m) => ({ ...m, wave: 1, why: "changed" })) };
    expect(lintRefactorPlan(edited, input(), exists)).toEqual([]); // the reason is not part of the digest
    const moved = { ...approved, approval: { ...approved.approval, digest: "00000000" } };
    expect(lintRefactorPlan(moved, input(), exists).map((p) => p.message)).toEqual([
      "the moves changed after maciej approved them; approve the plan again",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

function world(files: Record<string, string> = {}) {
  const fs = new InMemoryFileSystem({ "packages/pricing/src/rules.ts": "x", ...files });
  const store = new RefactorPlanStore(fs, "metator/arch/plans");
  const facts = { gather: async () => ok(input()) };
  const clock = { now: () => new Date("2026-10-29T12:00:00Z") };
  const lint = new LintRefactorPlan(facts, store, fs);
  return { fs, store, facts, clock, lint };
}

describe("plan use cases", () => {
  test("new, simulate, lint, approve; never twice the same id", async () => {
    const { store, facts, clock, lint } = world();
    const created = (
      await new CreateRefactorPlan(store).execute({ title: "Break cycle", goal: "no-cycles", by: "maciej" })
    )._unsafeUnwrap();
    expect(created).toEqual({
      id: "break-cycle",
      title: "Break cycle",
      goal: "no-cycles",
      status: "draft",
      createdBy: "maciej",
      moves: [],
    });
    const again = (
      await new CreateRefactorPlan(store).execute({ title: "Break cycle", goal: "no-cycles" })
    )._unsafeUnwrapErr();
    expect(again.code).toBe("USAGE");

    // An approval of a plan with lint errors is refused.
    const refused = (
      await new ApproveRefactorPlan(lint, store, clock).execute({ id: "break-cycle", by: "maciej" })
    )._unsafeUnwrapErr();
    expect([refused.code, refused.message]).toEqual([
      "CHECK_FAILED",
      "break-cycle: 1 lint error(s); fix them before approving",
    ]);

    await store.save({ ...created, moves: plan().moves });
    expect((await lint.execute("break-cycle"))._unsafeUnwrap().problems.map((p) => p.move)).toEqual(["m1"]);
    const simulated = (await new SimulateRefactorPlan(facts, store).execute("break-cycle"))._unsafeUnwrap();
    expect(simulated.result?.after.cycles).toBe(0);
    expect((await lint.execute("break-cycle"))._unsafeUnwrap().problems).toEqual([]);

    const approved = (
      await new ApproveRefactorPlan(lint, store, clock).execute({ id: "break-cycle", by: "maciej" })
    )._unsafeUnwrap();
    expect([approved.status, approved.approval]).toEqual([
      "approved",
      { by: "maciej", at: "2026-10-29T12:00:00.000Z", digest: planDigest(simulated) },
    ]);
    expect((await store.load("break-cycle"))._unsafeUnwrap().status).toBe("approved");
    expect((await store.list())._unsafeUnwrap().map((p) => p.id)).toEqual(["break-cycle"]);
  });

  test("the store refuses a file whose id is not its name, and reports unknown plans", async () => {
    const { store, fs } = world();
    await store.save(plan());
    const text = (await fs.read("metator/arch/plans/break-cycle.yml"))._unsafeUnwrap();
    expect(text).toStartWith("# A refactor plan");
    await fs.write("metator/arch/plans/other.yml", text);
    expect((await store.load("other"))._unsafeUnwrapErr().message).toBe(
      "metator/arch/plans/other.yml: its id is break-cycle, not other",
    );
    expect((await store.load("ghost"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await store.list()).isErr()).toBe(true);
  });

  test("run starts the next wave of an approved plan as W3 runs in worktrees; status reads them back", async () => {
    const { store } = world();
    const s = simulatePlan(input(), plan());
    const draft = { ...s, status: "draft" as const };
    await store.save(draft);
    const started: unknown[] = [];
    const init = {
      execute: async (i: { workflow: string; task: string; worktree?: { base?: string } }) => {
        started.push(i);
        return ok({ runId: `20261029-mt-refactor-${started.length}` } as never);
      },
    };
    const run = new RunRefactorPlan(store, init);
    expect((await run.execute({ id: "break-cycle" }))._unsafeUnwrapErr().message).toBe(
      "break-cycle is not approved",
    );
    // A draft with an approval written by hand is still a draft.
    await store.save({ ...draft, approval: { by: "maciej", at: "x", digest: planDigest(s) } });
    expect((await run.execute({ id: "break-cycle" }))._unsafeUnwrapErr().message).toBe(
      "break-cycle is not approved",
    );
    await store.save({ ...s, status: "approved", approval: { by: "maciej", at: "x", digest: "deadbeef" } });
    expect((await run.execute({ id: "break-cycle" }))._unsafeUnwrapErr().message).toBe(
      "the moves of break-cycle changed after maciej approved them",
    );
    await store.save({
      ...s,
      status: "approved",
      approval: { by: "maciej", at: "x", digest: planDigest(s) },
    });
    const r = (await run.execute({ id: "break-cycle", base: "main" }))._unsafeUnwrap();
    expect([r.wave, r.started.map((x) => x.run), r.plan.status, r.plan.moves[0]?.status]).toEqual([
      1,
      ["20261029-mt-refactor-1"],
      "running",
      "running",
    ]);
    expect(started).toEqual([
      {
        workflow: "mt-refactor",
        task: "Move packages/pricing/src/rules.ts to @x/cart. Why: Cart rules belong to cart. (refactor plan break-cycle, move m1; evidence: packages/pricing/src/rules.ts:1)",
        worktree: { base: "main" },
      },
    ]);
    // Nothing pending in the running wave: nothing more starts.
    expect((await run.execute({ id: "break-cycle" }))._unsafeUnwrap().started).toEqual([]);

    const runs = new Map<string, string>([["20261029-mt-refactor-1", "active"]]);
    const repo = { load: async (id: string) => ok({ state: { status: runs.get(id) } } as never) };
    const sync = new SyncRefactorPlan(store, repo);
    expect((await sync.execute("break-cycle"))._unsafeUnwrap().moves[0]?.status).toBe("running");
    runs.set("20261029-mt-refactor-1", "done");
    const done = (await sync.execute("break-cycle"))._unsafeUnwrap();
    expect([done.moves[0]?.status, done.status]).toEqual(["done", "done"]);
    expect((await run.execute({ id: "break-cycle" }))._unsafeUnwrap()).toMatchObject({
      wave: null,
      started: [],
    });
  });

  test("a run that stopped blocks its move with the reason", async () => {
    const { store } = world();
    await store.save({
      ...plan(),
      status: "running",
      moves: plan().moves.map((m) => ({ ...m, status: "running" as const, run: "r1" })),
    });
    const sync = new SyncRefactorPlan(store, {
      load: async () => ok({ state: { status: "aborted" } } as never),
    });
    const p = (await sync.execute("break-cycle"))._unsafeUnwrap();
    expect([p.moves[0]?.status, p.moves[0]?.note, p.status]).toEqual([
      "blocked",
      "run r1 aborted",
      "running",
    ]);
    await store.save({
      ...plan(),
      moves: plan().moves.map((m) => ({ ...m, status: "running" as const, run: "r2" })),
    });
    const escalated = new SyncRefactorPlan(store, {
      load: async () => ok({ state: { status: "escalated" } } as never),
    });
    expect((await escalated.execute("break-cycle"))._unsafeUnwrap().moves[0]?.note).toBe("run r2 escalated");
    const failing = new SyncRefactorPlan(store, { load: async () => err(MetatorError.notFound("run r1")) });
    await store.save({
      ...plan(),
      moves: plan().moves.map((m) => ({ ...m, status: "running" as const, run: "r1" })),
    });
    expect((await failing.execute("break-cycle")).isErr()).toBe(true);
  });

  test("propose: a fresh report, a draft, the planner on the host, then simulate and lint", async () => {
    const { store, facts, lint, fs } = world();
    // The planner writes the moves into the draft while it runs.
    const host = new FakeAgentHost({
      "mt-arch-planner": [
        {
          text: "I move the rules to cart.",
          effect: async () => {
            const draft = (await store.load("break-the-pricing-cycle"))._unsafeUnwrap();
            await store.save({ ...draft, moves: plan().moves });
          },
        },
      ],
    });
    const analyze = {
      execute: async () =>
        ok({
          report: {} as never,
          files: { json: "r.json", markdown: ".metator/arch/report.md", html: "r.html" },
        }),
    };
    const create = new CreateRefactorPlan(store);
    const propose = new ProposeRefactorPlan(
      new Map([["scenario", host]]),
      analyze,
      store,
      create,
      new SimulateRefactorPlan(facts, store),
      lint,
    );
    const r = (
      await propose.execute({
        title: "Break the pricing cycle",
        goal: "no-cycles",
        host: "scenario",
        by: "maciej",
        cwd: "/r",
        projectRoot: "/r",
      })
    )._unsafeUnwrap();
    expect(r.problems).toEqual([]);
    expect(r.plan.result?.after.cycles).toBe(0);
    expect(host.tasks[0]).toMatchObject({
      agent: "mt-arch-planner",
      cwd: "/r",
      runDir: "/r/metator/arch/plans",
    });
    expect(host.tasks[0]?.prompt).toContain("metator/arch/plans/break-the-pricing-cycle.yml");
    expect(await fs.exists("metator/arch/plans/break-the-pricing-cycle.yml")).toBe(true);

    const unknown = await propose.execute({
      title: "x",
      goal: "no-cycles",
      host: "nope",
      by: "m",
      cwd: "/r",
      projectRoot: "/r",
    });
    expect(unknown._unsafeUnwrapErr().message).toBe("unknown host nope");
    const failing = new FakeAgentHost({ "mt-arch-planner": [{ ok: false }] });
    const stopped = new ProposeRefactorPlan(
      new Map([["scenario", failing]]),
      analyze,
      store,
      create,
      new SimulateRefactorPlan(facts, store),
      lint,
    );
    const e = (
      await stopped.execute({
        title: "Other",
        goal: "no-cycles",
        host: "scenario",
        by: "m",
        cwd: "/r",
        projectRoot: "/r",
      })
    )._unsafeUnwrapErr();
    expect([e.code, e.message]).toEqual(["COMMAND_FAILED", "scenario: the host stopped without a plan"]);
  });
});
