import { describe, expect, test } from "bun:test";
import {
  AdvanceRun,
  ApproveRun,
  DEFAULT_PATHS,
  DriverLock,
  InitRun,
  messageLines,
  RunJournal,
  RunMessages,
  RunRepository,
  WorkflowCatalog,
} from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
  - id: approval
    hitl: true
  - id: build
    owner: mt-implementer
`;

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-02T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const advance = new AdvanceRun(catalog, repo, clock);
  return {
    fs,
    clock,
    repo,
    journal,
    init: (task: string) => new InitRun(catalog, repo, clock).execute({ workflow: "demo", task }),
    advance,
    approve: new ApproveRun(advance, repo, clock, catalog),
    lock: new DriverLock(repo, journal, clock),
    messages: new RunMessages(fs, repo, journal, clock),
  };
}

describe("DriverLock", () => {
  test("attach takes the session for one person, atomically, with a log line and an activity entry", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const taken = (await w.lock.attach({ by: "maciej" }))._unsafeUnwrap();
    expect(taken.driver).toEqual({
      by: "human",
      attachedBy: "maciej",
      attachedAt: "2026-11-02T10:00:00.000Z",
    });
    expect((await w.repo.load(run.runId))._unsafeUnwrap().driver).toEqual(taken.driver);
    expect((await w.fs.read(run.files.log))._unsafeUnwrap()).toContain("· driver · maciej attached");
    const activity = (await w.journal.activity(run.runId))._unsafeUnwrap();
    expect(activity.map((a) => [a.type, a.origin])).toEqual([["driver", "run"]]);
    // The same person again: already theirs; another person: refused, the lock names the holder.
    expect((await w.lock.attach({ by: "maciej" }))._unsafeUnwrap().driver.attachedBy).toBe("maciej");
    const other = (await w.lock.attach({ by: "alice" }))._unsafeUnwrapErr();
    expect(other.message).toBe(`run ${run.runId} is driven by maciej since 2026-11-02T10:00:00.000Z`);
  });

  test("release gives the session back to the agent; releasing an agent-driven run changes nothing", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    expect((await w.lock.release({}))._unsafeUnwrap().driver).toEqual({ by: "agent" });
    expect((await w.journal.activity(run.runId))._unsafeUnwrap()).toEqual([]);
    await w.lock.attach({ by: "maciej" });
    w.clock.advance(60_000);
    expect((await w.lock.release({}))._unsafeUnwrap().driver).toEqual({ by: "agent" });
    expect((await w.repo.load(run.runId))._unsafeUnwrap().driver).toEqual({ by: "agent" });
    expect((await w.fs.read(run.files.log))._unsafeUnwrap()).toContain("· driver · maciej released");
  });

  test("a finished run has no session to attach to", async () => {
    const w = world();
    await w.init("Add discount");
    await w.advance.execute({ event: { type: "ABORT", reason: "no" } });
    expect((await w.lock.attach({ by: "maciej" }))._unsafeUnwrapErr().message).toContain("is aborted");
  });
});

describe("who decided is never empty (R1)", () => {
  test("an approval, an answer and an attach without a name are refused and write nothing", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const before = (await w.fs.read(run.files.state))._unsafeUnwrap();
    for (const by of ["", "  "]) {
      expect((await w.approve.execute({ gate: "push", by }))._unsafeUnwrapErr().code).toBe("USAGE");
      expect((await w.advance.execute({ event: { type: "APPROVE", by } }))._unsafeUnwrapErr().code).toBe(
        "USAGE",
      );
      expect((await w.lock.attach({ by }))._unsafeUnwrapErr().code).toBe("USAGE");
    }
    const q = (
      await w.journal.ask(run.runId, {
        stage: "plan",
        source: "agent",
        prompt: "Which?",
        options: [{ label: "A" }],
        multiSelect: false,
      })
    )._unsafeUnwrap();
    const refused = (await w.journal.answer(run.runId, q.id, { choices: ["A"], by: "" }))._unsafeUnwrapErr();
    expect(refused.code).toBe("USAGE");
    expect(refused.message).toBe("say who answers: --by <name>");
    expect((await w.journal.questions(run.runId))._unsafeUnwrap()[0]?.answer).toBeUndefined();
    expect((await w.fs.read(run.files.state))._unsafeUnwrap()).toBe(before);
    expect((await w.repo.load(run.runId)).isOk()).toBe(true);
  });
});

describe("approval from the chat", () => {
  test("counts only while that person is attached; never for the push; logged with who held the session", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    await w.advance.execute({ event: { type: "PASS" } });
    const nobody = (
      await w.approve.execute({ gate: "approval", by: "maciej", via: "chat" })
    )._unsafeUnwrapErr();
    expect(nobody.message).toContain("nobody is attached");
    await w.lock.attach({ by: "maciej" });
    const someoneElse = (
      await w.approve.execute({ gate: "approval", by: "alice", via: "chat" })
    )._unsafeUnwrapErr();
    expect(someoneElse.message).toContain("is driven by maciej, not alice");
    const push = (await w.approve.execute({ gate: "push", by: "maciej", via: "chat" }))._unsafeUnwrapErr();
    expect(push.message).toBe("push is never approved from the chat");
    const ok = (await w.approve.execute({ gate: "approval", by: "maciej", via: "chat" }))._unsafeUnwrap();
    expect((ok as unknown as { stage: string }).stage).toBe("build");
    expect((await w.fs.read(run.files.log))._unsafeUnwrap()).toContain(
      "approval from the chat · approval · maciej attached since 2026-11-02T10:00:00.000Z",
    );
  });
});

describe("messageLines", () => {
  test("no message, no header; each message one line under the data header", () => {
    expect(messageLines([])).toEqual([]);
    const lines = messageLines([
      {
        id: "m001",
        fromRun: "20261102-demo-a",
        toRun: "20261102-demo-b",
        at: "2026-11-02T10:00:00.000Z",
        topic: "info",
        text: "hi",
        refs: [],
        by: "alice",
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("- from run 20261102-demo-a (info, alice): hi");
  });
});

describe("RunMessages", () => {
  test("a message lands in the receiving run, both runs note it, and its agents read it as data", async () => {
    const w = world();
    const a = (await w.init("Add discount"))._unsafeUnwrap();
    const b = (await w.init("Add invoices"))._unsafeUnwrap();
    const sent = (
      await w.messages.send({
        from: a.runId,
        to: b.runId,
        topic: "shared-file",
        text: "I changed the Invoice type",
        refs: ["src/invoice.ts"],
        by: "mt-implementer",
      })
    )._unsafeUnwrap();
    expect([sent.id, sent.topic, sent.refs]).toEqual(["m001", "shared-file", ["src/invoice.ts"]]);
    const listed = (await w.messages.list(b.runId))._unsafeUnwrap();
    expect(listed.map((m) => m.id)).toEqual(["m001"]);
    expect((await w.messages.list(a.runId))._unsafeUnwrap()).toEqual([]);
    const second = (
      await w.messages.send({ from: a.runId, to: b.runId, topic: "done", text: "merged", by: "alice" })
    )._unsafeUnwrap();
    expect(second.id).toBe("m002");
    const toB = (await w.journal.activity(b.runId))._unsafeUnwrap();
    expect(toB.map((x) => `${x.type}:${x.text.split(" · ")[0]}`)).toEqual([
      `message:m001 from ${a.runId}`,
      `message:m002 from ${a.runId}`,
    ]);
    const fromA = (await w.journal.activity(a.runId))._unsafeUnwrap();
    expect(fromA[0]?.text).toBe(`m001 to ${b.runId} · shared-file: I changed the Invoice type`);
    const unknown = (
      await w.messages.send({ from: a.runId, to: "20261102-demo-nope", topic: "info", text: "x", by: "y" })
    )._unsafeUnwrapErr();
    expect(unknown.code).toBe("NOT_FOUND");
  });
});
