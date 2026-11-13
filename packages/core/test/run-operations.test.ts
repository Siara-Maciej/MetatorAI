import { describe, expect, test } from "bun:test";
import { FakeBackgroundProcess, FixedClock, InMemoryFileSystem } from "@metator/testing";
import { AnswerPolicyStore } from "../src/application/answer-policies.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { CloseRun } from "../src/application/run-close.ts";
import { RunDrivers } from "../src/application/run-drivers.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import {
  AnswerQuestion,
  BriefRun,
  EndRun,
  EnsureDriven,
  ReviveRuns,
  StartDrive,
  StartRun,
} from "../src/application/run-operations.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { fleetCounts, fleetInbox } from "../src/domain/fleet.ts";
import { err, ok } from "../src/domain/result.ts";

const FEATURE = `
kind: Workflow
schemaVersion: 1
id: feature
stages:
  - id: plan
  - id: approval
    hitl: true
  - id: build
loops: {}
`;

function world(opts: { hostProblem?: (h: string) => string | undefined; liveSession?: boolean } = {}) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/feature.yml": FEATURE });
  const clock = new FixedClock(new Date("2026-11-13T09:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const init = new InitRun(catalog, repo, clock);
  const advance = new AdvanceRun(catalog, repo, clock);
  const journal = new RunJournal(fs, repo, clock);
  const processes = new FakeBackgroundProcess();
  const drivers = new RunDrivers(fs, repo, processes, journal, clock);
  const spawned: { runId: string; host: string; maxSteps?: number }[] = [];
  const hosts = new Map([
    ["claude", {}],
    ["copilot", {}],
  ]);
  const startDrive = new StartDrive(repo, hosts, opts.hostProblem, {
    start: async (input) => {
      spawned.push(input);
      return ok({ pid: 7000 + spawned.length });
    },
  });
  const ensureDriven = new EnsureDriven(repo, drivers, hosts, () => "claude", startDrive);
  const policies = new AnswerPolicyStore(fs);
  const answer = new AnswerQuestion(
    repo,
    journal,
    policies,
    drivers,
    ensureDriven,
    clock,
    () => opts.liveSession === true,
  );
  const newRun = async (task = "Add the combined discount to the basket") =>
    (await init.execute({ workflow: "feature", task }))._unsafeUnwrap().runId;
  const escalate = async (runId: string) =>
    (await advance.execute({ runId, event: { type: "FAIL", reason: "the gate is red" } }))._unsafeUnwrap();
  const ask = async (runId: string, options = ["Approve", "Reject", "Other"]) =>
    (
      await journal.ask(runId, {
        stage: "approval",
        source: "gate",
        prompt: "Approve the plan?",
        options: options.map((label) => ({ label })),
        multiSelect: false,
      })
    )._unsafeUnwrap();
  return {
    fs,
    clock,
    catalog,
    repo,
    init,
    advance,
    journal,
    processes,
    drivers,
    spawned,
    startDrive,
    ensureDriven,
    policies,
    answer,
    newRun,
    escalate,
    ask,
  };
}

describe("StartDrive and EnsureDriven", () => {
  test("a drive starts for an active run on the named host; a finished one has nothing to drive", async () => {
    const w = world();
    const runId = await w.newRun();
    const started = (await w.startDrive.execute({ runId, host: "copilot", maxSteps: 5 }))._unsafeUnwrap();
    expect([started.stage, w.spawned]).toEqual(["plan", [{ runId, host: "copilot", maxSteps: 5 }]]);
    await w.advance.execute({ runId, event: { type: "ABORT", reason: "no" } });
    const done = (await w.startDrive.execute({ runId, host: "claude" }))._unsafeUnwrapErr();
    expect([done.code, done.message]).toEqual([
      "TRANSITION_DENIED",
      `run ${runId} is aborted; there is nothing to drive`,
    ]);
    expect(w.spawned).toHaveLength(1);
  });

  test("an escalated run is never driven on: the refusal names the resume; a host that cannot start is refused", async () => {
    const w = world({ hostProblem: (h) => (h === "copilot" ? "`copilot` is not installed" : undefined) });
    const runId = await w.newRun();
    const missing = (await w.startDrive.execute({ runId, host: "copilot" }))._unsafeUnwrapErr();
    expect([missing.code, missing.message.includes("copilot")]).toEqual(["USAGE", true]);
    await w.escalate(runId);
    for (const refused of [
      (await w.startDrive.execute({ runId, host: "claude" }))._unsafeUnwrapErr(),
      (await w.ensureDriven.execute({ runId }))._unsafeUnwrapErr(),
    ]) {
      expect(refused.message).toStartWith(`run ${runId} escalated at plan`);
      expect(refused.hint).toContain(`metator run resume --run ${runId}`);
    }
    expect(w.spawned).toEqual([]);
  });

  test("ensure driven: nothing while a drive is alive; else the named host, the run's own, the default", async () => {
    const w = world();
    const runId = await w.newRun();
    expect((await w.ensureDriven.execute({ runId }))._unsafeUnwrap()).toEqual({
      stage: "plan",
      started: true,
      host: "claude",
    });
    (await w.drivers.claim(runId, 4321, "claude"))._unsafeUnwrap();
    w.processes.alive.add(4321);
    expect((await w.ensureDriven.execute({ runId }))._unsafeUnwrap()).toEqual({
      stage: "plan",
      started: false,
    });
    expect(w.spawned).toHaveLength(1);
    w.processes.alive.delete(4321);
    const record = (await w.repo.load(runId))._unsafeUnwrap();
    (await w.repo.save({ ...record, host: "copilot" }))._unsafeUnwrap();
    expect((await w.ensureDriven.execute({ runId }))._unsafeUnwrap().host).toBe("copilot");
    expect((await w.ensureDriven.execute({ runId, host: "claude" }))._unsafeUnwrap().host).toBe("claude");
    (await w.repo.save({ ...record, host: "gone" }))._unsafeUnwrap();
    expect((await w.ensureDriven.execute({ runId }))._unsafeUnwrap().host).toBe("claude");
    await w.advance.execute({ runId, event: { type: "ABORT", reason: "no" } });
    expect((await w.ensureDriven.execute({ runId }))._unsafeUnwrapErr().message).toBe(
      `run ${runId} is aborted; there is nothing to continue`,
    );
  });
});

describe("StartRun", () => {
  const start = (
    w: ReturnType<typeof world>,
    o: { worktree?: boolean; setupFails?: boolean; waiting?: number; wipLimit?: number } = {},
  ) => {
    const setups: string[] = [];
    const use = new StartRun(
      {
        execute: async (input: { workflow: string; task: string; worktree?: unknown }) => {
          // The real run without the worktree machinery; the worktree it would have is put on it.
          const r = await w.init.execute({ workflow: input.workflow, task: input.task });
          return o.worktree
            ? r.map((v) => ({
                ...v,
                worktree: { id: "wt1", path: ".metator/wt/wt1", branch: "metator/wt1" },
              }))
            : r;
        },
      } as never,
      {
        execute: async ({ run }: { run: string }) => {
          setups.push(run);
          return o.setupFails
            ? err(new MetatorError("COMMAND_FAILED", "bun install failed"))
            : ok({ worktree: "wt1", dependencies: "linked" });
        },
      } as never,
      { execute: async () => ok({ ready: true, place: ".", checks: [] }) } as never,
      {
        execute: async () =>
          ok({ runs: Array.from({ length: o.waiting ?? 0 }, () => ({ attention: "you" })) }),
      } as never,
      w.ensureDriven,
      o.wipLimit ?? 3,
    );
    return { use, setups };
  };
  const input = { workflow: "feature", task: "Add the combined discount to the basket" };

  test("a run with a worktree gets its dependencies on every front, unless declined; one without has none to set up", async () => {
    const w = world();
    const plain = start(w);
    const first = (await plain.use.execute(input))._unsafeUnwrap();
    expect([plain.setups, first.setup, first.warnings]).toEqual([[], undefined, []]);
    const tree = start(w, { worktree: true });
    const second = (await tree.use.execute({ ...input, worktree: {} }))._unsafeUnwrap();
    expect(tree.setups).toEqual([second.run.runId]);
    expect(second.setup).toEqual({ worktree: "wt1", dependencies: "linked" } as never);
    const declined = start(w, { worktree: true });
    await declined.use.execute({ ...input, worktree: {}, setup: false });
    expect(declined.setups).toEqual([]);
  });

  test("warnings: a setup that failed, a task that says too little, too many runs waiting for a person", async () => {
    const w = world();
    const failing = start(w, { worktree: true, setupFails: true, waiting: 3 });
    const r = (
      await failing.use.execute({ workflow: "feature", task: "fix it", worktree: {} })
    )._unsafeUnwrap();
    expect(r.setupError).toBe("bun install failed");
    expect(r.warnings[0]).toBe(
      "attention: 3 run(s) already wait for a person (limit 3): answer them first (metator inbox), or raise supervisor.wipLimit",
    );
    expect(r.warnings.some((x) => x.startsWith("task: 2 word(s)"))).toBe(true);
    expect(r.warnings).toContain("worktree setup: bun install failed");
    const calm = start(w, { waiting: 2 });
    expect((await calm.use.execute(input))._unsafeUnwrap().warnings).toEqual([]);
  });

  test("the drive starts only when asked, on the host named; a refusal is said and the run stands", async () => {
    const w = world();
    const { use } = start(w);
    const quiet = (await use.execute(input))._unsafeUnwrap();
    expect([quiet.drive, w.spawned]).toEqual([undefined, []]);
    const driven = (await use.execute({ ...input, drive: { host: "copilot" } }))._unsafeUnwrap();
    expect(driven.drive).toEqual({ stage: "plan", started: true, host: "copilot" });
    const bad = world({ hostProblem: () => "not installed" });
    const refused = (await start(bad).use.execute({ ...input, drive: {} }))._unsafeUnwrap();
    expect([refused.drive, refused.driveError?.message.includes("claude")]).toEqual([undefined, true]);
    expect((await bad.repo.load(refused.run.runId)).isOk()).toBe(true);
    expect((await use.execute({ workflow: "nope", task: "x y z w" })).isErr()).toBe(true);
  });
});

describe("AnswerQuestion", () => {
  test("the answer is recorded under the person's name; nothing is answered with nothing", async () => {
    const w = world();
    const runId = await w.newRun();
    const q = await w.ask(runId);
    const empty = (
      await w.answer.execute({ runId, question: q.id, choices: [], by: "ola" })
    )._unsafeUnwrapErr();
    expect([empty.code, empty.message]).toEqual(["USAGE", "an answer needs a choice or your own words"]);
    const a = (
      await w.answer.execute({ runId, question: q.id, choices: ["Approve"], by: "ola", origin: "inbox" })
    )._unsafeUnwrap();
    expect([a.answer?.choices, a.answer?.by, a.policy, a.drive]).toEqual([
      ["Approve"],
      "ola",
      undefined,
      undefined,
    ]);
    expect((await w.policies.list())._unsafeUnwrap()).toEqual([]);
    // The latest run when none is named.
    const q2 = await w.ask(runId, ["Yes", "No"]);
    expect((await w.answer.execute({ question: q2.id, choices: [], text: "later", by: "ola" })).isOk()).toBe(
      true,
    );
  });

  test("always: the answer becomes a policy with the question's own labels; never for Other, never for an unknown question", async () => {
    const w = world();
    const runId = await w.newRun();
    const q = await w.ask(runId);
    const other = (
      await w.answer.execute({
        runId,
        question: q.id,
        choices: ["Other"],
        text: "x",
        by: "ola",
        always: true,
      })
    )._unsafeUnwrapErr();
    expect([other.code, other.message.startsWith("no policy: "), other.hint]).toEqual([
      "USAGE",
      true,
      "Answer without --always.",
    ]);
    expect((await w.journal.questions(runId))._unsafeUnwrap()[0]?.answer).toBeUndefined();
    const unknown = (
      await w.answer.execute({ runId, question: "q999", choices: ["Approve"], by: "ola", always: true })
    )._unsafeUnwrapErr();
    expect([unknown.code, unknown.message]).toEqual(["NOT_FOUND", `question q999 of run ${runId} not found`]);
    const a = (
      await w.answer.execute({ runId, question: q.id, choices: ["approve"], by: "ola", always: true })
    )._unsafeUnwrap();
    expect([a.answer?.choices, a.policy?.by]).toEqual([["Approve"], "ola"]);
    const kept = (await w.policies.list())._unsafeUnwrap();
    expect(kept.map((p) => p.id)).toEqual([a.policy?.id as string]);
    expect(JSON.stringify(kept[0])).toContain("Approve");
  });

  test("carried out: an active run nothing drives gets its drive; not with a live drive or a live session; never an escalated run", async () => {
    const w = world();
    const runId = await w.newRun();
    const q = await w.ask(runId);
    const a = (
      await w.answer.execute({ runId, question: q.id, choices: ["Approve"], by: "ola", drive: true })
    )._unsafeUnwrap();
    expect([a.drive, w.spawned.map((s) => s.runId)]).toEqual([{ started: true }, [runId]]);

    const driven = await w.newRun("Another task with enough words");
    (await w.drivers.claim(driven, 5555, "claude"))._unsafeUnwrap();
    w.processes.alive.add(5555);
    const q2 = await w.ask(driven);
    const b = (
      await w.answer.execute({ runId: driven, question: q2.id, choices: ["Approve"], by: "ola", drive: true })
    )._unsafeUnwrap();
    expect([b.drive, w.spawned]).toHaveLength(2);
    expect(b.drive).toBeUndefined();
    expect(w.spawned).toHaveLength(1);

    const session = world({ liveSession: true });
    const inPane = await session.newRun();
    const q3 = await session.ask(inPane);
    const c = (
      await session.answer.execute({
        runId: inPane,
        question: q3.id,
        choices: ["Approve"],
        by: "ola",
        drive: true,
      })
    )._unsafeUnwrap();
    expect([c.drive, session.spawned]).toEqual([undefined, []]);

    // Decided: an answer never resumes an escalated run; that is a named person's own resume.
    const stuck = await w.newRun("A third task with enough words");
    const q4 = await w.ask(stuck);
    await w.escalate(stuck);
    const d = (
      await w.answer.execute({ runId: stuck, question: q4.id, choices: ["Approve"], by: "ola", drive: true })
    )._unsafeUnwrapErr();
    expect([d.code, d.hint?.includes(`metator run resume --run ${stuck}`)]).toEqual(["USAGE", true]);
    expect((await w.repo.load(stuck))._unsafeUnwrap().state.status).toBe("escalated");
    expect(w.spawned).toHaveLength(1);
  });
});

describe("BriefRun", () => {
  test("a since that is not a time is a usage error; the brief marks the run as read unless it peeks", async () => {
    const w = world();
    const runId = await w.newRun();
    const brief = new BriefRun(w.repo, w.journal);
    const bad = (await brief.execute({ runId, since: "yesterday-ish" }))._unsafeUnwrapErr();
    expect([bad.code, bad.message]).toEqual(["USAGE", "since yesterday-ish: expected an ISO time"]);
    (await w.journal.record(runId, { type: "drive", text: "started" }))._unsafeUnwrap();
    const peeked = (await brief.execute({ runId, peek: true }))._unsafeUnwrap();
    expect([peeked.runId, peeked.status, peeked.stage]).toEqual([runId, "active", "plan"]);
    expect((await w.journal.seen(runId))._unsafeUnwrap()).toBeUndefined();
    (await brief.execute({}))._unsafeUnwrap();
    expect((await w.journal.seen(runId))._unsafeUnwrap()).toBe("2026-11-13T09:00:00.000Z");
    // From a time that is named: only what came after it.
    const later = (await brief.execute({ runId, since: "2030-01-01T00:00:00Z", peek: true }))._unsafeUnwrap();
    const all = (await brief.execute({ runId, since: "2020-01-01T00:00:00Z", peek: true }))._unsafeUnwrap();
    expect(JSON.stringify(later)).not.toEqual(JSON.stringify(all));
  });
});

describe("ReviveRuns", () => {
  test("a drive that died is started again and the journal says so; a live one, a run nobody drove and a finished run are left", async () => {
    const w = world();
    const revive = new ReviveRuns(w.repo, w.drivers, w.journal, w.ensureDriven);
    const died = await w.newRun("First task with enough words");
    const alive = await w.newRun("Second task with enough words");
    const nobody = await w.newRun("Third task with enough words");
    const over = await w.newRun("Fourth task with enough words");
    (await w.drivers.claim(died, 4001, "copilot"))._unsafeUnwrap();
    (await w.drivers.claim(alive, 4002, "claude"))._unsafeUnwrap();
    (await w.drivers.claim(over, 4003, "claude"))._unsafeUnwrap();
    w.processes.alive.add(4002);
    await w.advance.execute({ runId: over, event: { type: "ABORT", reason: "no" } });
    const r = (await revive.execute({}))._unsafeUnwrap();
    expect(r).toEqual({ revived: [{ runId: died, stage: "plan", died: 4001 }], unreadable: [] });
    expect([w.spawned.map((s) => s.runId), nobody.length > 0]).toEqual([[died], true]);
    const said = (await w.journal.activity(died))._unsafeUnwrap().map((a) => a.text);
    expect(said).toContain("revived: its drive (process 4001) had died");
  });

  test("a broken record is skipped and named among all runs; the run a person names is their answer", async () => {
    const w = world();
    const revive = new ReviveRuns(w.repo, w.drivers, w.journal, w.ensureDriven);
    const runId = await w.newRun();
    await w.fs.write(w.repo.stateFile(runId), "{ not json");
    const r = (await revive.execute({}))._unsafeUnwrap();
    expect([r.revived, r.unreadable.map((u) => [u.runId, u.file])]).toEqual([
      [],
      [[runId, w.repo.stateFile(runId)]],
    ]);
    expect((await revive.execute({ runId })).isErr()).toBe(true);
  });
});

describe("EndRun", () => {
  const end = (w: ReturnType<typeof world>, o: { removalFails?: boolean } = {}) => {
    const calls: string[] = [];
    const use = new EndRun(
      new CloseRun(w.advance, w.repo, w.fs, w.clock, w.drivers, w.catalog),
      w.repo,
      {
        closeRun: async (runId) => {
          calls.push(`panes ${runId}`);
          return ok({ closed: 2 });
        },
      },
      {
        execute: async ({ id, force }: { id: string; force: boolean }) => {
          calls.push(`remove ${id} force=${force}`);
          return o.removalFails
            ? err(MetatorError.usage("the worktree has uncommitted changes"))
            : ok({ id, path: `.metator/wt/${id}` });
        },
      } as never,
    );
    return { use, calls };
  };
  const withWorktree = async (w: ReturnType<typeof world>, runId: string) => {
    const record = (await w.repo.load(runId))._unsafeUnwrap();
    (
      await w.repo.save({
        ...record,
        worktree: { id: "wt1", path: ".metator/wt/wt1", branch: "metator/wt1" },
      } as never)
    )._unsafeUnwrap();
  };

  test("an aborted run: its summary, its panes closed, its worktree only when asked", async () => {
    const w = world();
    const runId = await w.newRun();
    await withWorktree(w, runId);
    const kept = end(w);
    const r = (await kept.use.execute({ runId, abortReason: "not needed" }))._unsafeUnwrap();
    expect([r.runId, r.panes, r.worktree, kept.calls]).toEqual([
      runId,
      { closed: 2 },
      undefined,
      [`panes ${runId}`],
    ]);
    const other = await w.newRun("Another task with enough words");
    await withWorktree(w, other);
    const removed = end(w);
    const gone = (
      await removed.use.execute({ runId: other, abortReason: "no", removeWorktree: true, force: true })
    )._unsafeUnwrap();
    expect([gone.worktree, removed.calls]).toEqual([
      { id: "wt1", path: ".metator/wt/wt1", removed: true },
      [`panes ${other}`, "remove wt1 force=true"],
    ]);
  });

  test("a run without a worktree has none to remove; a worktree that cannot go is the command's error; an active run needs its reason", async () => {
    const w = world();
    const plain = await w.newRun();
    const a = end(w);
    const r = (
      await a.use.execute({ runId: plain, abortReason: "no", removeWorktree: true })
    )._unsafeUnwrap();
    expect([r.worktree, a.calls]).toEqual([undefined, [`panes ${plain}`]]);
    const dirty = await w.newRun("Another task with enough words");
    await withWorktree(w, dirty);
    const b = end(w, { removalFails: true });
    expect(
      (await b.use.execute({ runId: dirty, abortReason: "no", removeWorktree: true }))._unsafeUnwrapErr()
        .message,
    ).toBe("the worktree has uncommitted changes");
    const active = await w.newRun("A third task with enough words");
    const c = end(w);
    expect((await c.use.execute({ runId: active })).isErr()).toBe(true);
    expect(c.calls).toEqual([]);
  });
});

describe("several repositories as one (fleet)", () => {
  const question = (id: string, askedAt: string) =>
    ({
      id,
      runId: "r",
      stage: "approval",
      source: "gate",
      prompt: "Approve?",
      options: [{ label: "Approve" }],
      multiSelect: false,
      askedAt,
    }) as never;
  const run = (runId: string, over: Record<string, unknown>) =>
    ({
      runId,
      task: `Task ${runId}`,
      driving: false,
      status: "active",
      stage: "approval",
      updatedAt: "2026-11-13T08:00:00.000Z",
      questions: [],
      ...over,
    }) as never;
  const now = new Date("2026-11-13T09:00:00.000Z");

  test("one queue: what a live drive waits on first, then the longest wait; each item names its repository in a folder", () => {
    const repos = [
      { name: "orders", now, runs: [run("o1", { questions: [question("q1", "2026-11-13T08:30:00.000Z")] })] },
      {
        name: "billing",
        now,
        runs: [
          run("b1", { questions: [question("q2", "2026-11-13T07:00:00.000Z")] }),
          run("b2", { driving: true, questions: [question("q3", "2026-11-13T08:59:00.000Z")] }),
          run("b3", { status: "escalated", stage: "check", reason: "gate red" }),
        ],
      },
    ];
    const folder = fleetInbox(repos, true);
    expect(folder.decisions.map((d) => [d.repo, d.runId])).toEqual([
      ["billing", "b2"],
      ["billing", "b1"],
      ["orders", "o1"],
    ]);
    expect(folder.escalated.map((e) => [e.repo, e.runId, e.reason])).toEqual([["billing", "b3", "gate red"]]);
    const single = fleetInbox([repos[0] as (typeof repos)[number]], false);
    expect("repo" in (single.decisions[0] as object)).toBe(false);
    expect(fleetInbox([], true)).toEqual({ decisions: [], escalated: [] });
  });

  test("the folder's counts add up; a repository that could not be read adds nothing", () => {
    expect(
      fleetCounts([
        { counts: { you: 1, driving: 2, stopped: 0, questions: 3, services: 1 } },
        {},
        { counts: { you: 2, driving: 0, stopped: 4, questions: 1, services: 0 } },
      ]),
    ).toEqual({ you: 3, driving: 2, stopped: 4, questions: 4, services: 1 });
  });
});
