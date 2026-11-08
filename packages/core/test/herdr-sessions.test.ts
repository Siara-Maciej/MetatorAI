import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  HerdrSessions,
  HOST_PROMPT,
  InitRun,
  MetatorError,
  ok,
  RunJournal,
  RunRepository,
  shellLine,
  WorkflowCatalog,
} from "@metator/core";
import {
  FakeHerdr,
  FakeInteractiveHost,
  FixedClock,
  InMemoryFileSystem,
  InMemoryMachineState,
} from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world(herdr = new FakeHerdr()) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-08T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const claude = new FakeInteractiveHost("claude");
  const copilot = new FakeInteractiveHost("copilot");
  const overview: { runs: unknown[] } = { runs: [] };
  const machine = new InMemoryMachineState();
  const deps = {
    repo,
    journal,
    hosts: new Map([
      ["copilot", copilot],
      ["claude", claude],
    ]),
    control: herdr,
    fs,
    clock,
    root: "/repo",
    overview: { execute: async () => ok(overview as never) },
    machine,
    session: "work",
  };
  const sessions = new HerdrSessions(deps);
  const init = (task: string) =>
    new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock).execute({ workflow: "demo", task });
  const run = (runId: string, extra: Record<string, unknown> = {}) => ({
    runId,
    status: "active",
    stage: "build",
    attention: "driving",
    questions: [],
    ...extra,
  });
  return { fs, repo, journal, herdr, sessions, init, overview, run, deps };
}

describe("HerdrSessions.open", () => {
  test("a workspace per run, the host started in it with the run's variables, the binding and the session kept", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const opened = (await w.sessions.open({ runId: r.runId }))._unsafeUnwrap();
    expect(opened).toEqual({
      runId: r.runId,
      workspace: "w1",
      pane: "w1:p1",
      host: "copilot",
      sessionId: "copilot-1",
      openedAt: "2026-11-08T10:00:00.000Z",
      reused: false,
      resumed: false,
    });
    expect(w.herdr.calls).toEqual([
      {
        method: "open",
        args: [{ cwd: "/repo", label: r.runId, env: { METATOR_RUN_DIR: `/repo/.metator/runs/${r.runId}` } }],
      },
      { method: "run", args: ["w1:p1", shellLine(["copilot", "Add discount"])] },
    ]);
    expect((await w.sessions.binding(r.runId))._unsafeUnwrap()?.pane).toBe("w1:p1");
    const record = (await w.repo.load(r.runId))._unsafeUnwrap();
    expect([record.host, record.hostSession]).toEqual(["copilot", "copilot-1"]);
    const activity = (await w.journal.activity(r.runId))._unsafeUnwrap();
    expect(activity.at(-1)).toMatchObject({
      type: "agent",
      origin: "run",
      agent: "copilot",
      text: "started session copilot-1 in herdr pane w1:p1 (workspace w1)",
    });
  });

  test("a live pane is reused; a gone one is replaced and the host resumes its session", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.sessions.open({ runId: r.runId, host: "claude" });
    const again = (await w.sessions.open({ runId: r.runId }))._unsafeUnwrap();
    expect([again.reused, w.herdr.calls.filter((c) => c.method === "open").length]).toEqual([true, 1]);
    w.herdr.panes.clear();
    const resumed = (await w.sessions.open({ runId: r.runId }))._unsafeUnwrap();
    expect([resumed.reused, resumed.resumed, resumed.host, resumed.pane]).toEqual([
      false,
      true,
      "claude",
      "w2:p1",
    ]);
    expect(w.herdr.calls.at(-1)).toEqual({
      method: "run",
      args: ["w2:p1", shellLine(["claude", "--resume", "claude-1"])],
    });
  });

  test("an unknown host, a finished run and a herdr error are errors, nothing half-written", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const unknown = await w.sessions.open({ runId: r.runId, host: "nope" });
    expect(unknown._unsafeUnwrapErr().message).toBe("unknown interactive host nope");
    const failing = world(
      new FakeHerdr({ method: "run", error: new MetatorError("COMMAND_FAILED", "herdr down") }),
    );
    const r2 = (await failing.init("x"))._unsafeUnwrap();
    expect((await failing.sessions.open({ runId: r2.runId }))._unsafeUnwrapErr().message).toBe("herdr down");
    expect((await failing.sessions.binding(r2.runId))._unsafeUnwrap()).toBeNull();
    const record = (await w.repo.load(r.runId))._unsafeUnwrap();
    await w.repo.save({ ...record, state: { ...record.state, status: "done" } });
    expect((await w.sessions.open({ runId: r.runId }))._unsafeUnwrapErr().message).toContain("is done");
  });
});

describe("HerdrSessions.sync and close", () => {
  test("the run's stage goes to herdr's sidebar; a host blocked at its own prompt is noted once", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.sessions.open({ runId: r.runId });
    w.overview.runs = [w.run(r.runId), w.run("20261108-demo-unbound")];
    w.herdr.panes.set("w1:p1", { agentStatus: "blocked" });
    const first = (await w.sessions.sync())._unsafeUnwrap();
    expect(first).toEqual([
      { runId: r.runId, pane: "w1:p1", alive: true, agentStatus: "blocked", title: "build · working" },
    ]);
    expect(w.herdr.calls.find((c) => c.method === "report")?.args).toEqual([
      "w1:p1",
      { title: "build · working", tokens: { run: r.runId, stage: "build", waiting: "0" } },
    ]);
    await w.sessions.sync();
    const notes = (await w.journal.activity(r.runId))
      ._unsafeUnwrap()
      .filter((a) => a.text === HOST_PROMPT("w1:p1"));
    expect(notes.map((n) => [n.type, n.origin])).toEqual([["idle", "pty"]]);
  });

  test("a MetatorAI question is not a host prompt; a gone pane is reported, not an error", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.sessions.open({ runId: r.runId });
    w.overview.runs = [w.run(r.runId, { attention: "you", questions: [{ id: "q001" }] })];
    w.herdr.panes.set("w1:p1", { agentStatus: "blocked" });
    const s = (await w.sessions.sync())._unsafeUnwrap();
    expect(s[0]?.title).toBe("build · waits for you (1)");
    expect((await w.journal.activity(r.runId))._unsafeUnwrap().some((a) => a.type === "idle")).toBe(false);
    w.herdr.panes.clear();
    expect((await w.sessions.sync())._unsafeUnwrap()).toEqual([
      { runId: r.runId, pane: "w1:p1", alive: false },
    ]);
  });

  test("close ends the workspace and forgets the binding; closing again is a no-op", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.sessions.open({ runId: r.runId });
    expect((await w.sessions.close({ runId: r.runId }))._unsafeUnwrap()).toEqual({
      runId: r.runId,
      closed: true,
    });
    expect(w.herdr.calls.at(-1)).toEqual({ method: "close", args: ["w1"] });
    expect((await w.sessions.binding(r.runId))._unsafeUnwrap()).toBeNull();
    expect((await w.sessions.close({ runId: r.runId }))._unsafeUnwrap()).toEqual({
      runId: r.runId,
      closed: false,
    });
  });
});

describe("HerdrSessions.locate", () => {
  test("herdr's workspace id leads to the repository and run, in this herdr session only, until closed", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    expect((await w.sessions.locate("w1"))._unsafeUnwrap()).toBeNull();
    await w.sessions.open({ runId: r.runId });
    expect((await w.sessions.locate("w1"))._unsafeUnwrap()).toEqual({
      session: "work",
      workspace: "w1",
      root: "/repo",
      runId: r.runId,
    });
    expect((await w.sessions.locate("w2"))._unsafeUnwrap()).toBeNull();
    // The same workspace id in another herdr session is another workspace.
    const other = new HerdrSessions({ ...w.deps, session: "default" });
    expect((await other.locate("w1"))._unsafeUnwrap()).toBeNull();
    await w.sessions.close({ runId: r.runId });
    expect((await w.sessions.locate("w1"))._unsafeUnwrap()).toBeNull();
  });
});
