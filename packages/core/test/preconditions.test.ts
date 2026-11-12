import { describe, expect, test } from "bun:test";
import {
  CheckReadiness,
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  err,
  type GateReport,
  InitRun,
  isPrecondition,
  lintWorkflow,
  MetatorError,
  ok,
  PRECONDITIONS,
  type Readiness,
  type ReadinessCheck,
  RunRepository,
  readinessWarnings,
  startRefusal,
  uncheckablePreconditions,
  WorkflowCatalog,
  WorkflowSpecSchema,
} from "@metator/core";
import { FakeVcs, FixedClock, InMemoryFileSystem } from "@metator/testing";

const readiness = (...checks: ReadinessCheck[]): Readiness => ({ ready: true, place: ".", checks });
const TREE: ReadinessCheck = {
  id: "tree",
  status: "warn",
  message: "1 tracked file(s) have uncommitted changes",
};
const BRANCH: ReadinessCheck = { id: "branch", status: "warn", message: "HEAD is detached" };
const RED: ReadinessCheck = {
  id: "green",
  status: "warn",
  message: "the quick gate is red before any run: step test failed",
  fix: "metator gate quick",
};
const GREEN: ReadinessCheck = { id: "green", status: "ok", message: "the quick gate is green (1 step(s))" };

describe("preconditions: the kinds a tool decides", () => {
  test("the list is closed, and everything else is uncheckable", () => {
    expect(Object.keys(PRECONDITIONS)).toEqual(["clean-tree", "branch-ok", "tests-green"]);
    expect([isPrecondition("clean-tree"), isPrecondition("index-fresh"), isPrecondition("toString")]).toEqual(
      [true, false, false],
    );
    expect(uncheckablePreconditions(["clean-tree", "index-fresh", "tests-green", "moon-full"])).toEqual([
      "index-fresh",
      "moon-full",
    ]);
  });

  test("workflow lint rejects a precondition nothing can check, by name", () => {
    const spec = WorkflowSpecSchema.parse({
      id: "w",
      preconditions: ["clean-tree", "index-fresh"],
      stages: [{ id: "a", owner: "script:x" }],
    });
    const problems = lintWorkflow(spec, { agents: new Set(), skills: new Set(), maxParallel: 6 }).filter(
      (p) => p.section === "preconditions",
    );
    expect(problems).toEqual([
      {
        section: "preconditions",
        severity: "error",
        message:
          "preconditions: `index-fresh` cannot be checked when a run starts (checked: clean-tree, branch-ok, tests-green)",
      },
    ]);
  });
});

describe("startRefusal: a declared precondition that does not hold refuses the run", () => {
  test("clean-tree refuses a run in the checkout with the precondition's text and the fix; --allow-dirty is the person's decision", () => {
    const dirty = readiness(TREE);
    expect(startRefusal(dirty, { worktree: false })).toBeUndefined();
    expect(startRefusal(dirty, { worktree: false, preconditions: [] })).toBeUndefined();
    const refusal = startRefusal(dirty, { worktree: false, preconditions: ["clean-tree"] });
    expect([refusal?.code, refusal?.message, refusal?.details]).toEqual([
      "CHECK_FAILED",
      "precondition clean-tree does not hold (no tracked file has uncommitted changes): 1 tracked file(s) have uncommitted changes",
      { precondition: "clean-tree" },
    ]);
    expect(refusal?.hint).toContain("git commit -am <message>");
    expect(refusal?.hint).toContain("--allow-dirty");
    expect(
      startRefusal(dirty, { worktree: false, allowDirty: true, preconditions: ["clean-tree"] }),
    ).toBeUndefined();
    expect(startRefusal(readiness(), { worktree: false, preconditions: ["clean-tree"] })).toBeUndefined();
  });

  test("branch-ok refuses a detached HEAD in the checkout; a worktree brings its own branch", () => {
    const refusal = startRefusal(readiness(BRANCH), { worktree: false, preconditions: ["branch-ok"] });
    expect(refusal?.message).toBe(
      "precondition branch-ok does not hold (the checkout is on a branch, not on a detached HEAD): HEAD is detached",
    );
    expect(refusal?.hint).toContain("git switch -c <branch>");
    expect(startRefusal(readiness(BRANCH), { worktree: true, preconditions: ["branch-ok"] })).toBeUndefined();
    expect(
      startRefusal(readiness(BRANCH), { worktree: false, preconditions: ["clean-tree"] }),
    ).toBeUndefined();
    expect(startRefusal(readiness(), { worktree: false, preconditions: ["branch-ok"] })).toBeUndefined();
  });

  test("tests-green holds only when the quick gate ran and passed", () => {
    expect(
      startRefusal(readiness(GREEN), { worktree: false, preconditions: ["tests-green"] }),
    ).toBeUndefined();
    const red = startRefusal(readiness(RED), { worktree: true, preconditions: ["tests-green"] });
    expect(red?.message).toBe(
      "precondition tests-green does not hold (the quick gate passes): the quick gate is red before any run: step test failed",
    );
    expect(red?.hint).toStartWith("Run `metator gate quick` to see the failing steps");
    // Not run is not green: nothing is assumed.
    const unknown = startRefusal(readiness(), { worktree: false, preconditions: ["tests-green"] });
    expect(unknown?.message).toEndWith("the quick gate was not run");
    // No steps: the fix is the config key, said as it is.
    const empty = startRefusal(
      readiness({ id: "green", status: "warn", message: "the quick gate has no steps", fix: "Add a step" }),
      { worktree: false, preconditions: ["tests-green"] },
    );
    expect(empty?.hint).toBe("Add a step");
  });

  test("a precondition nothing can check refuses the run instead of passing for held", () => {
    const refusal = startRefusal(readiness(), { worktree: false, preconditions: ["index-fresh"] });
    expect([refusal?.code, refusal?.details]).toEqual(["CHECK_FAILED", { precondition: "index-fresh" }]);
    expect(refusal?.message).toBe(
      "the workflow requires `index-fresh`, which nothing can check (checked: clean-tree, branch-ok, tests-green)",
    );
    expect(refusal?.hint).toContain("metator setup");
  });

  test("the first precondition that does not hold is the one reported", () => {
    const both = readiness(TREE, BRANCH);
    const order = (preconditions: string[]) =>
      startRefusal(both, { worktree: false, preconditions })?.details?.precondition;
    expect([order(["clean-tree", "branch-ok"]), order(["branch-ok", "clean-tree"])]).toEqual([
      "clean-tree",
      "branch-ok",
    ]);
  });
});

describe("CheckReadiness: a detached HEAD and the quick gate", () => {
  const quick = [{ id: "test", run: { script: "test" } }];
  const check = (
    extra: ConstructorParameters<typeof CheckReadiness>[10],
    gates: unknown = quick,
    source: string | undefined = "metator.config.yml",
  ) =>
    new CheckReadiness(
      { exists: async () => true },
      DEFAULT_PATHS,
      { config: { ...DEFAULT_CONFIG, gates: { quick: gates, full: [] } } as never, source },
      { scan: async () => ({ workflows: [{ spec: { id: "w" } }], problems: [] }) as never },
      new FakeVcs([], [], "git@example.com:a/b.git"),
      async () => true,
      { get: async () => ok({ path: ".metator/wt/a" }) as never },
      undefined,
      undefined,
      undefined,
      extra,
    );
  const report = (...steps: GateReport["steps"]): GateReport => ({
    gate: "quick",
    files: null,
    startedAt: "2026-11-12T00:00:00.000Z",
    passed: steps.every((s) => s.status === "pass"),
    steps,
  });
  const find = (r: Readiness, id: string) => r.checks.find((c) => c.id === id);

  test("a detached HEAD is said, with the fix; a branch, a worktree or git that cannot say add nothing", async () => {
    const detached = (await check({ detached: async () => true }).execute())._unsafeUnwrap();
    expect(find(detached, "branch")).toMatchObject({ status: "warn", fix: "git switch -c <branch>" });
    expect(detached.ready).toBe(true);
    expect(readinessWarnings(detached).some((w) => w.startsWith("branch: HEAD is detached"))).toBe(true);
    for (const answer of [false, undefined])
      expect(
        find((await check({ detached: async () => answer }).execute())._unsafeUnwrap(), "branch"),
      ).toBeUndefined();
    const inWorktree = (
      await check({ detached: async () => true }).execute({ worktree: "a" })
    )._unsafeUnwrap();
    expect(find(inWorktree, "branch")).toBeUndefined();
  });

  test("the quick gate runs only when asked, once", async () => {
    let ran = 0;
    const c = check({
      quickGate: async () => {
        ran++;
        return ok(report({ id: "test", status: "pass", durationMs: 1 }));
      },
    });
    expect(find((await c.execute())._unsafeUnwrap(), "green")).toBeUndefined();
    expect(ran).toBe(0);
    const asked = (await c.execute({ gates: true }))._unsafeUnwrap();
    expect(ran).toBe(1);
    expect(find(asked, "green")).toEqual({
      id: "green",
      status: "ok",
      message: "the quick gate is green (1 step(s))",
    });
  });

  test("a red quick gate names the failing steps, the last line of the first one, and the command to see more", async () => {
    const c = check({
      quickGate: async () =>
        ok(
          report(
            { id: "lint", status: "pass", durationMs: 1 },
            { id: "test", status: "fail", durationMs: 1, detail: "$ bun test\n  2 tests failed\n\n" },
            { id: "types", status: "error", durationMs: 1, detail: "not found: tsc" },
          ),
        ),
    });
    const red = (await c.execute({ gates: true }))._unsafeUnwrap();
    expect(find(red, "green")).toEqual({
      id: "green",
      status: "warn",
      message:
        "the quick gate is red before any run: step test, types failed (test: 2 tests failed); a run's gates stage would fail on it",
      fix: "metator gate quick",
    });
    // A run can still start: only a workflow that requires tests-green refuses.
    expect(red.ready).toBe(true);
    expect(startRefusal(red, { worktree: false, preconditions: ["tests-green"] })?.code).toBe("CHECK_FAILED");
    expect(startRefusal(red, { worktree: false, preconditions: [] })).toBeUndefined();
  });

  test("no steps, a gate that cannot run, a gate nobody wired: said as they are, never as green", async () => {
    let ran = 0;
    const none = await check(
      {
        quickGate: async () => {
          ran++;
          return ok(report());
        },
      },
      [],
    ).execute({ gates: true });
    expect(find(none._unsafeUnwrap(), "green")).toMatchObject({
      status: "warn",
      message: "the quick gate has no steps: nothing says whether the checks are green before a run",
    });
    expect(find(none._unsafeUnwrap(), "green")?.fix).toContain("gates.quick:");
    expect(ran).toBe(0);
    const broken = await check({
      quickGate: async () => err(new MetatorError("COMMAND_FAILED", "disk full")),
    }).execute({ gates: true });
    expect(find(broken._unsafeUnwrap(), "green")).toEqual({
      id: "green",
      status: "warn",
      message: "the quick gate did not run: disk full",
      fix: "metator gate quick",
    });
    const unwired = await check({}).execute({ gates: true });
    expect(find(unwired._unsafeUnwrap(), "green")?.message).toBe("the quick gate was not run");
  });

  test("the gate of a worktree is not this checkout's to run", async () => {
    const refused = (await check({}).execute({ gates: true, worktree: "a" }))._unsafeUnwrapErr();
    expect([refused.code, refused.hint]).toEqual([
      "USAGE",
      "Run `metator gate quick` in the worktree's directory.",
    ]);
  });
});

describe("InitRun: the workflow's preconditions decide whether a run starts", () => {
  const workflow = (preconditions: string) => `
kind: Workflow
schemaVersion: 3
id: w
preconditions: ${preconditions}
stages:
  - id: plan
`;
  const world = (preconditions: string, ...checks: ReadinessCheck[]) => {
    const fs = new InMemoryFileSystem({ ".github/metator/workflows/w.yml": workflow(preconditions) });
    const repo = new RunRepository(fs, DEFAULT_PATHS);
    const asked: unknown[] = [];
    const init = new InitRun(
      new WorkflowCatalog(fs, DEFAULT_PATHS),
      repo,
      new FixedClock(new Date("2026-11-12T09:00:00.000Z")),
      undefined,
      {
        execute: async (input) => {
          asked.push(input);
          return ok(readiness(...checks));
        },
      },
    );
    return { repo, init, asked };
  };

  test("a dirty tree refuses a run of a workflow that requires clean-tree; nothing is created; allowDirty starts it", async () => {
    const w = world("[clean-tree]", TREE);
    const refused = (await w.init.execute({ workflow: "w", task: "t" }))._unsafeUnwrapErr();
    expect([refused.code, refused.details]).toEqual(["CHECK_FAILED", { precondition: "clean-tree" }]);
    expect(await w.repo.list()).toEqual([]);
    expect((await w.init.execute({ workflow: "w", task: "t", allowDirty: true })).isOk()).toBe(true);
    // A workflow that does not require it starts as before.
    expect((await world("[]", TREE).init.execute({ workflow: "w", task: "t" })).isOk()).toBe(true);
  });

  test("the quick gate is run only for a workflow that requires tests-green", async () => {
    const plain = world("[clean-tree, branch-ok]");
    expect((await plain.init.execute({ workflow: "w", task: "t" })).isOk()).toBe(true);
    expect(plain.asked).toEqual([{}]);
    const red = world("[tests-green]", RED);
    expect((await red.init.execute({ workflow: "w", task: "t" }))._unsafeUnwrapErr().details).toEqual({
      precondition: "tests-green",
    });
    expect(red.asked).toEqual([{ gates: true }]);
    expect((await world("[tests-green]", GREEN).init.execute({ workflow: "w", task: "t" })).isOk()).toBe(
      true,
    );
  });

  test("a precondition nothing can check refuses the run", async () => {
    const refused = (
      await world("[index-fresh]").init.execute({ workflow: "w", task: "t" })
    )._unsafeUnwrapErr();
    expect(refused.message).toContain("`index-fresh`, which nothing can check");
  });
});
