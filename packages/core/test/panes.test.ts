import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  InitRun,
  LayoutPaneIdentity,
  LayoutStore,
  Panes,
  PtyBroker,
  RunJournal,
  RunRepository,
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
import { INTAKE_PROMPT } from "../src/application/panes.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-09T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const timers: { fn: () => void }[] = [];
  const broker = new PtyBroker({
    screens: new FakeScreenRenderer(),
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
      fs,
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

  test("the entry point (T1): a labeled workspace without a run is reused; a host pane with no prompt gets the intake prompt", async () => {
    const w = world();
    const first = (await w.panes.openWorkspace({ label: "intake" }))._unsafeUnwrap();
    expect((await w.panes.openWorkspace({ label: "intake" }))._unsafeUnwrap().id).toBe(first.id);
    expect((await w.panes.openWorkspace({ label: "other" }))._unsafeUnwrap().id).not.toBe(first.id);
    const pane = (
      await w.panes.openPane({
        workspace: first.id,
        role: "apps",
        label: "intake",
        process: { kind: "host", host: "copilot", agent: "mt-orchestrator", prompt: "" },
      })
    )._unsafeUnwrap();
    expect(pane).toMatchObject({ role: "apps", label: "intake" });
    expect(pane.runId).toBeUndefined();
    expect(w.copilot.started[0]?.task).toMatchObject({ agent: "mt-orchestrator", prompt: INTAKE_PROMPT });
    // The system run is driven in the background; the child runs it starts are sessions of their own.
    expect(INTAKE_PROMPT).toContain("open as their own conductor sessions: never drive those");
    expect(w.copilot.started[0]?.task.runDir).toBe(
      `${w.copilot.started[0]?.task.cwd}/.metator/panes/${pane.id}`,
    );
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

  test("restore brings sessions and plain shells back; a command is not run a second time (R11)", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.panes.openRun({ runId: r.runId });
    await w.panes.openPane({
      workspace: "w1",
      role: "apps",
      process: { kind: "command", argv: ["tail", "-f", "log"] },
    });
    await w.panes.openPane({
      workspace: "w1",
      role: "shell",
      process: { kind: "command", argv: ["/bin/zsh", "-l"] },
    });
    // A restore while the panes live changes nothing.
    expect((await w.panes.restore())._unsafeUnwrap()).toEqual([]);
    expect([w.copilot.started.length, w.terminal.spawned.length]).toEqual([1, 2]);
    // The daemon restarts: a new Panes over the same layout file, nothing live.
    for (const v of w.broker.list()) w.broker.close(v.paneId);
    const fresh = w.make();
    const restored = (await fresh.restore())._unsafeUnwrap();
    expect(restored).toEqual([
      { paneId: "w1:p1", ok: true },
      { paneId: "w1:p2", ok: false, skipped: "its command is not run a second time: tail -f log" },
      { paneId: "w1:p3", ok: true },
    ]);
    expect(w.copilot.started[1]?.resumed).toBe("copilot-1");
    // Only the shell was started again; the pane of the command is still in the layout, not live.
    expect(w.terminal.spawned.slice(2).map((s) => s.argv)).toEqual([["/bin/zsh", "-l"]]);
    expect((await fresh.view())._unsafeUnwrap().panes.map((p) => p.id)).toContain("w1:p2");
    expect(await fresh.authorize("tok-4")).toMatchObject({ id: "w1:p1" });
    expect(await fresh.authorize("tok-1")).toBeUndefined();
  });

  test("restore does not start the session of a run that is no longer active", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    await w.panes.openRun({ runId: r.runId });
    for (const v of w.broker.list()) w.broker.close(v.paneId);
    const record = (await w.repo.load(r.runId))._unsafeUnwrap();
    await w.repo.save({ ...record, state: { ...record.state, stage: "aborted", status: "aborted" } });
    const restored = (await w.make().restore())._unsafeUnwrap();
    expect(restored).toEqual([
      {
        paneId: "w1:p1",
        ok: false,
        skipped: `run ${r.runId} is aborted: its session is not started again`,
      },
    ]);
    expect(w.copilot.started.length).toBe(1);
  });

  test("read gives the last lines without escapes; wait sees idle and exit; close forgets the pane", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const pane = (await w.panes.openRun({ runId: r.runId }))._unsafeUnwrap();
    const pty = w.copilot.started[0]?.pty;
    pty?.print("\x1b[1mline1\x1b[0m\nline2\nline3\n");
    // The screen as shown: the escapes gone, no blank line after the last.
    expect(await w.panes.read(pane.id, 2)).toBe("line2\nline3");
    expect(await w.panes.read(pane.id, 3)).toBe("line1\nline2\nline3");
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

  test("a finished run's panes are ended, never removed: a living process is stopped, its screen kept; an open run keeps its own", async () => {
    const w = world();
    const done = (await w.init("Done already"))._unsafeUnwrap();
    const open = (await w.init("Still working"))._unsafeUnwrap();
    const aborted = (await w.init("Given up"))._unsafeUnwrap();
    await w.panes.openRun({ runId: aborted.runId });
    const gaveUp = (await w.repo.load(aborted.runId))._unsafeUnwrap();
    await w.repo.save({ ...gaveUp, state: { ...gaveUp.state, status: "aborted" } });
    const conductor = (await w.panes.openRun({ runId: done.runId }))._unsafeUnwrap();
    const ws = (await w.panes.openWorkspace({ runId: done.runId }))._unsafeUnwrap();
    await w.panes.openPane({
      workspace: ws.id,
      role: "worker",
      runId: done.runId,
      process: { kind: "command", argv: ["sh"] },
    });
    w.copilot.started.at(-1)?.pty.print("the last words of the conductor\n");
    await w.panes.openRun({ runId: open.runId });
    const record = (await w.repo.load(done.runId))._unsafeUnwrap();
    await w.repo.save({ ...record, state: { ...record.state, status: "done", stage: "done" } });
    const r = (await w.panes.endFinished())._unsafeUnwrap();
    expect(r.map((x) => [x.runId, x.ended]).sort()).toEqual(
      [
        [aborted.runId, 1],
        [done.runId, 2],
      ].sort(),
    );
    const left = (await w.layout.load())._unsafeUnwrap();
    // Every pane stays; the finished runs' ones say so, with when and why.
    expect(left.panes.map((p) => [p.runId, p.ended?.reason]).sort()).toEqual(
      [
        [aborted.runId, "run-finished"],
        [done.runId, "run-finished"],
        [done.runId, "run-finished"],
        [open.runId, undefined],
      ].sort(),
    );
    expect(left.panes.find((p) => p.id === conductor.id)?.ended?.at).toBe("2026-11-09T10:00:00.000Z");
    // The process was stopped; its last screen is still there to read.
    expect(w.broker.status(conductor.id)?.alive).toBe(false);
    expect(w.panes.screen(conductor.id)).toContain("the last words of the conductor");
    // Nothing left to end: nothing is said twice.
    expect((await w.panes.endFinished())._unsafeUnwrap()).toEqual([]);
  });

  test("a process that exits marks its pane ended with its exit code; the pane stays until a person closes it", async () => {
    const w = world();
    const ws = (await w.panes.openWorkspace({ label: "tools" }))._unsafeUnwrap();
    const pane = (
      await w.panes.openPane({ workspace: ws.id, role: "shell", process: { kind: "command", argv: ["sh"] } })
    )._unsafeUnwrap();
    w.terminal.spawned.at(-1)?.pty.print("bye\n");
    w.terminal.spawned.at(-1)?.pty.exit(3);
    await Bun.sleep(5);
    const ended = (await w.panes.pane(pane.id))._unsafeUnwrap().ended;
    expect([ended?.reason, ended?.exitCode]).toEqual(["exited", 3]);
    expect(w.panes.screen(pane.id)).toContain("bye");
    // A later end (the run finished) does not write over why it ended.
    expect((await w.panes.end(pane.id, { reason: "run-finished" }))._unsafeUnwrap().ended).toBe(false);
    // Closing ended panes in bulk: only the ended ones go.
    const live = (
      await w.panes.openPane({ workspace: ws.id, role: "shell", process: { kind: "command", argv: ["sh"] } })
    )._unsafeUnwrap();
    expect((await w.panes.closeEnded({}))._unsafeUnwrap()).toEqual({ closed: 1 });
    expect((await w.layout.load())._unsafeUnwrap().panes.map((p) => p.id)).toEqual([live.id]);
  });

  test("an ended pane's last screen is kept on disk: read after a restart, forgotten when a person closes it", async () => {
    const w = world();
    const ws = (await w.panes.openWorkspace({ label: "tools" }))._unsafeUnwrap();
    const pane = (
      await w.panes.openPane({ workspace: ws.id, role: "shell", process: { kind: "command", argv: ["sh"] } })
    )._unsafeUnwrap();
    w.terminal.spawned.at(-1)?.pty.print("last words\n");
    (await w.panes.end(pane.id, { reason: "run-finished" }))._unsafeUnwrap();
    // A restarted daemon: a broker that never saw the pane's output.
    const restarted = new Panes({
      layout: w.layout,
      broker: new PtyBroker({ repo: w.repo, journal: w.journal, idleMs: 1000, after: () => () => {} }),
      hosts: new Map(),
      terminal: w.terminal,
      repo: w.repo,
      journal: w.journal,
      clock: new FixedClock(new Date("2026-11-09T11:00:00.000Z")),
      timer: new InstantTimer(),
      root: "/repo",
      fs: w.fs,
    });
    expect(restarted.screen(pane.id)).toBe("");
    expect(await restarted.keptScreen(pane.id)).toContain("last words");
    (await restarted.closePane(pane.id))._unsafeUnwrap();
    expect(await restarted.keptScreen(pane.id)).toBe("");
    expect(await w.fs.exists(`.metator/panes/${pane.id.replaceAll(":", "-")}.screen`)).toBe(false);
  });

  test("the chat pane where a person gave a task remembers the run its agent started: that task's main terminal", async () => {
    const w = world();
    const ws = (await w.panes.openWorkspace({ label: "intake" }))._unsafeUnwrap();
    const chat = (
      await w.panes.openPane({
        workspace: ws.id,
        role: "shell",
        process: { kind: "host", agent: "mt-guide", prompt: "" },
      })
    )._unsafeUnwrap();
    const run = (await w.init("Add a badge"))._unsafeUnwrap();
    (await w.panes.setStartedRun(chat.id, run.runId))._unsafeUnwrap();
    expect((await w.panes.pane(chat.id))._unsafeUnwrap().startedRun).toBe(run.runId);
    expect((await w.panes.setStartedRun("w9:p9", run.runId))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("a host session a signal ended is paused, not ended, its session kept; a command's end is an end", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    w.copilot.started.at(-1)?.pty.exit(129);
    await Bun.sleep(5);
    const paused = (await w.panes.pane(conductor.id))._unsafeUnwrap();
    expect([
      paused.ended,
      paused.paused?.why,
      paused.process.kind === "host" && paused.process.sessionId,
    ]).toEqual([undefined, "process-lost", "copilot-1"]);
    // A host that exits by itself (its code under 128) has ended its work.
    const again = (await w.panes.resumePane(conductor.id))._unsafeUnwrap();
    expect([again.paused, w.copilot.started.at(-1)?.resumed]).toEqual([undefined, "copilot-1"]);
    w.copilot.started.at(-1)?.pty.exit(0);
    await Bun.sleep(5);
    expect((await w.panes.pane(conductor.id))._unsafeUnwrap().ended?.reason).toBe("exited");
    const ws = (await w.panes.openWorkspace({ label: "tools" }))._unsafeUnwrap();
    const shell = (
      await w.panes.openPane({ workspace: ws.id, role: "shell", process: { kind: "command", argv: ["sh"] } })
    )._unsafeUnwrap();
    w.terminal.spawned.at(-1)?.pty.exit(129);
    await Bun.sleep(5);
    expect((await w.panes.pane(shell.id))._unsafeUnwrap().ended?.exitCode).toBe(129);
  });

  test("the daemon stops: live sessions are paused with their screens; the next start resumes them in the same panes", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    w.copilot.started.at(-1)?.pty.print("planned step 1\n");
    expect((await w.panes.pauseAll())._unsafeUnwrap()).toEqual({ paused: 1 });
    // Its process goes with the daemon: the exit finds it paused, and it stays so.
    w.copilot.started.at(-1)?.pty.exit(129);
    await Bun.sleep(5);
    expect((await w.panes.pane(conductor.id))._unsafeUnwrap().paused?.why).toBe("daemon-stopped");
    // Its exit, however it is reported, is no end of its work.
    expect((await w.panes.end(conductor.id, { reason: "exited", exitCode: 0 }))._unsafeUnwrap().ended).toBe(
      false,
    );
    expect(await w.fs.exists(`.metator/panes/${conductor.id.replace(":", "-")}.screen`)).toBe(true);
    // The next daemon: the same pane, its session resumed, the screen it left above the new output.
    const next = w.make();
    expect((await next.restore())._unsafeUnwrap()).toEqual([{ paneId: conductor.id, ok: true }]);
    const back = (await next.pane(conductor.id))._unsafeUnwrap();
    expect([back.paused, back.live?.alive, w.copilot.started.at(-1)?.resumed]).toEqual([
      undefined,
      true,
      "copilot-1",
    ]);
    expect(await next.read(conductor.id)).toContain("planned step 1");
    // A viewer that joins now gets it too (the backlog), above what the session prints now.
    expect(w.broker.backlog(conductor.id)).toStartWith("planned step 1");
    const texts = (await w.journal.activity(run.runId))._unsafeUnwrap().map((a) => a.text);
    expect(texts).toContain(
      `pane ${conductor.id} paused (daemon-stopped): session copilot-1 can be continued`,
    );
  });

  test("a session resumed by the daemon is noted, once, for the line that tells it to go on: conductors and workers, not a chat", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    const ws = (await w.panes.openWorkspace({ label: "chat" }))._unsafeUnwrap();
    await w.panes.openPane({
      workspace: ws.id,
      role: "apps",
      process: { kind: "host", agent: "mt-guide", prompt: "" },
    });
    // An agent of the run that is neither its conductor nor a worker (a session a person opened in it).
    const own = (await w.panes.openWorkspace({ runId: run.runId }))._unsafeUnwrap();
    await w.panes.openPane({
      workspace: own.id,
      runId: run.runId,
      role: "apps",
      process: { kind: "host", agent: "mt-guide", prompt: "" },
    });
    (await w.panes.pauseAll())._unsafeUnwrap();
    // Their processes go with the daemon.
    for (const s of w.copilot.started) s.pty.exit(129);
    await Bun.sleep(5);
    expect(w.panes.resumeNotices()).toEqual([]);
    const next = w.make();
    (await next.restore())._unsafeUnwrap();
    expect(next.resumeNotices()).toEqual([
      {
        paneId: conductor.id,
        runId: run.runId,
        role: "conductor",
        why: "daemon-stopped",
        at: "2026-11-09T10:00:00.000Z",
      },
    ]);
    expect(next.resumeNoticePending(conductor.id)).toBe(true);
    next.resumeNoticeTold(conductor.id);
    expect([next.resumeNotices(), next.resumeNoticePending(conductor.id)]).toEqual([[], false]);
    // A pane's own Continue notes it too.
    w.copilot.started
      .filter((x) => x.resumed === "copilot-1")
      .at(-1)
      ?.pty.exit(129);
    await Bun.sleep(5);
    (await next.continuePane(conductor.id, "ana"))._unsafeUnwrap();
    expect(next.resumeNotices().map((n) => [n.paneId, n.why])).toEqual([[conductor.id, "process-lost"]]);
  });

  test("--no-restore: a session that went with the daemon stays paused until it is continued", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    // A SIGKILL: nothing marked the pane; its process died with the daemon.
    w.copilot.started.at(-1)?.pty.exit(137);
    await Bun.sleep(5);
    const next = w.make();
    const restored = (await next.restore(undefined, { resume: false }))._unsafeUnwrap();
    expect(restored).toEqual([
      { paneId: conductor.id, ok: false, skipped: "paused: `metator run continue` resumes it" },
    ]);
    expect((await next.pane(conductor.id))._unsafeUnwrap().paused).toBeDefined();
    expect(w.copilot.started).toHaveLength(1);
    (await next.resumePane(conductor.id))._unsafeUnwrap();
    expect([
      (await next.pane(conductor.id))._unsafeUnwrap().paused,
      w.copilot.started.at(-1)?.resumed,
    ]).toEqual([undefined, "copilot-1"]);
    // A paused pane whose run finishes ends: its work is over.
    w.copilot.started.at(-1)?.pty.exit(143);
    await Bun.sleep(5);
    (await w.panes.end(conductor.id, { reason: "run-finished" }))._unsafeUnwrap();
    const over = (await next.pane(conductor.id))._unsafeUnwrap();
    expect([over.paused, over.ended?.reason]).toEqual([undefined, "run-finished"]);
    expect((await next.resumePane(conductor.id))._unsafeUnwrapErr().message).toContain(
      "has ended (run-finished)",
    );
  });

  test("a pane a person closes is gone, not paused: the exit its close causes is nobody's to read", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    // The fake's kill reports the hang-up a real terminal gives (129).
    const pty = w.copilot.started.at(-1)?.pty;
    const kill = pty?.kill.bind(pty);
    if (pty)
      pty.kill = () => {
        kill?.();
        pty.exit(129);
      };
    (await w.panes.closePane(conductor.id))._unsafeUnwrap();
    await Bun.sleep(5);
    const texts = (await w.journal.activity(run.runId))._unsafeUnwrap().map((a) => a.text);
    expect(texts.some((t) => t.includes("paused"))).toBe(false);
    expect((await w.layout.load())._unsafeUnwrap().panes).toEqual([]);
  });

  test("a paused pane's own Continue resumes only it; a pane that is not paused is refused, with why", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    const live = (await w.panes.continuePane(conductor.id, "ana"))._unsafeUnwrapErr();
    expect([live.code, live.message]).toEqual([
      "TRANSITION_DENIED",
      `pane ${conductor.id} is not paused: there is nothing to continue`,
    ]);
    w.copilot.started.at(-1)?.pty.exit(129);
    await Bun.sleep(5);
    expect((await w.panes.continuePane(conductor.id, " "))._unsafeUnwrapErr().message).toBe(
      "say who continues: by",
    );
    expect((await w.panes.continuePane(conductor.id, "ana"))._unsafeUnwrap()).toEqual({
      paneId: conductor.id,
      role: "conductor",
      sessionId: "copilot-1",
    });
    const texts = (await w.journal.activity(run.runId))._unsafeUnwrap().map((a) => a.text);
    expect(texts).toContain(`continued by ana: resumed pane ${conductor.id} (session copilot-1)`);
  });

  test("an ended pane is not started again after a restart; a pane started again is no longer ended", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    (await w.panes.end(conductor.id, { reason: "collected", summary: "done: plan.md" }))._unsafeUnwrap();
    const restored = (await w.make().restore())._unsafeUnwrap();
    expect(restored.find((r) => r.paneId === conductor.id)?.skipped).toBe("its work ended (collected)");
    // The run's conductor opened again (the supervisor's resume, `run start`): alive, not ended.
    const again = (await w.panes.openRun({ runId: run.runId }))._unsafeUnwrap();
    expect([again.id, again.ended]).toEqual([conductor.id, undefined]);
  });

  test("a pane's identity: a worker by its name and stage, the conductor by its agent at the run's stage", async () => {
    const w = world();
    const r = (await w.init("Add discount"))._unsafeUnwrap();
    const conductor = (await w.panes.openRun({ runId: r.runId, agent: "mt-orchestrator" }))._unsafeUnwrap();
    const worker = (
      await w.panes.openPane({
        workspace: (await w.panes.openWorkspace({ runId: r.runId }))._unsafeUnwrap().id,
        role: "worker",
        runId: r.runId,
        worker: { name: "mt-implementer-1", stage: "plan" },
        process: { kind: "command", argv: ["sh"] },
      })
    )._unsafeUnwrap();
    const who = new LayoutPaneIdentity(w.layout, w.repo);
    expect(await who.of(conductor.id)).toEqual({
      role: "conductor",
      agent: "mt-orchestrator",
      stage: "build",
    });
    expect(await who.of(worker.id)).toEqual({ role: "worker", agent: "mt-implementer-1", stage: "plan" });
    expect(await who.of("w9:p9")).toBeUndefined();
  });

  test("splitPane opens a shell beside the pane and the tab's tree remembers it; setTree accepts only the tab's panes", async () => {
    const w = world();
    const r = (await w.init("Split"))._unsafeUnwrap();
    const ws = (await w.panes.openWorkspace({ runId: r.runId }))._unsafeUnwrap();
    const first = (
      await w.panes.openPane({ workspace: ws.id, role: "shell", process: { kind: "command", argv: ["sh"] } })
    )._unsafeUnwrap();
    const right = (await w.panes.splitPane(first.id, { dir: "right" }))._unsafeUnwrap();
    expect([right.id, right.tab, right.role, right.cwd]).toEqual(["w1:p2", first.tab, "shell", first.cwd]);
    const below = (
      await w.panes.splitPane(right.id, { dir: "down", process: { kind: "command", argv: ["top"] } })
    )._unsafeUnwrap();
    expect(below.process).toEqual({ kind: "command", argv: ["top"] });
    const tab = (await w.layout.load())._unsafeUnwrap().workspaces[0]?.tabs[0];
    expect(tab?.panes).toEqual(["w1:p1", "w1:p2", "w1:p3"]);
    expect(tab?.tree).toEqual({
      dir: "row",
      ratio: 0.5,
      a: { pane: "w1:p1" },
      b: { dir: "column", ratio: 0.5, a: { pane: "w1:p2" }, b: { pane: "w1:p3" } },
    });
    const resized = (
      await w.panes.setTree(tab?.id as string, {
        dir: "row",
        ratio: 0.3,
        a: { pane: "w1:p1" },
        b: { dir: "column", ratio: 0.6, a: { pane: "w1:p2" }, b: { pane: "w1:p3" } },
      })
    )._unsafeUnwrap();
    expect(resized.tree && "ratio" in resized.tree ? resized.tree.ratio : 0).toBe(0.3);
    const wrong = await w.panes.setTree(tab?.id as string, { pane: "w1:p1" });
    expect(wrong.isErr() && wrong.error.code).toBe("USAGE");
    expect((await w.panes.splitPane("w1:p9", { dir: "right" })).isErr()).toBe(true);
    // Closing a pane prunes it from the tree.
    (await w.panes.closePane("w1:p2"))._unsafeUnwrap();
    const after = (await w.layout.load())._unsafeUnwrap().workspaces[0]?.tabs[0];
    expect(after?.tree).toEqual({ dir: "row", ratio: 0.3, a: { pane: "w1:p1" }, b: { pane: "w1:p3" } });
  });
});
