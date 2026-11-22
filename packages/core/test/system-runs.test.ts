import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { SystemCatalog } from "../src/application/system.ts";
import { SystemPlanStore } from "../src/application/system-plans.ts";
import {
  type RepositoryRuns,
  RetrySystemStep,
  RunSystemPlan,
  SystemPlanStatus,
  SystemRunGate,
} from "../src/application/system-runs.ts";
import { CloneCache, LocalSystemLocation, SystemSources } from "../src/application/system-sources.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { ok } from "../src/domain/result.ts";
import { readySteps, type SystemPlan, stepTask, systemPlanDigest } from "../src/domain/system-plan.ts";

const TINY = "kind: Workflow\nschemaVersion: 2\nid: mt-feature\nstages:\n  - id: build\n";
const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - { id: billing, source: { path: apps/billing } }
  - { id: web, source: { repo: ../web }, consumes: [billing-api] }
  - { id: mail, source: { repo: git@x:mail.git }, consumes: [billing-api] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
`;

const step = (id: string, app: string, dependsOn: string[] = [], status: "pending" | "done" = "pending") => ({
  id,
  app,
  summary: `Do ${id}`,
  contracts: [{ id: "billing-api", role: id.endsWith("bump") ? ("bump" as const) : ("migrate" as const) }],
  dependsOn,
  status,
});
const plan = (steps: SystemPlan["steps"]): SystemPlan => {
  const p: SystemPlan = { id: "rename", task: "Rename refunds", status: "approved", strategies: [], steps };
  return { ...p, approval: { by: "ana", at: "t", digest: systemPlanDigest(p) } };
};

describe("linked runs domain", () => {
  test("ready steps: pending with every dependency done", () => {
    const p = plan([
      step("billing-bump", "billing", [], "done"),
      step("web-migrate", "web", ["billing-bump"]),
      step("mail-migrate", "mail", ["web-migrate"]),
    ]);
    expect(readySteps(p).map((s) => s.id)).toEqual(["web-migrate"]);
    expect(readySteps(plan([step("a", "billing", ["b"]), step("b", "web")])).map((s) => s.id)).toEqual(["b"]);
  });

  test("a step's task says what, where and how it fits the plan", () => {
    const p = plan([step("billing-bump", "billing")]);
    const s = {
      ...step("web-migrate", "web", ["billing-bump"]),
      deploy: { flag: "new-refunds", rollback: "turn the flag off" },
    };
    expect(stepTask(p, s, "apps/web")).toBe(
      "Do web-migrate (system plan rename, step web-migrate in web at apps/web; contracts: migrate billing-api; after billing-bump; behind flag new-refunds; rollback: turn the flag off. Task: Rename refunds)",
    );
    expect(stepTask(p, step("billing-bump", "billing"), ".")).toBe(
      "Do billing-bump (system plan rename, step billing-bump in billing; contracts: bump billing-api. Task: Rename refunds)",
    );
  });
});

/** One repository on the in-memory file system: its runs, catalog and clock. */
function repository(root: string, shared: InMemoryFileSystem) {
  const fs = shared;
  const paths = {
    ...DEFAULT_PATHS,
    runs: `${root}/.metator/runs`,
    workflows: `${root}/.github/metator/workflows`,
  };
  const clock = new FixedClock(new Date("2026-10-29T09:00:00.000Z"));
  const runs = new RunRepository(fs, paths);
  const catalog = new WorkflowCatalog(fs, paths);
  const init = new InitRun(catalog, runs, clock);
  /** The sessions asked for: each child run opens as a conductor session a person sees. */
  const sessions: { runId: string; host?: string }[] = [];
  /** Where each child was asked to work: in a worktree of its own, or in the checkout. */
  const worktrees: { task: string; worktree: boolean }[] = [];
  return {
    runs,
    init,
    sessions,
    worktrees,
    // StartRun as the runtime wires it, reduced to what a child run needs: the run, then its session.
    start: {
      execute: async (input: Parameters<RepositoryRuns["start"]["execute"]>[0]) => {
        worktrees.push({ task: input.task, worktree: input.worktree !== undefined });
        // The in-memory world has no git: the run is made where it is, its worktree only asked for.
        const { worktree: _asked, session: _seen, drive: _driven, ...rest } = input;
        return (await init.execute(rest as Parameters<InitRun["execute"]>[0])).map((run) => {
          if (input.session)
            sessions.push({ runId: run.runId, ...(input.session.host ? { host: input.session.host } : {}) });
          return {
            run,
            warnings: [],
            ...(input.session ? { session: { paneId: "w1:p1", host: input.session.host ?? "claude" } } : {}),
            ...(input.drive
              ? { drive: { stage: run.stage, started: true, host: input.drive.host ?? "claude" } }
              : {}),
          };
        });
      },
    },
    advance: new AdvanceRun(catalog, runs, clock),
    clock,
  };
}

function world(steps: SystemPlan["steps"], roots: Record<string, string> = { web: "../web" }) {
  const fs = new InMemoryFileSystem({
    "docs/metator/system.yml": MAP,
    "platform/.github/metator/workflows/mt-feature.yml": TINY,
    "web/.github/metator/workflows/mt-feature.yml": TINY,
  });
  const store = new SystemPlanStore(fs, "metator/system/plans");
  const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/src/platform");
  const dirs = ["/src/web"];
  const sources = new SystemSources(
    { roots },
    "/src/platform",
    location,
    new CloneCache({ resolve: async () => ok("a"), checkout: async () => ok(undefined) }, "/c"),
    { isDirectory: async (p: string) => dirs.includes(p), read: async () => ok(undefined) },
    { remoteUrl: async () => ok(undefined) },
  );
  const repos = new Map([
    ["/src/platform", repository("platform", fs)],
    ["/src/web", repository("web", fs)],
  ]);
  const at = (root: string): RepositoryRuns => repos.get(root) as RepositoryRuns;
  const platform = repos.get("/src/platform") as ReturnType<typeof repository>;
  return {
    fs,
    store,
    repos,
    platform,
    sources,
    at,
    run: new RunSystemPlan(store, sources, at, platform.clock, platform.runs),
    status: new SystemPlanStatus(store, sources, at),
    save: () => store.save(plan(steps)),
  };
}

describe("RunSystemPlan and SystemPlanStatus", () => {
  test("a child is added to the parent's record as it is now: one another process added meanwhile stays", async () => {
    const w = world([step("billing-bump", "billing")]);
    await w.save();
    const parent = (
      await w.platform.init.execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    // Another process links a child of its own while this one starts the step's run.
    const runs = w.platform.runs;
    const init = w.platform.init.execute.bind(w.platform.init);
    w.platform.init.execute = async (input) => {
      const started = await init(input);
      await runs.update(parent.runId, (r) =>
        ok({ ...r, children: [...(r.children ?? []), "20261029-other"] }),
      );
      return started;
    };
    const first = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect((await runs.load(parent.runId))._unsafeUnwrap().children).toEqual([
      "20261029-other",
      first.started[0]?.run as string,
    ]);
  });

  test("the ready steps start in their repositories, linked to the parent; status reads them back", async () => {
    const w = world([step("billing-bump", "billing"), step("web-migrate", "web", ["billing-bump"])]);
    await w.save();
    const parent = (
      await w.platform.init.execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    const first = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect(first.started.map((s) => [s.step, s.root])).toEqual([["billing-bump", "/src/platform"]]);
    // Each child opens as a conductor session a person sees (ADR-0090): not a headless drive.
    expect(w.platform.sessions).toEqual([{ runId: first.started[0]?.run as string }]);
    expect([first.started[0]?.session, first.started[0]?.drive]).toEqual([
      { paneId: "w1:p1", host: "claude" },
      undefined,
    ]);
    const child = (await w.platform.runs.load(first.started[0]?.run as string))._unsafeUnwrap();
    expect([child.parent, child.system]).toEqual([
      parent.runId,
      { plan: "rename", step: "billing-bump", app: "billing" },
    ]);
    expect((await w.platform.runs.load(parent.runId))._unsafeUnwrap().children).toEqual([
      first.started[0]?.run as string,
    ]);
    expect((await w.platform.runs.readLog(parent.runId))._unsafeUnwrap().at(-1)).toContain("· child · ");
    expect(first.plan.steps.map((s) => [s.id, s.status])).toEqual([
      ["billing-bump", "running"],
      ["web-migrate", "pending"],
    ]);
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrap().started).toEqual([]);

    const running = (await w.status.execute("rename"))._unsafeUnwrap();
    expect(running.steps.map((s) => [s.id, s.status, s.runStatus ?? null])).toEqual([
      ["billing-bump", "running", "active"],
      ["web-migrate", "pending", null],
    ]);
    await w.platform.advance.execute({ runId: first.started[0]?.run as string, event: { type: "PASS" } });
    expect((await w.status.execute("rename"))._unsafeUnwrap().steps[0]?.status).toBe("done");
    const second = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect(second.started.map((s) => [s.step, s.root])).toEqual([["web-migrate", "/src/web"]]);
    const web = w.repos.get("/src/web") as ReturnType<typeof repository>;
    await web.advance.execute({
      runId: second.started[0]?.run as string,
      event: { type: "ABORT", reason: "no" },
    });
    const blocked = (await w.status.execute("rename"))._unsafeUnwrap();
    expect([blocked.steps[1]?.status, blocked.plan.status]).toEqual(["blocked", "running"]);
    expect((await w.platform.runs.load(parent.runId))._unsafeUnwrap().children).toHaveLength(2);
  });

  test("the system run's gate starts the next wave itself and keeps waiting: a new wave is a wait, never a failure", async () => {
    const w = world([step("billing-bump", "billing"), step("web-migrate", "web", ["billing-bump"])]);
    await w.save();
    const parent = (
      await w.platform.init.execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    const first = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    await w.platform.advance.execute({ runId: first.started[0]?.run as string, event: { type: "PASS" } });
    const gate = new SystemRunGate(w.status, w.platform.runs, w.platform.clock, w.run);
    const g = (await gate.execute({ id: "rename", run: parent.runId }))._unsafeUnwrap();
    expect([g.kind, g.message]).toEqual([
      "waiting",
      "started the next wave: web-migrate in web (session in pane w1:p1 on claude)",
    ]);
    expect((await w.platform.runs.load(parent.runId))._unsafeUnwrap().children).toHaveLength(2);
  });

  test("every step works on a branch and in a worktree of its own, never on the checkout's branch", async () => {
    const w = world([
      step("billing-model", "billing"),
      step("billing-endpoint", "billing"),
      step("web-tag", "web"),
      step("web-integration", "web", ["billing-model", "billing-endpoint", "web-tag"]),
    ]);
    await w.save();
    const wave = (await w.run.execute({ id: "rename" }))._unsafeUnwrap();
    // The owner's flow: two backend steps and one frontend step in parallel, three child runs.
    expect(wave.started.map((s) => [s.step, s.root])).toEqual([
      ["billing-model", "/src/platform"],
      ["billing-endpoint", "/src/platform"],
      ["web-tag", "/src/web"],
    ]);
    const web = w.repos.get("/src/web") as ReturnType<typeof repository>;
    expect(w.platform.worktrees.map((t) => t.worktree)).toEqual([true, true]);
    // A step alone in its repository too: its agents commit and publish on the run's own branch.
    expect(web.worktrees.map((t) => t.worktree)).toEqual([true]);
    // The last step waits for all three; while web-tag still runs, it is not started.
    expect(wave.plan.steps.find((s) => s.id === "web-integration")?.status).toBe("pending");
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrap().started).toEqual([]);
  });

  test("a step while another step of its application still runs gets a worktree too", async () => {
    const w = world([step("billing-model", "billing"), step("billing-docs", "billing", ["billing-model"])]);
    const running = plan([
      { ...step("billing-model", "billing"), status: "running" as const, run: "r1" },
      step("billing-late", "billing"),
    ]);
    (await w.store.save(running))._unsafeUnwrap();
    const started = (await w.run.execute({ id: "rename" }))._unsafeUnwrap();
    expect(started.started.map((s) => s.step)).toEqual(["billing-late"]);
    expect(w.platform.worktrees.map((t) => t.worktree)).toEqual([true]);
  });

  test("a child run's session is on its parent's host; one with no session is driven, and says why; one that cannot be driven still starts", async () => {
    const w = world([step("billing-bump", "billing")]);
    await w.save();
    const parent = (
      await w.platform.init.execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    const record = (await w.platform.runs.load(parent.runId))._unsafeUnwrap();
    (await w.platform.runs.save({ ...record, host: "scenario" }))._unsafeUnwrap();
    const started = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect(w.platform.sessions).toEqual([{ runId: started.started[0]?.run as string, host: "scenario" }]);

    const failing = world([step("billing-bump", "billing")]);
    await failing.save();
    const at = (root: string): RepositoryRuns => ({
      runs: failing.at(root).runs,
      start: {
        execute: async (input) =>
          (await failing.at(root).start.execute({ ...input, session: undefined } as never)).map((v) => ({
            ...v,
            noSession: "no daemon runs for this repository",
            driveError: { message: "AI host claude cannot start here" },
          })),
      },
    });
    const run = new RunSystemPlan(
      failing.store,
      failing.sources,
      at,
      failing.platform.clock,
      failing.platform.runs,
    );
    const r = (await run.execute({ id: "rename" }))._unsafeUnwrap();
    expect(r.started.map((s) => [s.step, s.session, s.noSession, s.driveError])).toEqual([
      ["billing-bump", undefined, "no daemon runs for this repository", "AI host claude cannot start here"],
    ]);
  });

  test("every step done finishes the plan", async () => {
    const w = world([step("billing-bump", "billing")]);
    await w.save();
    const r = (await w.run.execute({ id: "rename", workflow: "mt-feature" }))._unsafeUnwrap();
    await w.platform.advance.execute({ runId: r.started[0]?.run as string, event: { type: "PASS" } });
    expect((await w.status.execute("rename"))._unsafeUnwrap().plan.status).toBe("done");
  });

  test("a draft, a changed plan or an application without a checkout does not start", async () => {
    const w = world([step("mail-migrate", "mail")]);
    await w.store.save({ ...plan([step("mail-migrate", "mail")]), status: "draft" });
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe("rename is not approved");
    await w.store.save({ ...plan([step("mail-migrate", "mail")]), steps: [step("other", "mail")] });
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "the steps of rename changed after ana approved them",
    );
    await w.save();
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "no checkout of mail to run step mail-migrate in",
    );
    const ghost = world([step("ghost-x", "ghost")]);
    await ghost.save();
    expect((await ghost.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "step ghost-x: application ghost is not in the map",
    );
  });

  test("a wave starts whole or not at all: a step without a checkout stops it before anything starts", async () => {
    const w = world([step("billing-bump", "billing"), step("mail-migrate", "mail")]);
    await w.save();
    expect((await w.run.execute({ id: "rename" }))._unsafeUnwrapErr().message).toBe(
      "no checkout of mail to run step mail-migrate in",
    );
    expect((await w.store.load("rename"))._unsafeUnwrap().steps.map((s) => s.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(await w.platform.runs.list()).toEqual([]);
  });

  test("a change another writer made to the parent run while a step started is kept (R5)", async () => {
    const w = world([step("billing-bump", "billing"), step("web-migrate", "web")]);
    await w.save();
    const parent = (
      await w.platform.init.execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    // Another process changes the parent's record each time a child run starts.
    let n = 0;
    const at = (root: string): RepositoryRuns => ({
      runs: w.at(root).runs,
      start: {
        execute: async (input) => {
          n++;
          const noted = await w.platform.runs.update(parent.runId, (r) =>
            ok({ ...r, options: { ...(r.options ?? {}), [`note.${n}`]: true } }),
          );
          expect(noted.isOk()).toBe(true);
          return w.at(root).start.execute(input);
        },
      },
    });
    const run = new RunSystemPlan(w.store, w.sources, at, w.platform.clock, w.platform.runs);
    const started = (await run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect(started.started).toHaveLength(2);
    const record = (await w.platform.runs.load(parent.runId))._unsafeUnwrap();
    expect(record.options).toEqual({ "note.1": true, "note.2": true });
    expect(record.children).toEqual(started.started.map((s) => s.run));
  });
});

describe("RetrySystemStep: a person re-opens a step whose child run was aborted", () => {
  test("the step is pending again with the old run in its history; the next wave starts a new child for it", async () => {
    const w = world([step("billing-bump", "billing")]);
    await w.save();
    const parent = (
      await w.platform.init.execute({ workflow: "mt-feature", task: "Rename refunds" })
    )._unsafeUnwrap();
    const first = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    const old = first.started[0]?.run as string;
    await w.platform.advance.execute({ runId: old, event: { type: "ABORT", reason: "nothing to do" } });
    expect((await w.status.execute("rename"))._unsafeUnwrap().steps[0]?.status).toBe("blocked");
    const retry = new RetrySystemStep(w.store, w.sources, w.at, w.platform.clock);
    // Who retries is named.
    expect(
      (await retry.execute({ id: "rename", step: "billing-bump", by: " " }))._unsafeUnwrapErr().code,
    ).toBe("USAGE");
    const plan = (await retry.execute({ id: "rename", step: "billing-bump", by: "ana" }))._unsafeUnwrap();
    const again = plan.steps[0];
    expect([again?.status, again?.run]).toEqual(["pending", undefined]);
    expect(again?.previousRuns).toEqual([
      { run: old, status: "aborted", retriedBy: "ana", at: "2026-10-29T09:00:00.000Z" },
    ]);
    // The approval still holds (progress is not what a person approved): a new child starts.
    const second = (await w.run.execute({ id: "rename", parent: parent.runId }))._unsafeUnwrap();
    expect(second.started.map((s) => s.step)).toEqual(["billing-bump"]);
    expect(second.started[0]?.run).not.toBe(old);
    expect((await w.status.execute("rename"))._unsafeUnwrap().steps[0]?.status).toBe("running");
  });

  test("only a step whose run ended aborted is retried; one still running, done or escalated is not", async () => {
    const w = world([step("billing-bump", "billing")]);
    await w.save();
    const retry = new RetrySystemStep(w.store, w.sources, w.at, w.platform.clock);
    expect(
      (await retry.execute({ id: "rename", step: "billing-bump", by: "ana" }))._unsafeUnwrapErr().message,
    ).toBe("step billing-bump has no run to retry: it is pending");
    const first = (await w.run.execute({ id: "rename" }))._unsafeUnwrap();
    expect(
      (await retry.execute({ id: "rename", step: "billing-bump", by: "ana" }))._unsafeUnwrapErr().message,
    ).toBe(
      `step billing-bump's run ${first.started[0]?.run} is active: only an aborted run's step is retried`,
    );
    expect((await retry.execute({ id: "rename", step: "nope", by: "ana" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });
});
