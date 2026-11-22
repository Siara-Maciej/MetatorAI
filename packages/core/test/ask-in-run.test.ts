import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem, InstantTimer } from "@metator/testing";
import { AskInRun } from "../src/application/ask-in-run.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n  - id: check\n    owner: mt-verifier\n";

async function world(onWait?: (w: { journal: RunJournal; runId: string }) => Promise<void>) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-18T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const run = (
    await new InitRun(catalog, repo, clock).execute({ workflow: "demo", task: "Round" })
  )._unsafeUnwrap();
  const timer = new InstantTimer(async () => onWait?.({ journal, runId: run.runId }));
  const ask = new AskInRun(repo, journal, timer);
  return { ask, journal, runId: run.runId, timer, advance: new AdvanceRun(catalog, repo, clock) };
}

describe("AskInRun: an agent in a terminal asks the person and waits for the answer", () => {
  test("asked at the run's stage, by the agent, with its options; --wait returns the answer as soon as it is recorded", async () => {
    let waits = 0;
    const w = await world(async ({ journal, runId }) => {
      if (++waits === 3) await journal.answer(runId, "q001", { choices: ["EUR"], by: "ana" });
    });
    const r = (
      await w.ask.execute({
        runId: w.runId,
        prompt: "Which currency?",
        options: ["PLN", "EUR"],
        agent: "mt-implementer-1",
        wait: true,
        pollMs: 500,
      })
    )._unsafeUnwrap();
    expect([
      r.question.stage,
      r.question.source,
      r.question.agent,
      r.question.options.map((o) => o.label),
    ]).toEqual(["build", "agent", "mt-implementer-1", ["PLN", "EUR", "Other"]]);
    expect(r.answer).toMatchObject({ choices: ["EUR"], by: "ana" });
    expect(waits).toBe(3);
  });

  test("without --wait it only asks; waiting on an asked question by its id works later", async () => {
    let answer = false;
    const w = await world(async ({ journal, runId }) => {
      if (answer) await journal.answer(runId, "q001", { choices: ["Other"], text: "zloty", by: "ana" });
    });
    const asked = (
      await w.ask.execute({ runId: w.runId, prompt: "Which currency?", options: ["PLN"] })
    )._unsafeUnwrap();
    expect([asked.question.id, asked.answer, w.timer.waits]).toEqual(["q001", undefined, 0]);
    answer = true;
    const later = (await w.ask.wait({ runId: w.runId, question: "q001", pollMs: 100 }))._unsafeUnwrap();
    expect(later.answer).toMatchObject({ choices: ["Other"], text: "zloty" });
  });

  test("no answer within the timeout is WAITING with the command to wait again; the run moving on ends the wait", async () => {
    const w = await world();
    const late = (
      await w.ask.execute({
        runId: w.runId,
        prompt: "Which currency?",
        options: ["PLN"],
        wait: true,
        timeoutMs: 1000,
        pollMs: 250,
      })
    )._unsafeUnwrapErr();
    expect([late.code, late.message, late.hint]).toEqual([
      "WAITING",
      "q001 has no answer after 1 s",
      `Wait again: \`metator run ask --question q001 --wait --run ${w.runId}\`.`,
    ]);
    let moved = false;
    const m = await world(async () => {
      if (!moved) {
        moved = true;
        (await m.advance.execute({ runId: m.runId, event: { type: "PASS" } }))._unsafeUnwrap();
      }
    });
    const gone = (
      await m.ask.execute({ runId: m.runId, prompt: "Which currency?", options: ["PLN"], wait: true })
    )._unsafeUnwrapErr();
    expect([gone.code, gone.message]).toEqual([
      "CONFLICT",
      "the run left build while q001 waited: nobody will answer it",
    ]);
    expect((await m.ask.wait({ runId: m.runId, question: "q404" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });
});
