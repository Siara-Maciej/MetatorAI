import { describe, expect, test } from "bun:test";
import {
  ANSWERED_IN_PANE,
  ATTACH_PANE,
  DEFAULT_PATHS,
  DriverLock,
  HostManifestCatalog,
  HostPrompts,
  InitRun,
  LEAVE_PANE,
  Notifier,
  PaneSensor,
  PtyBroker,
  type Question,
  RunJournal,
  RunRepository,
  WorkflowCatalog,
} from "@metator/core";
import { FakePty, FixedClock, InMemoryFileSystem, ScriptedProcessRunner } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world(files: Record<string, string> = {}) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW, ...files });
  const clock = new FixedClock(new Date("2026-11-09T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const broker = new PtyBroker({ repo, journal, clock, idleMs: 60_000, after: () => () => {} });
  const manifests = new HostManifestCatalog(fs);
  const sensor = new PaneSensor({ broker, manifests, journal, clock });
  const lock = new DriverLock(repo, journal, clock);
  const prompts = new HostPrompts({ sensor, journal, lock });
  const init = (task: string) => new InitRun(catalog, repo, clock).execute({ workflow: "demo", task });
  const start = (paneId: string, runId: string | undefined, host: string, pid = 1001) => {
    const pty = new FakePty(pid);
    broker
      .start({
        paneId,
        ...(runId ? { runId } : {}),
        role: "conductor",
        host,
        sessionId: `${host}-1`,
        pty,
      })
      ._unsafeUnwrap();
    return pty;
  };
  return { fs, clock, repo, journal, broker, manifests, sensor, lock, prompts, init, start };
}

describe("HostManifestCatalog", () => {
  test("a repository's metator/hosts/<host>.yml wins over the built-in manifest; a wrong host name or pattern is an error", async () => {
    const w = world({
      "metator/hosts/copilot.yml":
        "kind: HostManifest\nschemaVersion: 1\nhost: copilot\nscreen:\n  blocked: ['^OK\\?$']\nquietMs: 500\n",
      "metator/hosts/claude.yml": "kind: HostManifest\nschemaVersion: 1\nhost: copilot\n",
      "metator/hosts/opencode.yml":
        "kind: HostManifest\nschemaVersion: 1\nhost: opencode\nscreen:\n  blocked: ['(']\n",
    });
    const copilot = (await w.manifests.get("copilot"))._unsafeUnwrap();
    expect([copilot.screen.blocked, copilot.quietMs, copilot.hooks]).toEqual([["^OK\\?$"], 500, true]);
    expect((await w.manifests.get("claude"))._unsafeUnwrapErr().message).toBe(
      "metator/hosts/claude.yml describes host copilot, not claude",
    );
    expect((await w.manifests.get("opencode"))._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
    expect((await w.manifests.get("scenario"))._unsafeUnwrap().quietMs).toBe(2000);
    expect((await w.manifests.get("unknown"))._unsafeUnwrap().screen.blocked).toEqual([]);
    expect(w.manifests.builtin()).toEqual(["copilot", "claude", "opencode", "scenario"]);
  });
});

describe("PaneSensor", () => {
  test("reads each pane with its host's manifest: working, blocked, waiting, idle, exited; an unknown pane is not found", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = w.start("w1:p1", run.runId, "copilot");
    const shell = w.start("w1:p2", undefined, "sh", 1002);
    pty.print("thinking\n");
    expect((await w.sensor.state("w1:p1"))._unsafeUnwrap()).toEqual({
      state: "working",
      reason: "output just now",
    });
    w.clock.advance(20_000);
    expect((await w.sensor.state("w1:p1"))._unsafeUnwrap().state).toBe("idle");
    w.broker.heartbeat("w1:p1");
    expect((await w.sensor.state("w1:p1"))._unsafeUnwrap()).toEqual({
      state: "working",
      reason: "a hook call just now",
    });
    pty.print("Allow copilot to run `bun test`? (y/n) ");
    expect((await w.sensor.state("w1:p1"))._unsafeUnwrap()).toEqual({
      state: "blocked",
      reason: "Allow copilot to run `bun test`? (y/n)",
    });
    pty.print("\ny\nrunning…\nok\nok\nok\nok\n");
    await w.journal.ask(run.runId, {
      stage: "build",
      source: "agent",
      prompt: "Round half up?",
      options: [{ label: "yes" }],
      multiSelect: false,
    });
    expect((await w.sensor.state("w1:p1"))._unsafeUnwrap().state).toBe("waiting");
    // A shell: a generic manifest, so only quiet and exit are read.
    shell.print("$ ");
    expect((await w.sensor.state("w1:p2"))._unsafeUnwrap().state).toBe("working");
    shell.exit(0);
    expect((await w.sensor.state("w1:p2"))._unsafeUnwrap()).toEqual({
      state: "exited",
      reason: "exited with 0",
    });
    expect((await w.sensor.all())._unsafeUnwrap().map((p) => [p.paneId, p.state])).toEqual([
      ["w1:p1", "waiting"],
      ["w1:p2", "exited"],
    ]);
    expect((await w.sensor.state("w9:p9"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

describe("HostPrompts", () => {
  test("a host's prompt on a run's pane becomes one inbox question; attach takes the lock for the person; the prompt gone closes it", async () => {
    const process = new ScriptedProcessRunner([{ argvPrefix: ["sh"], result: { exitCode: 0 } }]);
    const w = world();
    const notifier = new Notifier({ journal: w.journal, process, root: "/repo", command: "notify-send hi" });
    const prompts = new HostPrompts({ sensor: w.sensor, journal: w.journal, lock: w.lock, notify: notifier });
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = w.start("w1:p1", run.runId, "copilot");
    w.start("w1:p2", undefined, "sh", 1002).print("Allow? (y/n)");
    pty.print("working\n");
    expect((await prompts.tick())._unsafeUnwrap()).toEqual({ asked: [], attached: [], resolved: [] });
    pty.print("Do you want to allow `git status`? (y/n) ");
    const first = (await prompts.tick())._unsafeUnwrap();
    expect(first.asked).toEqual([{ paneId: "w1:p1", runId: run.runId, questionId: "q001" }]);
    const q = (await w.journal.questions(run.runId))._unsafeUnwrap()[0] as Question;
    expect([q.source, q.agent, q.stage, q.prompt]).toEqual([
      "permission",
      "copilot",
      "session",
      "copilot waits for your answer in pane w1:p1: Do you want to allow `git status`? (y/n)",
    ]);
    expect(q.options.map((o) => o.label)).toEqual([ATTACH_PANE, LEAVE_PANE, "Other"]);
    // Notified once, through notify.command, with the question in the environment.
    expect(process.calls.length).toBe(1);
    expect(process.calls[0]?.env?.METATOR_QUESTION_ID).toBe("q001");
    // Still blocked, unanswered: asked once, not again.
    expect((await prompts.tick())._unsafeUnwrap().asked).toEqual([]);
    expect((await w.journal.questions(run.runId))._unsafeUnwrap().length).toBe(1);
    await w.journal.answer(run.runId, "q001", { choices: [ATTACH_PANE], by: "maciej" });
    const second = (await prompts.tick())._unsafeUnwrap();
    expect(second.attached).toEqual([{ paneId: "w1:p1", runId: run.runId, by: "maciej" }]);
    expect((await w.repo.load(run.runId))._unsafeUnwrap().driver).toMatchObject({
      by: "human",
      attachedBy: "maciej",
    });
    // They answered the host in the pane: the screen moves on, the item is resolved.
    pty.print("\ny\nrunning git status…\nM src/a.ts\nM src/b.ts\nM src/c.ts\nM src/d.ts\n");
    const third = (await prompts.tick())._unsafeUnwrap();
    expect(third.resolved).toEqual(["w1:p1"]);
    const texts = (await w.journal.activity(run.runId))._unsafeUnwrap().map((a) => a.text);
    expect(texts).toContain("the host prompt in pane w1:p1 went away");
    // Blocked again: a new question (the first was answered).
    pty.print("Allow `bun test`? (y/n) ");
    expect((await prompts.tick())._unsafeUnwrap().asked.map((a) => a.questionId)).toEqual(["q002"]);
    // Left alone: no attach, no second question while the prompt stays; gone, the question is closed as answered in the pane.
    await w.journal.answer(run.runId, "q002", { choices: [LEAVE_PANE], by: "maciej" });
    expect((await prompts.tick())._unsafeUnwrap()).toEqual({ asked: [], attached: [], resolved: [] });
    expect((await prompts.tick())._unsafeUnwrap().asked).toEqual([]);
    pty.print("\ny\ndone\n1\n2\n3\n4\n5\n");
    expect((await prompts.tick())._unsafeUnwrap().resolved).toEqual(["w1:p1"]);
    // A prompt that goes away before anyone answered is answered by the pane itself.
    pty.print("Allow `rm`? (y/n) ");
    await prompts.tick();
    pty.print("\nn\n1\n2\n3\n4\n5\n");
    await prompts.tick();
    const q3 = (await w.journal.questions(run.runId))._unsafeUnwrap().find((x) => x.id === "q003");
    expect(q3?.answer).toMatchObject({ choices: ["Other"], text: ANSWERED_IN_PANE, by: "pane:w1:p1" });
  });
});
