import { describe, expect, test } from "bun:test";
import {
  BuildReport,
  DEFAULT_PATHS,
  duration,
  InitRun,
  RenderReport,
  ReviewFeedback,
  type ReviewReaction,
  RunJournal,
  RunRepository,
  reactionStats,
  renderReportHtml,
  WorkflowCatalog,
} from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const at = (m: number) => `2026-11-09T22:${String(m).padStart(2, "0")}:00.000Z`;
const reaction = (over: Partial<ReviewReaction>): ReviewReaction => ({
  at: at(40),
  finding: "LOGIC-001",
  pr: "42",
  state: "resolved",
  by: "maciej",
  ...over,
});

describe("reaction stats", () => {
  test("the last reaction per finding counts; dismissed share is among the decided; by lens and by PR", () => {
    const stats = reactionStats([
      reaction({ lens: "logic" }),
      reaction({ finding: "LOGIC-002", lens: "logic", state: "dismissed", at: at(41) }),
      reaction({ finding: "LOGIC-002", lens: "logic", state: "resolved", at: at(42) }),
      reaction({ finding: "TESTS-001", lens: "tests", state: "dismissed" }),
      reaction({ finding: "SEC-001", lens: "security", state: "open", pr: "43" }),
    ]);
    expect(stats).toMatchObject({ total: 4, resolved: 2, dismissed: 1, open: 1, dismissedShare: 0.333 });
    expect(stats.byLens.logic).toMatchObject({ total: 2, resolved: 2, dismissed: 0, dismissedShare: 0 });
    expect(stats.byLens.tests?.dismissedShare).toBe(1);
    expect(Object.keys(stats.byPr)).toEqual(["42", "43"]);
    expect(reactionStats([]).dismissedShare).toBe(0);
    expect([duration(500), duration(5000), duration(125_000), duration(7_300_000)]).toEqual([
      "500 ms",
      "5 s",
      "2 min 5 s",
      "2 h 1 min",
    ]);
  });
});

describe("ReviewFeedback and RenderReport", () => {
  test("reactions append one line each and read back; the dashboard carries the runs, the agents and the dismissed share", async () => {
    const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
    const clock = new FixedClock(new Date(at(40)));
    const repo = new RunRepository(fs, DEFAULT_PATHS);
    const journal = new RunJournal(fs, repo, clock);
    const run = (
      await new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock).execute({
        workflow: "demo",
        task: "Add the discount",
      })
    )._unsafeUnwrap();
    (
      await journal.recordUsage(run.runId, {
        stage: "build",
        agent: "mt-implementer",
        ok: true,
        durationMs: 12_000,
        costUsd: 0.5,
      })
    )._unsafeUnwrap();
    const feedback = new ReviewFeedback(fs, DEFAULT_PATHS, clock);
    expect((await feedback.stats())._unsafeUnwrap().total).toBe(0);
    (
      await feedback.record({
        finding: "LOGIC-001",
        pr: "42",
        state: "resolved",
        by: "maciej",
        lens: "logic",
      })
    )._unsafeUnwrap();
    (
      await feedback.record({
        finding: "LOGIC-002",
        pr: "42",
        state: "dismissed",
        by: "maciej",
        reason: "intended",
      })
    )._unsafeUnwrap();
    expect((await feedback.record({ finding: "", pr: "42", state: "open", by: "x" })).isErr()).toBe(true);
    const text = (await fs.read(".metator/telemetry/reactions.jsonl"))._unsafeUnwrap();
    expect(text.split("\n").filter((l) => l !== "")).toHaveLength(2);
    expect(JSON.parse(text.split("\n")[0] as string)).toMatchObject({
      kind: "ReviewReaction",
      schemaVersion: 1,
      finding: "LOGIC-001",
    });
    expect((await feedback.stats())._unsafeUnwrap()).toMatchObject({
      total: 2,
      resolved: 1,
      dismissed: 1,
      dismissedShare: 0.5,
    });
    const render = new RenderReport(new BuildReport(repo, journal, clock), feedback, fs, clock);
    const out = (await render.execute({ out: "report.html" }))._unsafeUnwrap();
    expect(out).toMatchObject({ output: "report.html", runs: 1, reactions: 2 });
    const html = (await fs.read("report.html"))._unsafeUnwrap();
    expect(html).toContain(run.runId);
    expect(html).toContain("<td>mt-implementer</td>");
    expect(html).toContain("$0.50");
    expect(html).toContain("50%");
    expect(html).toContain("above the 15% line");
    expect(
      renderReportHtml(
        {
          runs: [],
          totals: {
            calls: 0,
            agentMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costUsd: 0,
            runs: 0,
            done: 0,
            questions: 0,
            byPolicy: 0,
            personWaitMs: 0,
            failures: 0,
          },
          agents: [],
        },
        reactionStats([]),
        clock.now(),
      ),
    ).toContain("no reactions recorded");
    expect(
      renderReportHtml(
        {
          runs: [],
          totals: {
            calls: 0,
            agentMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costUsd: 0,
            runs: 0,
            done: 0,
            questions: 0,
            byPolicy: 0,
            personWaitMs: 0,
            failures: 0,
          },
          agents: [
            {
              agent: "<b>",
              calls: 1,
              agentMs: 1,
              inputTokens: 0,
              outputTokens: 0,
              cachedTokens: 0,
              costUsd: 0,
              failed: 0,
              questions: 0,
            },
          ],
        },
        reactionStats([]),
        clock.now(),
      ),
    ).toContain("&lt;b&gt;");
  });
});
