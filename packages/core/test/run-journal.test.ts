import { describe, expect, test } from "bun:test";
import { DEFAULT_PATHS, InitRun, RunJournal, RunRepository, WorkflowCatalog } from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

async function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-25T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const run = (
    await new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock).execute({
      workflow: "demo",
      task: "x",
    })
  )._unsafeUnwrap();
  return { fs, repo, journal, runId: run.runId };
}

const question = (prompt: string) => ({
  stage: "build",
  source: "agent" as const,
  prompt,
  options: [{ label: "Yes", description: "go on" }],
  multiSelect: false,
});

describe("RunJournal", () => {
  test("questions asked at the same time get their own ids: none is written over", async () => {
    const w = await world();
    const asked = await Promise.all(
      ["Which rounding?", "Which currency?", "Which locale?"].map((p) => w.journal.ask(w.runId, question(p))),
    );
    expect(asked.map((a) => a._unsafeUnwrap().id).sort()).toEqual(["q001", "q002", "q003"]);
    const stored = (await w.journal.questions(w.runId))._unsafeUnwrap();
    expect(stored.map((q) => q.prompt).sort()).toEqual([
      "Which currency?",
      "Which locale?",
      "Which rounding?",
    ]);
    // One question asked twice at once is asked once: the second finds the first standing.
    const twice = await Promise.all([1, 2].map(() => w.journal.ask(w.runId, question("Ship it?"))));
    expect(twice.map((a) => a._unsafeUnwrap().id)).toEqual(["q004", "q004"]);
  });

  test("two answers to one question at the same time: the first counts, the second is refused", async () => {
    const w = await world();
    const q = (await w.journal.ask(w.runId, question("Ship it?")))._unsafeUnwrap();
    const answers = await Promise.all([
      w.journal.answer(w.runId, q.id, { choices: ["Yes"], by: "maciej" }),
      w.journal.answer(w.runId, q.id, { choices: ["Other"], text: "wait", by: "ola" }),
    ]);
    expect(answers.map((a) => a.isOk())).toEqual([true, false]);
    expect(answers[1]?._unsafeUnwrapErr().message).toBe(`question ${q.id} is already answered`);
    const stored = (await w.journal.questions(w.runId))._unsafeUnwrap()[0];
    expect(stored?.answer).toMatchObject({ choices: ["Yes"], by: "maciej" });
    const answersLogged = (await w.journal.activity(w.runId))
      ._unsafeUnwrap()
      .filter((a) => a.type === "answer");
    expect(answersLogged).toHaveLength(1);
  });

  test("a torn line in usage.jsonl is skipped: the run's other usage still reads", async () => {
    const w = await world();
    (
      await w.journal.recordUsage(w.runId, { stage: "build", agent: "a", ok: true, durationMs: 5 })
    )._unsafeUnwrap();
    (await w.fs.append(w.journal.usageFile(w.runId), '{"kind":"AgentUsage","schemaVer\n'))._unsafeUnwrap();
    (
      await w.journal.recordUsage(w.runId, { stage: "build", agent: "b", ok: false, durationMs: 7 })
    )._unsafeUnwrap();
    const usage = (await w.journal.usage(w.runId))._unsafeUnwrap();
    expect(usage.map((u) => u.agent)).toEqual(["a", "b"]);
  });
});
