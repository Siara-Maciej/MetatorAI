import { describe, expect, test } from "bun:test";
import type { Overview, Question, RunOverview } from "@metator/core";
import {
  duration,
  fit,
  nextStep,
  renderAsked,
  renderAsking,
  renderCommandHelp,
  renderDoctor,
  renderInbox,
  renderIssues,
  renderPlanRun,
  renderPlanShow,
  renderPlanStatus,
  renderRunStatus,
  renderStatus,
  renderThread,
  renderThreadTree,
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
    phase: "in-progress",
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

  test("status in a folder: a repository with worktrees is counted once, its worktrees' runs under it", () => {
    const none = { runs: [], conversations: [], counts, unreadable: [] };
    const text = renderStatus({
      folder: "/work",
      repos: [
        {
          name: "shop",
          ...none,
          worktrees: [{ label: "shop (fix-tax)", ...none, runs: [runOf("a")] }],
        },
      ],
      counts,
    });
    expect(text.split("\n").slice(0, 5)).toEqual([
      "/work · 1 repository",
      "1 need you · 0 working · 1 stopped · 2 services",
      "",
      "shop · 1 worktree",
      "  no runs yet: `metator run` starts one",
    ]);
    expect(text).toContain("\n\nshop (fix-tax)\n‖ 20261028-mt-feature-a");
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

  test("inbox: the questions of panes the daemon owns, a host's approval with the guard's reason", () => {
    const text = renderInbox({
      decisions: [],
      escalated: [],
      panes: [
        {
          paneId: "w1:p1",
          label: "chat",
          host: "claude",
          question: {
            id: "p001",
            source: "permission",
            prompt: 'git commit -m "x" — This command requires approval',
            command: 'git commit -m "x"',
            reason: "`git commit -m x` needs your consent",
            askedAt: "2026-11-22T10:00:00.000Z",
            options: [{ label: "Yes" }, { label: "No" }, { label: "Leave it" }],
          },
        },
        {
          paneId: "w2:p1",
          repo: "shop",
          label: "chat",
          host: "copilot",
          question: {
            id: "p002",
            source: "agent",
            prompt: "Which colour?",
            askedAt: "2026-11-22T10:01:00.000Z",
            options: [{ label: "a) red" }, { label: "b) blue" }],
          },
        },
      ],
    });
    expect(text.split("\n")).toEqual([
      "? chat (pane w1:p1) · claude asks for approval",
      '    git commit -m "x" — This command requires approval',
      "    why: `git commit -m x` needs your consent",
      "    Yes / No / Leave it",
      "    answer it on Home in the app, or in pane w1:p1",
      "? shop · chat (pane w2:p1) · copilot asks",
      "    Which colour?",
      "    a) red / b) blue",
      "    answer it on Home in the app, or in pane w2:p1",
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

describe("the text a person reads for plans, questions and the backlog", () => {
  const plan = {
    id: "prices",
    task: "Prices with tax",
    status: "running",
    approval: { by: "ana", at: "2026-11-18T10:00:00.000Z", digest: "x" },
    steps: [
      { id: "tax-rates", app: "billing", summary: "Tax rates", dependsOn: [], status: "done", run: "r-tax" },
      {
        id: "price-model",
        app: "shop-api",
        summary: "A price carries currency",
        dependsOn: [],
        status: "running",
        run: "r-price",
      },
      {
        id: "price-tag",
        app: "shop-web",
        summary: "Show it",
        dependsOn: ["tax-rates", "price-model"],
        status: "pending",
      },
    ],
  };

  test("system plan status: the waves, each step with its repository, state and run", () => {
    const text = renderPlanStatus({
      plan,
      steps: [
        {
          id: "tax-rates",
          app: "billing",
          status: "done",
          run: "r-tax",
          runStatus: "done",
          stage: "delivery",
        },
        {
          id: "price-model",
          app: "shop-api",
          status: "running",
          run: "r-price",
          runStatus: "escalated",
          stage: "build",
        },
        { id: "price-tag", app: "shop-web", status: "pending" },
      ],
    } as never);
    expect(text.split("\n")).toEqual([
      "prices · running · approved by ana",
      "  Prices with tax",
      "  Wave 1",
      "    ✓ tax-rates    billing   done     r-tax (done)",
      "    ! price-model  shop-api  running  r-price (escalated at build)",
      "  Wave 2",
      "    · price-tag    shop-web  pending  not started",
    ]);
  });

  test("system plan show: the waves with each step's summary and what it waits for", () => {
    const text = renderPlanShow({
      plan,
      waves: [["tax-rates", "price-model"], ["price-tag"]],
      analysis: null,
    } as never);
    expect(text).toContain("  Wave 2\n    price-tag  shop-web  Show it  (after tax-rates, price-model)");
  });

  test("run ask: the question with its options, then the answer and who gave it", () => {
    const question = {
      id: "q003",
      prompt: "Ship behind a flag?",
      options: [{ label: "yes" }, { label: "no" }, { label: "Other" }],
    };
    expect(renderAsking(question as never)).toBe(
      "q003 · Ship behind a flag?\n  options: yes · no · Other\n  waiting for an answer…",
    );
    expect(
      renderAsked({
        question,
        answer: { choices: ["Other"], text: "after the release", by: "ana", at: "t" },
      } as never),
    ).toBe("q003 · Ship behind a flag?\n  answer: after the release · ana");
    expect(renderAsked({ question } as never)).toBe(
      "q003 · Ship behind a flag?\n  options: yes · no · Other\n  asked: it waits in the person's inbox",
    );
  });

  test("issue list: one line per task, the most pressing first, with its run", () => {
    const text = renderIssues({
      issues: [
        { id: "i002", title: "Sold-out products", status: "in-progress", priority: "high", runId: "r-sold" },
        { id: "i001", title: "Contract test", status: "proposed", priority: "normal" },
      ],
    } as never);
    expect(text.split("\n")).toEqual([
      "i002  in-progress  high    Sold-out products  → r-sold",
      "i001  proposed     normal  Contract test",
    ]);
  });
});

describe("system plan status as the system run's gate (--gate)", () => {
  test("the gate's answer (no plan in it) renders as its message; it never throws", () => {
    const gate = {
      kind: "pass",
      message: "every step is done",
      steps: [{ id: "a", app: "web", status: "done" }],
    };
    expect(renderPlanStatus(gate as never)).toBe("every step is done");
  });
});

describe("renderPlanRun", () => {
  test("each started step with its run and how it started: a session's pane, else the drive and why", () => {
    const text = renderPlanRun({
      plan: { id: "add-a-badge" },
      started: [
        { step: "api-badge", app: "api", run: "r1", session: { paneId: "w1:p1", host: "claude" } },
        {
          step: "web-badge",
          app: "web",
          run: "r2",
          noSession: "no daemon runs for this repository",
          drive: { stage: "setup", started: true, host: "claude" },
        },
        {
          step: "ios-badge",
          app: "ios",
          run: "r3",
          noSession: "x",
          driveError: "AI host claude cannot start here",
        },
      ],
    });
    expect(text.split("\n")).toEqual([
      "add-a-badge: started 3 step(s)",
      "  api-badge  api  r1  session in pane w1:p1 on claude",
      "  web-badge  web  r2  driven in the background on claude: no daemon runs for this repository",
      "  ios-badge  ios  r3  waits for a person: AI host claude cannot start here",
    ]);
    expect(renderPlanRun({ plan: { id: "p" }, started: [] })).toBe("p: no step can start yet");
  });
});

describe("threads as a person reads them (ADR-0095)", () => {
  const thread = {
    id: "20261122-prices",
    title: "Price rounding",
    state: "open",
    summary: "Decided: round half up.\nOpen: the invoice total.",
    facts: [{ at: "2026-11-22T10:05:00.000Z", text: "run 20261122-demo-round started: Round prices" }],
    issues: [],
    tasks: [
      {
        runId: "20261122-demo-round",
        task: "Round prices",
        stage: "plan-approval",
        attention: "you" as const,
      },
    ],
    attention: "you" as const,
    chat: { paneId: "w1:p2", status: "live" },
  };

  test("thread show: the topic, the summary, the runs with their state, the facts", () => {
    expect(renderThread(thread)).toBe(
      [
        "Price rounding  (20261122-prices, open, chat w1:p2 live)",
        "",
        "Summary:",
        "  Decided: round half up.",
        "  Open: the invoice total.",
        "",
        "Runs (1):",
        "  ? 20261122-demo-round  needs you at plan-approval  Round prices",
        "",
        "Facts:",
        "  2026-11-22 10:05  run 20261122-demo-round started: Round prices",
      ].join("\n"),
    );
    expect(renderThread({ ...thread, summary: "", tasks: [], facts: [] })).toContain(
      "(none yet: write one with `metator thread summary --text …`)",
    );
  });

  test("thread list: open threads with their tasks, then the runs without a chat, then the closed ones", () => {
    const text = renderThreadTree({
      threads: [thread],
      withoutChat: [
        { runId: "20261122-demo-footer", task: "Fix the footer", stage: "build", attention: "driving" },
      ],
      closed: [{ ...thread, id: "20261121-old", title: "Old topic", state: "closed", tasks: [] }],
    });
    expect(text.split("\n")).toEqual([
      "? Price rounding  (20261122-prices, 1 tasks)",
      "    ? 20261122-demo-round  needs you at plan-approval  Round prices",
      "",
      "Without a chat:",
      "    ⟳ 20261122-demo-footer  working at build  Fix the footer",
      "",
      "Closed (1):",
      "  Old topic  (20261121-old)",
    ]);
    expect(renderThreadTree({ threads: [], withoutChat: [], closed: [] })).toBe("No open thread.");
  });
});
