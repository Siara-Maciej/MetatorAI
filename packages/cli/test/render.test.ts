import { describe, expect, test } from "bun:test";
import type { Overview, Question, RunOverview } from "@metator/core";
import {
  duration,
  fit,
  nextStep,
  renderCommandHelp,
  renderDoctor,
  renderInbox,
  renderRunStatus,
  renderStatus,
  stageBar,
} from "../src/render.ts";

const question = (runId: string): Question => ({
  id: "q001",
  runId,
  stage: "build",
  source: "agent",
  agent: "mt-implementer",
  prompt: "Which rounding?",
  options: [{ label: "Half up" }, { label: "Banker's" }, { label: "Other" }],
  multiSelect: false,
  askedAt: "2026-10-28T10:00:00.000Z",
});

function runOf(id: string, over: Partial<RunOverview> = {}): RunOverview {
  return {
    runId: `20261028-mt-feature-${id}`,
    workflow: "mt-feature",
    task: `Task ${id}`,
    autonomy: "L0",
    status: "active",
    stage: "build",
    attention: "stopped",
    stages: [
      { id: "plan", state: "done", hitl: false },
      { id: "build", state: "current", hitl: false },
      { id: "review", state: "next", hitl: false },
    ],
    questions: [],
    driving: false,
    driver: "agent",
    died: false,
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    elapsedMs: 3_900_000,
    services: [],
    ...over,
  };
}

const counts = { you: 1, driving: 0, stopped: 1, escalated: 0, finished: 0, questions: 1, services: 2 };

describe("the text a person reads (render)", () => {
  test("stage bar, durations, the next step with its command, and fitting text", () => {
    expect(stageBar(runOf("a").stages)).toBe("plan ✓ ─ [build ⟳] ─ review ·");
    expect(
      stageBar([
        { id: "plan", state: "done", hitl: false },
        { id: "approval", state: "waiting", hitl: true },
        { id: "x", state: "stopped", hitl: false },
      ]),
    ).toBe("plan ✓ ─ [approval ?] ─ [x !]");
    expect([duration(45_000), duration(720_000), duration(3_900_000), duration(180_000_000)]).toEqual([
      "45 s",
      "12 min",
      "1 h 05 min",
      "2 d 2 h",
    ]);
    expect(nextStep(runOf("a", { attention: "you", questions: [question("x")] }))).toBe(
      "waits for you: Which rounding?  (metator run answer q001 --run 20261028-mt-feature-a --choice <label>)",
    );
    expect(nextStep(runOf("a", { attention: "you", stage: "plan-approval" }))).toBe(
      "waits at plan-approval: metator run approve plan-approval --by <name> --run 20261028-mt-feature-a",
    );
    expect(
      nextStep(runOf("a", { attention: "driving", last: { at: "x", type: "tool", text: "Edit a.ts" } })),
    ).toBe("working: Edit a.ts");
    expect(nextStep(runOf("a", { attention: "stopped", died: true, stage: "build" }))).toBe(
      "the drive died at build  (metator run continue 20261028-mt-feature-a)",
    );
    expect(nextStep(runOf("a", { attention: "escalated", status: "escalated" }))).toBe(
      "at build: fix the cause, then metator run resume --run 20261028-mt-feature-a --drive",
    );
    expect(nextStep(runOf("a", { attention: "done", status: "done" }))).toBe("every stage passed");
    expect(fit("a  b\nc", 10)).toBe("a b c");
    expect(fit("abcdefghijkl", 5)).toBe("abcd…");
  });

  test("status: the counts, then each run with its stages and what it needs; a folder by repository", () => {
    const overview: Overview = {
      runs: [runOf("a", { attention: "you", questions: [question("a")] }), runOf("b")],
      conversations: [{ id: "c1", title: "How is VAT rounded?", host: "claude", turns: 2, updatedAt: "x" }],
      counts,
      unreadable: [],
    };
    expect(renderStatus(overview).split("\n")).toEqual([
      "1 need you · 0 working · 1 stopped · 2 services",
      "",
      "? 20261028-mt-feature-a  needs you · mt-feature · 1 h 05 min",
      "    Task a",
      "    plan ✓ ─ [build ⟳] ─ review ·",
      "    waits for you: Which rounding?  (metator run answer q001 --run 20261028-mt-feature-a --choice <label>)",
      "‖ 20261028-mt-feature-b  stopped · mt-feature · 1 h 05 min",
      "    Task b",
      "    plan ✓ ─ [build ⟳] ─ review ·",
      "    stopped at build  (metator run continue 20261028-mt-feature-b)",
      "",
      "  Conversations",
      "  ✦ How is VAT rounded? · claude · 2 turn(s)",
    ]);
    const folder = renderStatus({
      folder: "/work/shop",
      repos: [
        { name: "orders", ...overview },
        { name: "billing", error: "metator.config.yml: bad" },
      ],
      counts: { ...counts, escalated: 1 },
    });
    expect(folder).toStartWith(
      "/work/shop · 2 repositories\n1 need you · 0 working · 1 stopped · 1 escalated · 2 services\n\norders\n",
    );
    expect(folder).toEndWith("\nbilling\n  ! metator.config.yml: bad");
    expect(renderStatus({ runs: [], conversations: [], counts, unreadable: [] })).toContain(
      "no runs yet: `metator run` starts one",
    );
  });

  test("inbox: each decision with the command that answers it, then the escalated runs", () => {
    expect(renderInbox({ decisions: [], escalated: [] })).toBe("Nothing waits for you.");
    const text = renderInbox({
      decisions: [
        {
          repo: "orders",
          runId: "r1",
          task: "T",
          stage: "build",
          driving: true,
          waitedMs: 720_000,
          question: question("r1"),
        },
      ],
      escalated: [
        {
          runId: "r2",
          task: "T2",
          stage: "check",
          reason: "gate failed",
          waitedMs: 45_000,
          next: ["metator run resume --run r2 --drive"],
        },
      ],
    });
    expect(text.split("\n")).toEqual([
      "? orders · r1 · build · waited 12 min · the run stands still",
      "    Which rounding?",
      "    Half up / Banker's / Other",
      "    metator run answer q001 --run r1 --choice <label>",
      "! r2 · escalated at check · waited 45 s",
      "    gate failed",
      "    metator run resume --run r2 --drive",
    ]);
  });

  test("run status: where it stands, what the stage expects, an escalation's way out, the last events", () => {
    const text = renderRunStatus({
      runId: "r1",
      workflow: "demo",
      task: "Fix rounding",
      autonomy: "L0",
      stage: "check",
      status: "escalated",
      expects: [],
      recent: [
        { stage: "plan", event: "PASS" },
        { stage: "check", event: "FAIL", detail: "gate failed" },
      ],
      worktree: { path: ".metator/wt/r1", branch: "metator/r1" },
      escalated: { stage: "check", reason: "gate failed", next: ["metator run resume --run r1 --drive"] },
    });
    expect(text.split("\n")).toEqual([
      "r1 · demo · L0",
      "  Fix rounding",
      "  escalated at check",
      "  worktree .metator/wt/r1 (metator/r1)",
      "  ! gate failed",
      "    metator run resume --run r1 --drive",
      "",
      "  Last events",
      "    plan · PASS",
      "    check · FAIL · gate failed",
    ]);
    expect(
      renderRunStatus({
        runId: "r1",
        workflow: "demo",
        task: "T",
        autonomy: "L1",
        stage: "plan",
        status: "active",
        expects: ["PASS", "FAIL"],
        recent: [],
      }),
    ).toBe("r1 · demo · L1\n  T\n  active at plan · expects PASS, FAIL");
  });

  test("doctor: a mark per check and the fix under the ones that have one", () => {
    const text = renderDoctor({
      ready: false,
      place: ".",
      checks: [
        { id: "config", status: "ok", message: "metator.config.yml" },
        { id: "workflows", status: "fail", message: "no workflow here", fix: "metator setup" },
        { id: "remote", status: "warn", message: "no git remote" },
      ],
    });
    expect(text.split("\n")).toEqual([
      ".: not ready for a run",
      "",
      "  ✓ config     metator.config.yml",
      "  ✗ workflows  no workflow here",
      "               fix: metator setup",
      "  ! remote     no git remote",
    ]);
    expect(renderDoctor({ ready: true, place: "wt", checks: [] })).toBe("wt: ready for a run\n");
  });

  test("a command's help: usage, summary, options with their defaults, a group's commands", () => {
    const text = renderCommandHelp({
      name: "run board",
      summary: "The plan board",
      usage: "metator run board [options] [run]",
      options: [
        { flags: "--run <id>", description: "run id (default: latest)" },
        { flags: "--timeline <n>", description: "how many events to keep", default: 30 },
      ],
      commands: [{ name: "run board x", summary: "sub" }],
    });
    expect(text.split("\n")).toEqual([
      "metator run board [options] [run]",
      "",
      "The plan board",
      "",
      "Options",
      "  --run <id>      run id (default: latest)",
      "  --timeline <n>  how many events to keep (default: 30)",
      "",
      "Commands",
      "  metator run board x  sub",
    ]);
  });
});
