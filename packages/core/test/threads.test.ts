import { describe, expect, test } from "bun:test";
import {
  continueLine,
  DEFAULT_PATHS,
  InitRun,
  InProcessLock,
  LayoutStore,
  Panes,
  PtyBroker,
  RunJournal,
  RunRepository,
  THREADS_DIR,
  ThreadStore,
  Threads,
  threadTreeOf,
  WorkflowCatalog,
} from "@metator/core";
import {
  FakeInteractiveHost,
  FakeScreenRenderer,
  FakeTerminal,
  FixedClock,
  InMemoryFileSystem,
  InstantTimer,
} from "@metator/testing";
import { ok } from "../src/domain/result.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world(chatAgent: string | null = "mt-chat") {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-22T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const broker = new PtyBroker({
    screens: new FakeScreenRenderer(),
    repo,
    journal,
    idleMs: 1000,
    after: () => () => {},
  });
  const claude = new FakeInteractiveHost("claude");
  const layout = new LayoutStore(fs);
  let n = 0;
  const make = () =>
    new Panes({
      layout,
      broker,
      hosts: new Map([["claude", claude]]),
      terminal: new FakeTerminal(),
      repo,
      journal,
      clock,
      timer: new InstantTimer(),
      root: "/repo",
      token: () => `tok-${++n}`,
      fs,
    });
  const panes = make();
  const mail: { paneId: string; line: string }[] = [];
  const threadsOf = (p: Panes) =>
    new Threads({
      store: new ThreadStore(fs, new InProcessLock()),
      panes: p,
      runs: repo,
      journal,
      mail: {
        post: async (l) => {
          mail.push({ paneId: l.paneId, line: l.line });
          return ok({ ...l, id: `m${mail.length}`, at: clock.now().toISOString() });
        },
      },
      chatAgent: async () => chatAgent ?? undefined,
      clock,
    });
  const threads = threadsOf(panes);
  const init = (task: string) =>
    new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock).execute({ workflow: "demo", task });
  return { fs, clock, repo, journal, broker, claude, layout, panes, make, threads, threadsOf, mail, init };
}

describe("Threads: one per topic, with its chat terminal", () => {
  test("a new thread is a document and a chat pane of the conversation agent that names it", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Price rounding", by: "ann" }))._unsafeUnwrap();
    expect(made.thread).toMatchObject({
      id: "20261122-price-rounding",
      title: "Price rounding",
      state: "open",
      summary: "",
      runs: [],
      panes: [{ paneId: made.pane?.id, at: "2026-11-22T10:00:00.000Z" }],
      facts: [{ at: "2026-11-22T10:00:00.000Z", text: "opened by ann" }],
    });
    expect(made.pane).toMatchObject({ role: "apps", label: "chat", threadId: "20261122-price-rounding" });
    expect(w.claude.started[0]?.task.agent).toBe("mt-chat");
    expect(await w.fs.exists(`${THREADS_DIR}/20261122-price-rounding.json`)).toBe(true);
    // The same title the same day is another thread.
    const again = (await w.threads.create({ title: "Price rounding", by: "ann" }))._unsafeUnwrap();
    expect(again.thread.id).toBe("20261122-price-rounding-2");
    // "+ New chat" before the topic is known; a repository without mt-chat opens the orchestrator.
    const plain = world(null);
    const untitled = (await plain.threads.create({ by: "ann" }))._unsafeUnwrap();
    expect(untitled.thread).toMatchObject({ id: "20261122-new-chat", title: "New chat" });
    expect(plain.claude.started[0]?.task.agent).toBe("mt-orchestrator");
  });

  test("nothing is written when the chat cannot start, nor without who opens it or with a long title", async () => {
    const w = world();
    const refused = await w.threads.create({ title: "x", by: "ann", host: "nope" });
    expect(refused._unsafeUnwrapErr().code).toBe("USAGE");
    expect(await w.fs.glob([`${THREADS_DIR}/*.json`])).toEqual([]);
    expect((await w.threads.create({ title: "x", by: " " }))._unsafeUnwrapErr().message).toContain(
      "say who opens it",
    );
    expect(
      (await w.threads.create({ title: "x".repeat(81), by: "ann" }))._unsafeUnwrapErr().message,
    ).toContain("at most 80");
  });

  test("a topic change: the new thread comes from the caller's, and the carried line is its chat's first message", async () => {
    const w = world();
    const old = (await w.threads.create({ title: "Prices", by: "ann" }))._unsafeUnwrap();
    const made = (
      await w.threads.create({
        title: "Invoice PDF",
        by: "mt-chat",
        carry: "The person wants\nthe PDF in A4.",
        caller: { id: old.pane?.id as string, threadId: old.thread.id },
      })
    )._unsafeUnwrap();
    expect(made.thread.from).toEqual({ thread: "20261122-prices" });
    expect(made.thread.facts[0]?.text).toBe("opened by mt-chat from thread 20261122-prices");
    expect(w.mail).toEqual([
      {
        paneId: made.pane?.id as string,
        line: '[metator] Carried over from thread "Prices": The person wants the PDF in A4.',
      },
    ]);
    // The old topic stays open.
    expect((await w.threads.show(old.thread.id))._unsafeUnwrap().state).toBe("open");
  });

  test("the agent's summary is kept (at most 1500 characters) and may name the topic", async () => {
    const w = world();
    const t = (await w.threads.create({ by: "ann" }))._unsafeUnwrap().thread;
    const s = (
      await w.threads.summary({ id: t.id, text: "Decided: round half up.\n", title: "Price rounding" })
    )._unsafeUnwrap();
    expect(s).toMatchObject({
      id: "20261122-new-chat",
      title: "Price rounding",
      summary: "Decided: round half up.",
    });
    expect((await w.threads.summary({ id: t.id, text: "x".repeat(1501) }))._unsafeUnwrapErr().message).toBe(
      "the summary is 1501 characters: at most 1500",
    );
    expect((await w.threads.summary({ id: "20261122-nothing", text: "x" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
    expect((await w.threads.show("../../etc"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("the thread of a pane is the one it is the chat of; another pane has none", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Prices", by: "ann" }))._unsafeUnwrap();
    expect((await w.threads.ofPane(made.pane?.id as string))._unsafeUnwrap().id).toBe(made.thread.id);
    const ws = (await w.panes.openWorkspace({ label: "other" }))._unsafeUnwrap();
    const shell = (
      await w.panes.openPane({ workspace: ws.id, role: "shell", process: { kind: "command", argv: ["sh"] } })
    )._unsafeUnwrap();
    expect((await w.threads.ofPane(shell.id))._unsafeUnwrapErr().message).toBe(
      `pane ${shell.id} is the chat of no thread`,
    );
  });

  test("a run the chat starts is the thread's, with a fact; a child run is not; finishing adds one fact, once", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Prices", by: "ann" }))._unsafeUnwrap();
    const paneId = made.pane?.id as string;
    const run = (await w.init("Round prices half up\nmore words"))._unsafeUnwrap();
    const linked = (await w.threads.linkRun(paneId, run.runId))._unsafeUnwrap();
    expect(linked?.runs).toEqual([run.runId]);
    expect(linked?.facts.at(-1)?.text).toBe(`run ${run.runId} started: Round prices half up`);
    // Linked once.
    expect((await w.threads.linkRun(paneId, run.runId))._unsafeUnwrap()?.runs).toEqual([run.runId]);
    const child = (await w.init("A step"))._unsafeUnwrap();
    await w.repo.update(child.runId, (r) => ok({ ...r, parent: run.runId }));
    expect((await w.threads.linkRun(paneId, child.runId))._unsafeUnwrap()).toBeUndefined();
    // Nothing to note while it runs.
    expect((await w.threads.noteRuns())._unsafeUnwrap()).toEqual([]);
    await w.repo.update(run.runId, (r) => ok({ ...r, state: { ...r.state, status: "done", stage: "done" } }));
    expect((await w.threads.noteRuns())._unsafeUnwrap()).toEqual([
      { thread: made.thread.id, runId: run.runId, event: "done" },
    ]);
    // Once: not again in this daemon, nor in the next one (the run's activity says it was noted).
    expect((await w.threads.noteRuns())._unsafeUnwrap()).toEqual([]);
    expect((await w.threadsOf(w.make()).noteRuns())._unsafeUnwrap()).toEqual([]);
    const t = (await w.threads.show(made.thread.id))._unsafeUnwrap();
    expect(t.facts.map((f) => f.text).slice(-1)).toEqual([`run ${run.runId} done: Round prices half up`]);
  });

  test("Backlog work in a thread (ADR-0096): a run and an item added by id, once; a planned run is a fact; a run finds its thread", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Prices", by: "ann", pane: false }))._unsafeUnwrap();
    const run = (await w.init("Round prices"))._unsafeUnwrap();
    const added = (await w.threads.addRun(made.thread.id, run.runId, "Round prices\nmore"))._unsafeUnwrap();
    expect([added.runs, added.facts.at(-1)?.text]).toEqual([
      [run.runId],
      `run ${run.runId} started: Round prices`,
    ]);
    expect((await w.threads.addRun(made.thread.id, run.runId, "x"))._unsafeUnwrap().runs).toEqual([
      run.runId,
    ]);
    const item = (await w.threads.addIssue(made.thread.id, "i004", "Round prices"))._unsafeUnwrap();
    expect([item.issues, item.facts.at(-1)?.text]).toEqual([
      ["i004"],
      "Backlog item i004 made: Round prices",
    ]);
    expect((await w.threads.addIssue(made.thread.id, "i004", "x"))._unsafeUnwrap().issues).toEqual(["i004"]);
    expect((await w.threads.ofRun(run.runId))?.id).toBe(made.thread.id);
    expect(await w.threads.ofRun("20261122-other")).toBeUndefined();
    await w.repo.update(run.runId, (r) =>
      ok({ ...r, state: { ...r.state, status: "planned", stage: "planned" } }),
    );
    expect((await w.threads.noteRuns())._unsafeUnwrap()).toEqual([
      { thread: made.thread.id, runId: run.runId, event: "planned" },
    ]);
    expect((await w.threads.show(made.thread.id))._unsafeUnwrap().facts.at(-1)?.text).toBe(
      `run ${run.runId} planned (plan ready): Round prices`,
    );
  });

  test("an escalated run says where it stopped; a pane of no thread links nothing", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Prices", by: "ann" }))._unsafeUnwrap();
    const run = (await w.init("Round prices"))._unsafeUnwrap();
    await w.threads.linkRun(made.pane?.id as string, run.runId);
    await w.repo.update(run.runId, (r) =>
      ok({
        ...r,
        state: {
          ...r.state,
          status: "escalated",
          stage: "escalated",
          context: {
            ...r.state.context,
            history: [{ stage: "build", event: "FAIL" }] as never,
          },
        },
      }),
    );
    await w.threads.noteRuns();
    expect((await w.threads.show(made.thread.id))._unsafeUnwrap().facts.at(-1)?.text).toBe(
      `run ${run.runId} stopped at build and needs the person: Round prices`,
    );
    const ws = (await w.panes.openWorkspace({ label: "other" }))._unsafeUnwrap();
    const shell = (
      await w.panes.openPane({ workspace: ws.id, role: "shell", process: { kind: "command", argv: ["sh"] } })
    )._unsafeUnwrap();
    expect((await w.threads.linkRun(shell.id, run.runId))._unsafeUnwrap()).toBeUndefined();
  });

  test("closing ends the chat (its session kept), never a run; a closed thread is listed apart", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Prices", by: "ann" }))._unsafeUnwrap();
    const paneId = made.pane?.id as string;
    const run = (await w.init("Round prices"))._unsafeUnwrap();
    await w.threads.linkRun(paneId, run.runId);
    const closed = (await w.threads.close({ id: made.thread.id, by: "ann" }))._unsafeUnwrap();
    expect(closed.ended).toBe(paneId);
    expect(closed.thread).toMatchObject({ state: "closed", closedAt: "2026-11-22T10:00:00.000Z" });
    expect(closed.thread.panes.at(-1)?.hostSession).toBe("claude-1");
    expect(closed.thread.facts.at(-1)?.text).toBe("closed by ann");
    expect((await w.panes.pane(paneId))._unsafeUnwrap().ended?.reason).toBe("closed-by-host");
    expect((await w.repo.load(run.runId))._unsafeUnwrap().state.status).toBe("active");
    // Closing again changes nothing.
    expect((await w.threads.close({ id: made.thread.id, by: "bob" }))._unsafeUnwrap().thread).toEqual(
      closed.thread,
    );
    const tree = (await threadTreeOf([{ threads: w.threads, runs: [] }]))._unsafeUnwrap();
    expect(tree.closed.map((t) => [t.id, t.chat?.status])).toEqual([[made.thread.id, "ended"]]);
    // The state says how many threads there are and when one last changed: a client reads the tree again.
    expect(await w.threads.mark()).toEqual({ open: 0, closed: 1, updatedAt: "2026-11-22T10:00:00.000Z" });
    expect(await world().threads.mark()).toEqual({ open: 0, closed: 0 });
  });

  test("reopening a closed thread continues its kept host session in a new chat pane", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Prices", by: "ann" }))._unsafeUnwrap();
    await w.threads.close({ id: made.thread.id, by: "ann" });
    const back = (await w.threads.reopen({ id: made.thread.id, by: "bob" }))._unsafeUnwrap();
    expect(back.how).toBe("resumed");
    expect(w.claude.started.at(-1)?.resumed).toBe("claude-1");
    expect(back.pane.threadId).toBe(made.thread.id);
    expect(back.thread.state).toBe("open");
    expect(back.thread.closedAt).toBeUndefined();
    expect(back.thread.panes.map((p) => p.paneId)).toEqual([made.pane?.id as string, back.pane.id]);
    expect(back.thread.facts.slice(-2).map((f) => f.text)).toEqual([
      "reopened by bob",
      `chat continued in pane ${back.pane.id} (session resumed)`,
    ]);
    expect(w.mail).toEqual([]);
    // A live chat is left as it is.
    const again = (await w.threads.reopen({ id: made.thread.id, by: "bob" }))._unsafeUnwrap();
    expect(again).toMatchObject({ how: "live", pane: { id: back.pane.id } });
  });

  test("after a daemon restart a paused chat is resumed in its pane; with no session kept, a new one is told what it continues", async () => {
    const w = world();
    const made = (await w.threads.create({ title: "Prices", by: "ann" }))._unsafeUnwrap();
    const paneId = made.pane?.id as string;
    await w.panes.pauseAll();
    // The daemon restarts: nothing is live, the pane is paused.
    const restarted = world();
    const fresh = new Panes({
      layout: w.layout,
      broker: new PtyBroker({
        screens: new FakeScreenRenderer(),
        repo: w.repo,
        journal: w.journal,
        idleMs: 1000,
        after: () => () => {},
      }),
      hosts: new Map([["claude", restarted.claude]]),
      terminal: new FakeTerminal(),
      repo: w.repo,
      journal: w.journal,
      clock: w.clock,
      timer: new InstantTimer(),
      root: "/repo",
      fs: w.fs,
    });
    const threads = w.threadsOf(fresh);
    expect((await threads.chatOf(made.thread))?.status).toBe("paused");
    const back = (await threads.reopen({ id: made.thread.id, by: "ann" }))._unsafeUnwrap();
    expect(back).toMatchObject({ how: "resumed", pane: { id: paneId } });
    expect(restarted.claude.started[0]?.resumed).toBe("claude-1");

    // A thread whose chat pane is gone and kept no session: a new session, told first.
    const other = (await w.threads.create({ title: "Taxes", by: "ann", pane: false }))._unsafeUnwrap();
    expect(other.pane).toBeUndefined();
    expect(other.thread.panes).toEqual([]);
    const opened = (await threads.reopen({ id: other.thread.id, by: "ann" }))._unsafeUnwrap();
    expect(opened.how).toBe("new-session");
    expect(w.mail).toEqual([{ paneId: opened.pane.id, line: continueLine("Taxes") }]);
    expect(opened.thread.facts.at(-1)?.text).toBe(`chat continued in pane ${opened.pane.id} (new session)`);
  });
});
