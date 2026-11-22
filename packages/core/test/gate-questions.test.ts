import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { GateQuestions, gateQuestionOf, publishQuestion } from "../src/application/gate-questions.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, ApproveRun, InitRun, ResumeRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";

const FLOW = `kind: Workflow
schemaVersion: 2
id: flow
stages:
  - id: plan
    produces: [plan.md]
  - id: plan-approval
    description: The human approves the plan
    hitl: true
    onFail: { goto: plan, loop: plan }
  - id: build
loops: { plan: 2 }
`;

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/flow.yml": FLOW });
  const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const gates = new GateQuestions({ catalog, repo, journal, fs });
  const advance = new AdvanceRun(catalog, repo, clock, journal, gates);
  const approve = new ApproveRun(advance, repo, clock, catalog);
  const start = async () =>
    (
      await new InitRun(catalog, repo, clock).execute({ workflow: "flow", task: "Add currency to prices" })
    )._unsafeUnwrap().runId;
  const open = async (runId: string) =>
    (await journal.questions(runId))._unsafeUnwrap().filter((q) => !q.answer && q.source === "gate");
  return { fs, clock, catalog, repo, journal, gates, advance, approve, start, open };
}

describe("a human gate always has its question (any driver: a drive, a conductor, a person)", () => {
  test("advancing into a hitl stage asks its gate once; the prompt is the drive's own", async () => {
    const w = world();
    const runId = await w.start();
    expect(await w.open(runId)).toEqual([]);
    (await w.advance.execute({ runId, event: { type: "PASS" } }))._unsafeUnwrap();
    const asked = await w.open(runId);
    expect(asked.map((q) => [q.stage, q.source, q.prompt, q.options.map((o) => o.label)])).toEqual([
      [
        "plan-approval",
        "gate",
        "The human approves the plan: approve to continue",
        ["Approve", "Reject", "Other"],
      ],
    ]);
    expect(asked[0]?.card?.task).toBe("Add currency to prices");
    // Asking again for the same visit finds the same question (a drive that starts later, a retry).
    (await w.gates.ask(runId))._unsafeUnwrap();
    expect((await w.open(runId)).map((q) => q.id)).toEqual([asked[0]?.id as string]);
    expect(gateQuestionOf({ id: "x", description: "Go?" }).prompt).toBe("Go?: approve to continue");
  });

  test("approving settles it; a second visit (rejected, planned again) asks again", async () => {
    const w = world();
    const runId = await w.start();
    await w.advance.execute({ runId, event: { type: "PASS" } });
    (await w.approve.execute({ runId, gate: "plan-approval", by: "ana" }))._unsafeUnwrap();
    expect(await w.open(runId)).toEqual([]);

    const other = await w.start();
    await w.advance.execute({ runId: other, event: { type: "PASS" } });
    const first = (await w.open(other))[0];
    await w.journal.answer(other, first?.id as string, {
      choices: ["Reject"],
      text: "no fallback",
      by: "ana",
    });
    await w.advance.execute({ runId: other, event: { type: "FAIL", reason: "no fallback" } });
    w.clock.advance(60_000);
    await w.advance.execute({ runId: other, event: { type: "PASS" } });
    const again = await w.open(other);
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(first?.id);
  });

  test("a stage that is no human gate, or a run that ended, asks nothing", async () => {
    const w = world();
    const runId = await w.start();
    expect((await w.gates.ask(runId))._unsafeUnwrap()).toBeUndefined();
    await w.advance.execute({ runId, event: { type: "ABORT", reason: "no" } });
    expect((await w.gates.ask(runId))._unsafeUnwrap()).toBeUndefined();
    expect(await w.open(runId)).toEqual([]);
  });

  test("a resume back into a human gate asks it too", async () => {
    const w = world();
    const runId = await w.start();
    await w.advance.execute({ runId, event: { type: "PASS" } });
    // Escalated at the gate (an abort of the stage's loop): rejected until the loop is spent.
    for (let i = 0; i < 3; i++) {
      const r = await w.advance.execute({ runId, event: { type: "FAIL", reason: "no" } });
      if ((await w.repo.load(runId))._unsafeUnwrap().state.status === "escalated") break;
      r._unsafeUnwrap();
      await w.advance.execute({ runId, event: { type: "PASS" } });
    }
    const escalated = (await w.repo.load(runId))._unsafeUnwrap();
    expect([escalated.state.status, escalated.state.context.history.at(-1)?.stage]).toEqual([
      "escalated",
      "plan-approval",
    ]);
    for (const q of await w.open(runId))
      await w.journal.answer(runId, q.id, { choices: ["Reject"], text: "x", by: "ana" });
    w.clock.advance(60_000);
    (await new ResumeRun(w.catalog, w.repo, w.clock, w.gates).execute({ runId, by: "ana" }))._unsafeUnwrap();
    expect((await w.open(runId)).map((q) => q.stage)).toEqual(["plan-approval"]);
  });

  test("a gate that grants comment is the publish card once the verdict is there (ADR-0097); Approve means Yes", async () => {
    const fs = new InMemoryFileSystem({
      "run/verdict.json": JSON.stringify({
        kind: "Verdict",
        schemaVersion: 1,
        decision: "CHANGES_REQUIRED",
        blocking: [
          {
            id: "LOGIC-001",
            lens: "logic",
            severity: "blocking",
            confidence: 0.9,
            location: { file: "a.ts", line: 2 },
            quote: "x",
            claim: "a claim of ten chars",
          },
        ],
        unverified: [],
        consider: [],
        verifiedCorrect: [],
      }),
    });
    const stage = { id: "approval", grants: ["comment" as const] };
    const pr = { pr: "https://github.com/acme/shop/pull/45" };
    expect(await publishQuestion(fs, "run", stage, pr)).toBe(
      "Publish the review of MR #45? (1 inline comment, 0 general)",
    );
    expect(await publishQuestion(fs, "run", stage, {})).toBe(
      "Publish the review? (1 inline comment, 0 general)",
    );
    expect(await publishQuestion(fs, "run", {}, pr)).toBeUndefined();
    expect(await publishQuestion(fs, "none", stage, pr)).toBeUndefined();
    const card = gateQuestionOf(
      { id: "approval" },
      "Publish the review of MR #45? (1 inline comment, 0 general)",
    );
    expect(card.prompt).toBe("Publish the review of MR #45? (1 inline comment, 0 general)");
    expect(card.options.map((o) => [o.label, o.description.split(":")[0]])).toEqual([
      ["Approve", "Yes"],
      ["Reject", "No"],
    ]);
  });
});
