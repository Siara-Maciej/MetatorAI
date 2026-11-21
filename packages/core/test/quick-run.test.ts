import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { QuickFit, QuickReady, QuickStart } from "../src/application/quick-run.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import type { Escalator, QuickVerdict } from "../src/domain/quick.ts";
import { ok } from "../src/domain/result.ts";

const stage = (id: string) => `  - id: ${id}\n    owner: mt-implementer\n`;
const QUICK = `kind: Workflow\nschemaVersion: 2\nid: mt-quick\nstages:\n${stage("build")}${stage("fit")}${stage("ready")}`;
const FEATURE = `kind: Workflow\nschemaVersion: 2\nid: mt-feature\nstages:\n${stage("plan")}`;
const SYSTEM = `kind: Workflow\nschemaVersion: 2\nid: mt-system-change\nstages:\n${stage("analyze")}`;
const LIMITS = { maxFiles: 5, maxLines: 150, maxDependents: 10 };
const verdict = (...escalators: Escalator[]): QuickVerdict & { files: string[] } => ({
  quick: escalators.length === 0,
  escalators,
  thresholds: LIMITS,
  files: ["src/a.ts"],
});
const SIZE: Escalator = { id: "size", why: "9 files (limit 5)", source: "git diff" };
const CROSS: Escalator = {
  id: "cross-repository",
  why: "it reaches another repository: shop-web",
  source: "metator system impact",
};

function world(dirty: string[] = []) {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/mt-quick.yml": QUICK,
    ".github/metator/workflows/mt-feature.yml": FEATURE,
    ".github/metator/workflows/mt-system-change.yml": SYSTEM,
  });
  const clock = new FixedClock(new Date("2026-11-21T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const init = new InitRun(catalog, repo, clock);
  const advance = new AdvanceRun(catalog, repo, clock);
  const started: Record<string, unknown>[] = [];
  const adopted: [string, string][] = [];
  const driven = { live: false };
  // StartRun as the runtime wires it, reduced to the run itself; what was asked of it is kept.
  const start = {
    execute: async (input: Record<string, unknown>) => {
      started.push(input);
      const { worktree: _w, session: _s, allowDirty: _d, adopt: _a, ...rest } = input;
      return (await init.execute(rest as never)).map((run) => ({
        run,
        warnings: [],
        session: { paneId: "w1:p1", host: "claude" },
      }));
    },
  };
  const deps = {
    start: start as never,
    repo,
    journal,
    fs,
    clock,
    tree: { modifiedTracked: async () => dirty },
  };
  const activity = async (runId: string) =>
    (await journal.activity(runId))._unsafeUnwrap().map((a) => a.text);
  return {
    fs,
    repo,
    journal,
    advance,
    started,
    activity,
    start: new QuickStart(deps),
    adopted,
    fit: new QuickFit({
      ...deps,
      adopted: async (worktree, run) => {
        adopted.push([worktree, run]);
        return ok(undefined);
      },
      close: {
        execute: async (i: { runId?: string; abortReason?: string }) => {
          await advance.execute({
            runId: i.runId as string,
            event: { type: "ABORT", reason: i.abortReason ?? "" },
          });
          return ok({} as never);
        },
      },
    }),
    driven,
    ready: new QuickReady({ repo, journal, advance, driven: async () => driven.live }),
  };
}

describe("QuickStart", () => {
  test("a quick change starts as an mt-quick run with its conductor session, on the current branch", async () => {
    const w = world();
    const r = (await w.start.execute({ task: "Rename the price helper", check: verdict() }))._unsafeUnwrap();
    expect(r.session).toEqual({ paneId: "w1:p1", host: "claude" });
    expect(w.started).toEqual([{ workflow: "mt-quick", task: "Rename the price helper", session: {} }]);
    expect((await w.repo.load(r.runId))._unsafeUnwrap().workflow.id).toBe("mt-quick");
  });

  test("escalators refuse it, with which; the person's sentence keeps it quick and is recorded; never across repositories", async () => {
    const w = world();
    const refused = (await w.start.execute({ task: "Change it", check: verdict(SIZE) }))._unsafeUnwrapErr();
    expect([refused.code, refused.message]).toEqual([
      "USAGE",
      'not quick: size (9 files (limit 5)). The person may keep it quick with one sentence (--override "<their words>").',
    ]);
    expect(refused.details).toMatchObject({ escalators: [SIZE] });
    const kept = (
      await w.start.execute({
        task: "Change it",
        check: verdict(SIZE),
        override: "it is one rename, keep it quick",
      })
    )._unsafeUnwrap();
    expect(await w.activity(kept.runId)).toContain(
      'quick although size (9 files (limit 5)): the person keeps it quick: "it is one rename, keep it quick"',
    );
    const cross = await w.start.execute({
      task: "Change it",
      check: verdict(CROSS),
      override: "keep it quick",
    });
    expect(cross._unsafeUnwrapErr().message).toStartWith("not quick, and this cannot be overridden");
    expect(w.started).toHaveLength(1);
  });

  test("a dirty checkout asks where: here (the changes join it) or a worktree of its own", async () => {
    const w = world(["src/other.ts"]);
    const asked = (await w.start.execute({ task: "Change it", check: verdict() }))._unsafeUnwrapErr();
    expect([asked.message, asked.hint]).toEqual([
      "dirty: pass --here or --worktree",
      "The checkout has uncommitted changes (src/other.ts): --here works in it (they become part of the change), --worktree in a worktree of its own from the last commit. Ask the person which.",
    ]);
    (await w.start.execute({ task: "Change it", check: verdict(), where: "here" }))._unsafeUnwrap();
    (await w.start.execute({ task: "Change it again", check: verdict(), where: "worktree" }))._unsafeUnwrap();
    expect(w.started.map((s) => [s.allowDirty, s.worktree])).toEqual([
      [true, undefined],
      [undefined, { allowDirty: true }],
    ]);
  });
});

describe("QuickFit: the real diff against the limits, after the build", () => {
  const begin = async (w: ReturnType<typeof world>, override?: string, check = verdict()) =>
    (await w.start.execute({ task: "Change it", check, ...(override ? { override } : {}) }))._unsafeUnwrap()
      .runId;

  test("still quick: it passes; what the person kept quick at the start is not asked about again", async () => {
    const w = world();
    const runId = await begin(w);
    expect((await w.fit.execute({ runId, verdict: verdict() }))._unsafeUnwrap()).toEqual({ state: "fits" });
    const kept = await begin(w, "keep it quick", verdict(SIZE));
    expect((await w.fit.execute({ runId: kept, verdict: verdict(SIZE) }))._unsafeUnwrap()).toEqual({
      state: "fits",
    });
  });

  test("it grew: one card, waiting until the person answers; Keep as quick passes and is recorded", async () => {
    const w = world();
    const runId = await begin(w);
    const waiting = (await w.fit.execute({ runId, verdict: verdict(SIZE) }))._unsafeUnwrap();
    const q = (await w.journal.questions(runId))._unsafeUnwrap()[0];
    expect(waiting).toEqual({ state: "waiting", question: q?.id as string, escalators: [SIZE] });
    expect([q?.prompt, q?.source, q?.agent, q?.options.map((o) => o.label)]).toEqual([
      "This grew past quick: size (9 files (limit 5))",
      "agent",
      "metator",
      ["Continue as full", "Keep as quick", "Other"],
    ]);
    // Asked once.
    await w.fit.execute({ runId, verdict: verdict(SIZE) });
    expect((await w.journal.questions(runId))._unsafeUnwrap()).toHaveLength(1);
    // The person's own words decide nothing: the card stands again.
    await w.journal.answer(runId, q?.id as string, { choices: [], text: "hm, which files?", by: "ana" });
    const again = (await w.fit.execute({ runId, verdict: verdict(SIZE) }))._unsafeUnwrap();
    expect([again.state, (await w.journal.questions(runId))._unsafeUnwrap().length]).toEqual(["waiting", 2]);
    await w.journal.answer(runId, (again as { question: string }).question, {
      choices: ["Keep as quick"],
      by: "ana",
    });
    expect((await w.fit.execute({ runId, verdict: verdict(SIZE) }))._unsafeUnwrap()).toEqual({
      state: "fits",
    });
    expect(await w.activity(runId)).toContain("quick although size (9 files (limit 5)): ana keeps it quick");
  });

  test("Continue as full: a full run takes the change over (the diff stays), and the quick run is closed with where it went", async () => {
    const w = world();
    const runId = await begin(w);
    await w.fit.execute({ runId, verdict: verdict(SIZE) });
    const q = (await w.journal.questions(runId))._unsafeUnwrap()[0];
    await w.journal.answer(runId, q?.id as string, { choices: ["Continue as full"], by: "ana" });
    const moved = (await w.fit.execute({ runId, verdict: verdict(SIZE) }))._unsafeUnwrap();
    expect(moved.state).toBe("full");
    const full = (moved as { run: string }).run;
    expect((await w.repo.load(full))._unsafeUnwrap().workflow.id).toBe("mt-feature");
    expect(w.started.at(-1)).toMatchObject({ workflow: "mt-feature", allowDirty: true, session: {} });
    expect(String(w.started.at(-1)?.task)).toContain(`continues quick run ${runId}`);
    expect((await w.repo.load(runId))._unsafeUnwrap().state.status).toBe("aborted");
  });

  test("a quick run in a worktree of its own: the full run adopts that worktree, and the registry says whose it is now", async () => {
    const w = world();
    const runId = await begin(w);
    const place = { id: runId, path: `.metator/wt/${runId}`, branch: `metator/${runId}` };
    (await w.repo.update(runId, (r) => ok({ ...r, worktree: place })))._unsafeUnwrap();
    await w.fit.execute({ runId, verdict: verdict(SIZE) });
    const q = (await w.journal.questions(runId))._unsafeUnwrap()[0];
    await w.journal.answer(runId, q?.id as string, { choices: ["Continue as full"], by: "ana" });
    const moved = (await w.fit.execute({ runId, verdict: verdict(SIZE) }))._unsafeUnwrap() as { run: string };
    expect([w.started.at(-1)?.adopt, w.started.at(-1)?.allowDirty]).toEqual([place, undefined]);
    expect(w.adopted).toEqual([[runId, moved.run]]);
  });

  test("across repositories it cannot stay quick: the card offers only the full workflow", async () => {
    const w = world();
    const runId = await begin(w);
    await w.fit.execute({ runId, verdict: verdict(CROSS) });
    const q = (await w.journal.questions(runId))._unsafeUnwrap()[0];
    expect(q?.options.map((o) => o.label)).toEqual(["Continue as full", "Other"]);
    // And the full workflow is the one for a system of repositories.
    await w.journal.answer(runId, q?.id as string, { choices: ["Continue as full"], by: "ana" });
    const moved = (await w.fit.execute({ runId, verdict: verdict(CROSS) }))._unsafeUnwrap();
    expect([moved.state, w.started.at(-1)?.workflow]).toEqual(["full", "mt-system-change"]);
  });
});

describe("QuickReady: the card that ends a quick run", () => {
  const atReady = async (w: ReturnType<typeof world>) => {
    const runId = (await w.start.execute({ task: "Change it", check: verdict() }))._unsafeUnwrap().runId;
    for (const _ of ["build", "fit"])
      (await w.advance.execute({ runId, event: { type: "PASS" } }))._unsafeUnwrap();
    return runId;
  };

  test("asks once to look at the diff; Open diff is no answer; Fine ends the run", async () => {
    const w = world();
    const runId = await atReady(w);
    const first = (await w.ready.execute({ runId }))._unsafeUnwrap();
    const q = (await w.journal.questions(runId))._unsafeUnwrap()[0];
    expect(first).toEqual({ state: "waiting", question: q?.id as string });
    expect([q?.prompt, q?.stage, q?.options.map((o) => o.label)]).toEqual([
      "Quick change ready: look at the diff",
      "ready",
      ["Open diff", "Fine", "Other"],
    ]);
    await w.journal.answer(runId, q?.id as string, { choices: ["Open diff"], by: "ana" });
    const again = (await w.ready.execute({ runId }))._unsafeUnwrap();
    expect(again.state).toBe("waiting");
    const second = (await w.journal.questions(runId))._unsafeUnwrap().find((x) => !x.answer);
    await w.journal.answer(runId, second?.id as string, { choices: ["Fine"], by: "ana" });
    expect((await w.ready.execute({ runId }))._unsafeUnwrap()).toEqual({
      state: "fine",
      by: "ana",
      run: "done",
    });
    // Looked at again (the answer ended it a moment before, or a second look): still fine, nothing twice.
    expect((await w.ready.execute({ runId }))._unsafeUnwrap()).toEqual({
      state: "fine",
      by: "ana",
      run: "done",
    });
  });

  test("under a live drive the gate only passes: the drive ends the run itself", async () => {
    const w = world();
    const runId = await atReady(w);
    w.driven.live = true;
    const first = (await w.ready.execute({ runId }))._unsafeUnwrap() as { question: string };
    await w.journal.answer(runId, first.question, { choices: ["Fine"], by: "ana" });
    expect((await w.ready.execute({ runId }))._unsafeUnwrap()).toEqual({
      state: "fine",
      by: "ana",
      run: "active",
    });
  });
});
