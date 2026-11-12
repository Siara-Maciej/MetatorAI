import { describe, expect, test } from "bun:test";
import {
  AdvanceRun,
  byBacklogOrder,
  DEFAULT_PATHS,
  InitRun,
  type Issue,
  IssueDocument,
  Issues,
  issueTask,
  nextIssueId,
  PROPOSAL_ADD,
  PROPOSAL_DROP,
  PROPOSAL_START,
  proposalDecision,
  proposalQuestion,
  RunJournal,
  RunRepository,
  refText,
  WorkflowCatalog,
} from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world(allowed = true) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-09T22:40:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const initRun = new InitRun(catalog, repo, clock);
  const advance = new AdvanceRun(catalog, repo, clock);
  const issues = new Issues({
    fs,
    paths: DEFAULT_PATHS,
    clock,
    journal,
    repo,
    initRun,
    proposalsAllowed: async () => allowed,
  });
  const init = (task: string) => initRun.execute({ workflow: "demo", task });
  return { fs, clock, repo, journal, issues, init, advance };
}

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "i001",
  title: "Negative amounts in round2",
  body: "Math.round is half-up for positives only.",
  status: "proposed",
  priority: "normal",
  labels: ["billing"],
  refs: [{ file: "src/invoice.ts", line: 10 }, { run: "r1", step: "S2" }, { note: "see the plan" }],
  proposedBy: { agent: "mt-implementer-1", runId: "r1", at: "2026-11-09T22:36:00.000Z" },
  createdAt: "2026-11-09T22:36:00.000Z",
  updatedAt: "2026-11-09T22:36:00.000Z",
  ...over,
});

describe("issue domain", () => {
  test("ids count up past the ones taken; refs read as text; the task of a run is title and body", () => {
    expect(nextIssueId([])).toBe("i001");
    expect(nextIssueId(["i001", "i007", "i003"])).toBe("i008");
    expect(issue().refs.map(refText)).toEqual(["src/invoice.ts:10", "run r1/S2", "see the plan"]);
    expect(issueTask(issue())).toBe(
      "Negative amounts in round2\n\nMath.round is half-up for positives only.",
    );
    expect(issueTask(issue({ body: " " }))).toBe("Negative amounts in round2");
    expect(IssueDocument.parse({ kind: "Issue", schemaVersion: 1, ...issue() }, "i001.json").isOk()).toBe(
      true,
    );
    expect(
      IssueDocument.parse({ kind: "Issue", schemaVersion: 1, ...issue({ id: "x1" }) }, "x").isErr(),
    ).toBe(true);
  });

  test("a proposal is a question with three answers; the answer is the decision", () => {
    const q = proposalQuestion(issue(), "build");
    expect([q.source, q.agent, q.prompt]).toEqual([
      "agent",
      "mt-implementer-1",
      "mt-implementer-1 proposes a task: Negative amounts in round2",
    ]);
    expect(q.options.map((o) => o.label)).toEqual([PROPOSAL_ADD, PROPOSAL_START, PROPOSAL_DROP]);
    expect(q.card).toMatchObject({
      recommended: PROPOSAL_ADD,
      reversible: true,
      artifacts: ["src/invoice.ts:10", "run r1/S2", "see the plan"],
    });
    const at = "2026-11-09T22:41:00.000Z";
    expect(proposalDecision({ choices: [PROPOSAL_ADD], by: "maciej", at })).toBe("added");
    expect(proposalDecision({ choices: [PROPOSAL_START], by: "maciej", at })).toBe("start");
    expect(proposalDecision({ choices: [PROPOSAL_DROP], by: "maciej", at })).toBe("dropped");
    expect(proposalDecision({ choices: ["Other"], text: "later", by: "maciej", at })).toBeUndefined();
    expect(proposalDecision(undefined)).toBeUndefined();
  });

  test("the backlog order: proposals, then in progress, then open by priority, then done and dropped", () => {
    const list = [
      issue({ id: "i004", status: "done" }),
      issue({ id: "i003", status: "open", priority: "low" }),
      issue({ id: "i002", status: "open", priority: "high" }),
      issue({ id: "i005", status: "in-progress" }),
      issue({ id: "i001", status: "proposed" }),
      issue({ id: "i006", status: "dropped" }),
    ].sort(byBacklogOrder);
    expect(list.map((i) => i.id)).toEqual(["i001", "i005", "i002", "i003", "i004", "i006"]);
  });
});

describe("Issues", () => {
  test("a person adds a task: open, decided by them, in .metator/issues; edit, close and drop change it", async () => {
    const w = world();
    const added = (
      await w.issues.add({
        title: "ADR for rounding",
        body: "Half-up or half-even.",
        by: "maciej",
        priority: "high",
        labels: ["adr"],
      })
    )._unsafeUnwrap();
    expect(added).toMatchObject({
      id: "i001",
      status: "open",
      priority: "high",
      decidedBy: { by: "maciej", decision: "added" },
    });
    expect(await w.fs.exists(".metator/issues/i001.json")).toBe(true);
    expect((await w.issues.add({ title: "x", by: " " })).isErr()).toBe(true);
    expect((await w.issues.add({ title: " ", by: "maciej" })).isErr()).toBe(true);
    const edited = (
      await w.issues.edit("i001", { priority: "low", labels: ["adr", "billing"] })
    )._unsafeUnwrap();
    expect([edited.priority, edited.labels]).toEqual(["low", ["adr", "billing"]]);
    expect((await w.issues.close("i001", { by: "maciej" }))._unsafeUnwrap().status).toBe("done");
    const second = (await w.issues.add({ title: "Flaky test", by: "maciej" }))._unsafeUnwrap();
    expect(second.id).toBe("i002");
    expect((await w.issues.drop("i002", { by: "maciej" }))._unsafeUnwrap()).toMatchObject({
      status: "dropped",
      decidedBy: { decision: "dropped" },
    });
    expect((await w.issues.show("i009")).isErr()).toBe(true);
    expect((await w.issues.list())._unsafeUnwrap().map((i) => [i.id, i.status])).toEqual([
      ["i001", "done"],
      ["i002", "dropped"],
    ]);
  });

  test("an agent proposes: the issue is proposed and the run gets a question; the person's answer in the inbox decides it", async () => {
    const w = world();
    const run = (await w.init("Add the discount"))._unsafeUnwrap();
    const proposed = (
      await w.issues.propose({
        title: "Negative amounts in round2",
        body: "half-down for negatives",
        agent: "mt-implementer-1",
        runId: run.runId,
        refs: [{ file: "src/invoice.ts", line: 10 }],
      })
    )._unsafeUnwrap();
    expect(proposed.issue).toMatchObject({
      status: "proposed",
      proposedBy: { agent: "mt-implementer-1", runId: run.runId, questionId: "q001" },
    });
    expect(proposed.issue.refs).toEqual([{ file: "src/invoice.ts", line: 10 }, { run: run.runId }]);
    const questions = (await w.journal.questions(run.runId))._unsafeUnwrap();
    expect(questions.map((q) => [q.id, q.source, q.agent])).toEqual([["q001", "agent", "mt-implementer-1"]]);
    // Still a proposal until someone answers; a run on it is refused.
    expect((await w.issues.list())._unsafeUnwrap()[0]?.status).toBe("proposed");
    const refusedStart = await w.issues.start("i001", { workflow: "demo", worktree: false });
    expect(refusedStart.isErr() && refusedStart.error.message).toContain("a proposal");
    (
      await w.journal.answer(run.runId, "q001", { choices: [PROPOSAL_ADD], by: "maciej", origin: "inbox" })
    )._unsafeUnwrap();
    const after = (await w.issues.show("i001"))._unsafeUnwrap();
    expect(after).toMatchObject({ status: "open", decidedBy: { by: "maciej", decision: "added" } });
    // Dropped from the inbox.
    const second = (
      await w.issues.propose({ title: "Edge test 1000.00", agent: "mt-plan-critic", runId: run.runId })
    )._unsafeUnwrap();
    (
      await w.journal.answer(run.runId, second.questionId, { choices: [PROPOSAL_DROP], by: "maciej" })
    )._unsafeUnwrap();
    expect((await w.issues.show("i002"))._unsafeUnwrap().status).toBe("dropped");
    // Decided from the CLI instead of the inbox.
    const third = (
      await w.issues.propose({ title: "Docs for pricing", agent: "mt-planner", runId: run.runId })
    )._unsafeUnwrap();
    expect(
      (
        await w.issues.decide(third.issue.id, { by: "maciej", decision: "add", priority: "low" })
      )._unsafeUnwrap(),
    ).toMatchObject({ status: "open", priority: "low" });
    expect((await w.issues.decide(third.issue.id, { by: "maciej", decision: "add" })).isErr()).toBe(true);
    // Proposals can be switched off.
    const off = world(false);
    const r = (await off.init("x"))._unsafeUnwrap();
    const refused = await off.issues.propose({ title: "no", agent: "a", runId: r.runId });
    expect(refused.isErr() && refused.error.message).toContain("proposeFromAgents");
  });

  test("at the same time: two adds get two ids, and two starts of one task make one run (R6)", async () => {
    const w = world();
    const added = await Promise.all(
      ["one", "two", "three"].map((title) => w.issues.add({ title, by: "maciej" })),
    );
    expect(added.map((a) => a._unsafeUnwrap().id).sort()).toEqual(["i001", "i002", "i003"]);
    expect((await w.issues.list())._unsafeUnwrap().map((i) => i.title)).toHaveLength(3);
    const starts = await Promise.all([
      w.issues.start("i001", { workflow: "demo", worktree: false }),
      w.issues.start("i001", { workflow: "demo", worktree: false }),
    ]);
    expect(starts.map((s) => s.isOk()).sort()).toEqual([false, true]);
    const won = starts.find((s) => s.isOk())?._unsafeUnwrap();
    expect(starts.find((s) => s.isErr())?._unsafeUnwrapErr().message).toContain(
      `its run ${won?.runId} is still active`,
    );
    expect(await w.repo.list()).toEqual([won?.runId as string]);
  });

  test("start makes a run on the task (title and body), the issue is in progress and remembers the run; 'Add and start' does both", async () => {
    const w = world();
    const added = (
      await w.issues.add({ title: "PDF cents", body: "Round sums to cents.", by: "maciej" })
    )._unsafeUnwrap();
    const started = (await w.issues.start(added.id, { workflow: "demo", worktree: false }))._unsafeUnwrap();
    expect(started.issue).toMatchObject({ status: "in-progress", runId: started.runId });
    const record = (await w.repo.load(started.runId))._unsafeUnwrap();
    expect(record.task).toBe("PDF cents\n\nRound sums to cents.");
    expect((await w.issues.list({ runId: started.runId }))._unsafeUnwrap().map((i) => i.id)).toEqual([
      added.id,
    ]);
    // A task whose run is still active is not started again: the refusal names the run (R6).
    const again = (await w.issues.start(added.id, { workflow: "demo", worktree: false }))._unsafeUnwrapErr();
    expect(again.code).toBe("USAGE");
    expect(again.message).toBe(
      `issue ${added.id} is already in progress: its run ${started.runId} is still active`,
    );
    expect(again.hint).toContain(`metator run continue --run ${started.runId}`);
    expect((await w.issues.show(added.id))._unsafeUnwrap().runId).toBe(started.runId);
    // Once that run has ended, another run on the task is allowed; one with a worktree needs one wired.
    (
      await w.advance.execute({ runId: started.runId, event: { type: "ABORT", reason: "no" } })
    )._unsafeUnwrap();
    expect((await w.issues.start(added.id, { workflow: "demo" })).isErr()).toBe(true);
    const second = (await w.issues.start(added.id, { workflow: "demo", worktree: false }))._unsafeUnwrap();
    expect(second.runId).not.toBe(started.runId);
    const run = (await w.init("Add the discount"))._unsafeUnwrap();
    const proposed = (
      await w.issues.propose({ title: "Edge test", agent: "mt-plan-critic", runId: run.runId })
    )._unsafeUnwrap();
    (
      await w.journal.answer(run.runId, proposed.questionId, { choices: [PROPOSAL_START], by: "maciej" })
    )._unsafeUnwrap();
    const after = (await w.issues.show(proposed.issue.id))._unsafeUnwrap();
    expect(after.status).toBe("in-progress");
    expect(after.runId).toBeDefined();
    expect((await w.repo.load(after.runId as string))._unsafeUnwrap().task).toBe("Edge test");
  });
});
