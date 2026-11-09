import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  InitRun,
  LayoutStore,
  Panes,
  PtyBroker,
  RunJournal,
  RunRepository,
  WorkflowCatalog,
} from "@metator/core";
import {
  FakeInteractiveHost,
  FakeTerminal,
  FixedClock,
  InMemoryFileSystem,
  InstantTimer,
} from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-09T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const timers: { fn: () => void }[] = [];
  const broker = new PtyBroker({
    repo,
    journal,
    idleMs: 1000,
    after: (_ms, fn) => {
      const t = { fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  const copilot = new FakeInteractiveHost("copilot");
  const claude = new FakeInteractiveHost("claude");
  const terminal = new FakeTerminal();
  let n = 0;
  const layout = new LayoutStore(fs);
  const make = () =>
    new Panes({
      layout,
      broker,
      hosts: new Map([
        ["copilot", copilot],
        ["claude", claude],
      ]),
      terminal,
      repo,
      journal,
      clock,
      timer: new InstantTimer(),
      root: "/repo",
      token: () => `tok-${++n}`,
    });
  const panes = make();
  const init = (task: string) =>
    new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock).execute({ workflow: "demo", task });
  return { fs, repo, journal, broker, copilot, claude, terminal, timers, layout, panes, make, init };
}

describe("Panes", () => {
  test("a run's workspace is made once, in its directory; a shell pane starts with the pane's identity", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const ws = (await w.panes.openWorkspace({ runId: r.runId }))._unsafeUnwrap();
    expect(ws).toMatchObject({ id: "w1", label: r.runId, cwd: "/repo", runId: r.runId });
    expect((await w.panes.openWorkspace({ runId: r.runId }))._unsafeUnwrap().id).toBe("w1");
    const pane = (
      await w.panes.openPane({
        workspace: "w1",
        role: "shell",
        process: { kind: "command", argv: ["sh", "-l"] },
      })
    )._unsafeUnwrap();
    expect(pane).toMatchObject({ id: "w1:p1", role: "shell", label: "sh", cwd: "/repo", runId: r.runId });
    expect(pane.live).toMatchObject({ paneId: "w1:p1", role: "shell", alive: true, pid: 5001 });
    expect(w.terminal.spawned[0]).toMatchObject({
      argv: ["sh", "-l"],
      cwd: "/repo",
      env: { METATOR_PANE_ID: "w1:p1", METATOR_PANE_TOKEN: "tok-1", METATOR_ROLE: "shell" },
    });
    expect(await w.panes.authorize("tok-1")).toMatchObject({ id: "w1:p1" });
    expect(await w.panes.authorize("nope")).toBeUndefined();
    const layout = (await w.layout.load())._unsafeUnwrap();
    expect(layout.workspaces[0]?.tabs[0]?.panes).toEqual(["w1:p1"]);
  });

  test("openRun starts the conductor with the run's task on the default host, remembers the session, reuses it alive, resumes it dead", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const first = (await w.panes.openRun({ runId: r.runId }))._unsafeUnwrap();
    expect(first).toMatchObject({
      id: "w1:p1",
      role: "conductor",
      runId: r.runId,
      process: {
        kind: "host",
        host: "copilot",
        agent: "session",
        prompt: "Add discount",
        sessionId: "copilot-1",
      },
    });
    const started = w.copilot.started[0];
    expect([started?.task.prompt, started?.task.cwd, started?.task.driven, started?.task.env]).toEqual([
      "Add discount",
      "/repo",
      true,
      { METATOR_PANE_ID: "w1:p1", METATOR_PANE_TOKEN: "tok-1", METATOR_ROLE: "conductor" },
    ]);
    expect((await w.repo.load(r.runId))._unsafeUnwrap()).toMatchObject({
      host: "copilot",
      hostSession: "copilot-1",
    });
    expect((await w.panes.openRun({ runId: r.runId }))._unsafeUnwrap().live?.pid).toBe(first.live?.pid);
    expect(w.copilot.started.length).toBe(1);
    started?.pty.exit(0);
    const again = (await w.panes.openRun({ runId: r.runId }))._unsafeUnwrap();
    expect([again.id, w.copilot.started[1]?.resumed, again.live?.pid]).toEqual(["w1:p1", "copilot-1", 1002]);
    const activity = (await w.journal.activity(r.runId))._unsafeUnwrap();
    expect(activity.map((a) => a.text)).toEqual([
      "started session copilot-1 in pane w1:p1 (pid 1001)",
      "session copilot-1 exited with 0 (pane w1:p1)",
      "resumed session copilot-1 in pane w1:p1 (pid 1002)",
    ]);
  });

  test("a worker pane on another host, in another tab, with its worker named", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.panes.openRun({ runId: r.runId });
    const tab = (await w.panes.openTab("w1", "workers"))._unsafeUnwrap();
    const worker = (
      await w.panes.openPane({
        workspace: "w1",
        tab,
        role: "worker",
        worker: { name: "impl-1", stage: "build" },
        process: { kind: "host", host: "claude", agent: "mt-implementer", prompt: "Implement step 1" },
      })
    )._unsafeUnwrap();
    expect(worker).toMatchObject({
      id: "w1:p2",
      tab: "w1:t2",
      role: "worker",
      label: "mt-implementer",
      worker: { name: "impl-1", stage: "build" },
    });
    expect(w.claude.started[0]?.task).toMatchObject({
      agent: "mt-implementer",
      prompt: "Implement step 1",
      env: { METATOR_ROLE: "worker" },
    });
    expect(w.broker.byRun(r.runId).map((v) => v.paneId)).toEqual(["w1:p1", "w1:p2"]);
    expect(
      (
        await w.panes.openPane({
          workspace: "w1",
          role: "worker",
          process: { kind: "host", host: "nope", agent: "x", prompt: "" },
        })
      )._unsafeUnwrapErr().message,
    ).toBe("unknown interactive host nope");
    expect(
      (
        await w.panes.openPane({ workspace: "w9", role: "shell", process: { kind: "command", argv: ["sh"] } })
      )._unsafeUnwrapErr().code,
    ).toBe("NOT_FOUND");
  });

  test("restore brings every pane back: sessions resumed, commands rerun, a failure noted in the run", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.panes.openRun({ runId: r.runId });
    await w.panes.openPane({
      workspace: "w1",
      role: "apps",
      process: { kind: "command", argv: ["tail", "-f", "log"] },
    });
    // A restore while the panes live changes nothing.
    expect((await w.panes.restore())._unsafeUnwrap()).toEqual([]);
    expect([w.copilot.started.length, w.terminal.spawned.length]).toEqual([1, 1]);
    // The daemon restarts: a new Panes over the same layout file, nothing live.
    for (const v of w.broker.list()) w.broker.close(v.paneId);
    const fresh = w.make();
    const restored = (await fresh.restore())._unsafeUnwrap();
    expect(restored).toEqual([
      { paneId: "w1:p1", ok: true },
      { paneId: "w1:p2", ok: true },
    ]);
    expect(w.copilot.started[1]?.resumed).toBe("copilot-1");
    expect(w.terminal.spawned[1]?.argv).toEqual(["tail", "-f", "log"]);
    expect(await fresh.authorize("tok-3")).toMatchObject({ id: "w1:p1" });
    expect(await fresh.authorize("tok-1")).toBeUndefined();
  });

  test("read gives the last lines without escapes; wait sees idle and exit; close forgets the pane", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const pane = (await w.panes.openRun({ runId: r.runId }))._unsafeUnwrap();
    const pty = w.copilot.started[0]?.pty;
    pty?.print("\x1b[1mline1\x1b[0m\nline2\nline3\n");
    expect(w.panes.read(pane.id, 2)).toBe("line3\n");
    expect(w.panes.read(pane.id, 3)).toBe("line2\nline3\n");
    w.timers.at(-1)?.fn();
    await Bun.sleep(5);
    expect((await w.panes.wait(pane.id, { until: ["idle"], timeoutMs: 1000 }))._unsafeUnwrap()).toEqual({
      state: "idle",
    });
    expect((await w.panes.wait(pane.id, { until: ["exited"], timeoutMs: 0 }))._unsafeUnwrap()).toEqual({
      state: "timeout",
    });
    pty?.exit(2);
    expect((await w.panes.wait(pane.id, { until: ["idle"], timeoutMs: 1000 }))._unsafeUnwrap()).toEqual({
      state: "exited",
      exitCode: 2,
    });
    expect((await w.panes.closePane(pane.id))._unsafeUnwrap()).toEqual({ closed: true });
    expect((await w.panes.pane(pane.id))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await w.panes.wait(pane.id, { until: ["idle"], timeoutMs: 1 }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
    const view = (await w.panes.view())._unsafeUnwrap();
    expect([view.workspaces.length, view.panes.length]).toEqual([1, 0]);
    expect((await w.panes.closeWorkspace("w1"))._unsafeUnwrap()).toEqual({ closed: 0 });
    expect((await w.panes.view())._unsafeUnwrap().workspaces).toEqual([]);
  });

  test("a run in its own worktree sits under the repository's workspace (made once); run close closes the run's workspace", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const record = (await w.repo.load(r.runId))._unsafeUnwrap();
    await w.repo.save({ ...record, worktree: { id: "wt-1", path: ".metator/wt/wt-1", branch: "run/wt-1" } });
    const ws = (await w.panes.openWorkspace({ runId: r.runId }))._unsafeUnwrap();
    expect(ws).toMatchObject({ id: "w2", cwd: "/repo/.metator/wt/wt-1", runId: r.runId, group: "w1" });
    const layout = (await w.layout.load())._unsafeUnwrap();
    expect(layout.workspaces.map((x) => [x.id, x.label, x.cwd, x.runId ?? null, x.group ?? null])).toEqual([
      ["w1", "repo", "/repo", null, null],
      ["w2", r.runId, "/repo/.metator/wt/wt-1", r.runId, "w1"],
    ]);
    // A second worktree run joins the same group; a run in the checkout itself stands alone.
    const r2 = (await w.init("Second"))._unsafeUnwrap();
    const rec2 = (await w.repo.load(r2.runId))._unsafeUnwrap();
    await w.repo.save({ ...rec2, worktree: { id: "wt-2", path: ".metator/wt/wt-2", branch: "run/wt-2" } });
    expect((await w.panes.openWorkspace({ runId: r2.runId }))._unsafeUnwrap().group).toBe("w1");
    const r3 = (await w.init("Third"))._unsafeUnwrap();
    expect((await w.panes.openWorkspace({ runId: r3.runId }))._unsafeUnwrap().group).toBeUndefined();
    await w.panes.openRun({ runId: r.runId });
    await w.panes.openPane({ workspace: "w2", role: "shell", process: { kind: "command", argv: ["sh"] } });
    expect((await w.panes.closeRun(r.runId))._unsafeUnwrap()).toEqual({ closed: 2, workspace: "w2" });
    expect((await w.panes.closeRun(r.runId))._unsafeUnwrap()).toEqual({ closed: 0 });
    const after = (await w.layout.load())._unsafeUnwrap();
    expect(after.workspaces.map((x) => x.id)).toEqual(["w1", "w3", "w4"]);
    expect(after.panes).toEqual([]);
  });
});
