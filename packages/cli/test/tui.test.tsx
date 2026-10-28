import { describe, expect, test } from "bun:test";
import type { Conversation, Overview, Question, RunOverview } from "@metator/core";
import { render } from "ink-testing-library";
import { App, type Exit } from "../src/tui/App.tsx";
import { duration, fit, nextStep, rowsOf, type Snapshot, stageBar, totals } from "../src/tui/model.ts";
import type { Launch, Settings, TuiService } from "../src/tui/service.ts";

const KEY = { down: "\u001B[B", up: "\u001B[A", enter: "\r", tab: "\t", esc: "\u001B" };
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** Waits until the condition holds (the screen shows a text, an action was called); fails after 3 s. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (ok()) return;
    await tick(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/**
 * Waits for a text on the screen, then a moment more: a component that just appeared attaches its
 * key handler in an effect after its first frame, and keys sent before that are lost.
 */
const shows = async (r: { lastFrame: () => string | undefined }, text: string) => {
  await until(`"${text}" on the screen`, () => (r.lastFrame() ?? "").includes(text));
  await tick(50);
};

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
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    elapsedMs: 3_900_000,
    services: [],
    ...over,
  };
}

function overview(runs: RunOverview[], conversations: Overview["conversations"] = []): Overview {
  const n = (a: string) => runs.filter((r) => r.attention === a).length;
  return {
    runs,
    conversations,
    counts: {
      you: n("you"),
      driving: n("driving"),
      stopped: n("stopped"),
      finished: 0,
      questions: runs.reduce((k, r) => k + r.questions.length, 0),
      services: 0,
    },
  };
}

const ASKED = {
  id: "q",
  runId: "20261028-mt-feature-rounding",
  question: question("20261028-mt-feature-rounding"),
};

class FakeService implements TuiService {
  calls: string[] = [];
  snapshots: Snapshot[];
  launchResult: Launch | string | null = null;
  constructor(snapshots: Snapshot[]) {
    this.snapshots = snapshots;
  }
  async snapshot() {
    return (this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0]) as Snapshot;
  }
  async activity() {
    return [
      {
        at: "2026-10-28T10:01:02.000Z",
        type: "tool" as const,
        agent: "mt-implementer",
        text: "Edit src/round.ts",
      },
    ];
  }
  async conversation(_repo: string, id: string): Promise<Conversation> {
    return {
      id,
      title: "How is VAT computed?",
      host: "scenario",
      createdAt: "2026-10-28T10:00:00.000Z",
      updatedAt: "2026-10-28T10:00:00.000Z",
      turns: [
        {
          at: "2026-10-28T10:00:00.000Z",
          by: "m",
          question: "How is VAT computed?",
          answer: "In src/vat.ts:3.",
          ok: true,
          citations: [{ path: "src/vat.ts", line: 3, exists: false }],
        },
      ],
    };
  }
  async answer(_r: string, q: Question, choices: readonly string[], text?: string) {
    this.calls.push(`answer ${q.id} ${choices.join("+")}${text ? ` "${text}"` : ""}`);
    return null;
  }
  async decideGate(_r: string, runId: string, stage: string, approve: boolean, reason?: string) {
    this.calls.push(`gate ${runId.slice(-4)} ${stage} ${approve ? "approve" : `reject ${reason}`}`);
    return null;
  }
  async continueRun(_r: string, runId: string) {
    this.calls.push(`continue ${runId.slice(-4)}`);
    return null;
  }
  async stopRun(_r: string, runId: string) {
    this.calls.push(`stop ${runId.slice(-4)}`);
    return null;
  }
  async runOptions() {
    return {
      workflows: [{ id: "mt-feature", description: "A feature" }],
      hosts: ["claude", "scenario"],
      defaultHost: "claude",
    };
  }
  async newRun(_r: string, input: { workflow: string; task: string; host: string; worktree: boolean }) {
    this.calls.push(`new ${input.workflow} "${input.task}" ${input.host} ${input.worktree}`);
    return { runId: "20261028-mt-feature-new" };
  }
  async ask(_r: string, q: string, conv: string | undefined, onText: (t: string) => void) {
    this.calls.push(`ask "${q}"${conv ? ` in ${conv}` : ""}`);
    onText("Streaming answer line");
    await tick(150);
    return { conversation: "20261028-why" };
  }
  async apps(_r: string, wt: string, op: string) {
    this.calls.push(`apps ${op} ${wt}`);
    return null;
  }
  async settings(): Promise<Settings> {
    return {
      editors: [{ command: "code", label: "VS Code" }],
      hostTargets: ["claude"],
      allHosts: ["claude", "copilot"],
      file: "metator.config.yml",
    };
  }
  async saveSettings(_r: string, changes: object) {
    this.calls.push(`save ${JSON.stringify(changes)}`);
    return null;
  }
  async open(kind: string) {
    this.calls.push(`open ${kind}`);
    return this.launchResult;
  }
  async launch() {
    return null;
  }
}

const snap = (runs: RunOverview[], conversations: Overview["conversations"] = []): Snapshot => ({
  title: "shop",
  repos: [{ name: "shop", root: "/r/shop", overview: overview(runs, conversations) }],
});

function app(service: FakeService) {
  const exits: Exit[] = [];
  let bells = 0;
  const r = render(
    <App service={service} refreshMs={40} onExit={(e) => exits.push(e)} bell={() => bells++} />,
  );
  return { ...r, exits, bells: () => bells };
}

describe("tui model", () => {
  test("rows: runs by repository in a folder, then conversations; totals add up", () => {
    const s: Snapshot = {
      title: "work",
      folderRoot: "/w",
      repos: [
        { name: "shop", root: "/w/shop", overview: overview([runOf("a", { attention: "you" })]) },
        { name: "billing", root: "/w/billing", error: "invalid config" },
      ],
      folderConversations: [
        { id: "c1", title: "Which repos call billing?", host: "claude", turns: 1, updatedAt: "x" },
      ],
    };
    expect(rowsOf(s).map((r) => (r.kind === "heading" ? `# ${r.text}` : r.key))).toEqual([
      "# shop",
      "/w/shop#20261028-mt-feature-a",
      "# billing · invalid config",
      "# Conversations",
      "/w~c1",
    ]);
    expect(totals(s)).toMatchObject({ you: 1, stopped: 0 });
  });

  test("stage bar, durations, the next step and fitting text", () => {
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
      "waits for you: Which rounding?  (a: answer)",
    );
    expect(nextStep(runOf("a", { attention: "you", stage: "plan-approval" }))).toBe(
      "waits at plan-approval: approve it (a) or continue the run (c)",
    );
    expect(
      nextStep(runOf("a", { attention: "driving", last: { at: "x", type: "tool", text: "Edit a.ts" } })),
    ).toBe("working: Edit a.ts");
    expect(fit("a  b\nc", 10)).toBe("a b c");
    expect(fit("abcdefghijkl", 5)).toBe("abcd…");
  });
});

const calls = (s: FakeService, n: number) => until(`${n} call(s)`, () => s.calls.length >= n);

describe("metator ui (components)", () => {
  test("the first screen: counts, sessions who-acts-first, and the selected run's progress", async () => {
    const s = new FakeService([
      snap([
        runOf("rounding", { attention: "you", questions: [ASKED.question] }),
        runOf("docs", { attention: "driving", driving: true, host: "claude" }),
      ]),
    ]);
    const r = app(s);
    await shows(r, "Questions for you (1)");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("MetatorAI · shop");
    expect(f).toContain("1 need you · 1 driving");
    expect(f.indexOf("Task rounding")).toBeLessThan(f.indexOf("Task docs"));
    expect(f).toContain("waits for you: Which rounding?");
    expect(f).toContain("plan ✓ ─ [build ⟳] ─ review ·");
    r.unmount();
  });

  test("move, switch to Activity, answer a question with Enter", async () => {
    const s = new FakeService([
      snap([runOf("rounding", { attention: "you", questions: [ASKED.question] }), runOf("docs")]),
    ]);
    const r = app(s);
    await shows(r, "Questions for you (1)");
    r.stdin.write(KEY.down);
    await shows(r, "stopped at build");
    r.stdin.write(KEY.tab);
    await shows(r, "Edit src/round.ts");
    r.stdin.write(KEY.up);
    await shows(r, "waits for you: Which rounding?");
    r.stdin.write(KEY.enter);
    await shows(r, "build · mt-implementer · agent");
    r.stdin.write(KEY.down);
    await tick();
    r.stdin.write(KEY.enter);
    await calls(s, 1);
    expect(s.calls).toEqual(["answer q001 Banker's"]);
    await shows(r, "Answered q001: Banker's");
    r.unmount();
  });

  test("Other asks for words; a gate nobody drives is approved or rejected in place", async () => {
    const s = new FakeService([
      snap([
        runOf("rounding", { attention: "you", questions: [ASKED.question] }),
        runOf("plan", {
          attention: "you",
          stage: "plan-approval",
          stages: [{ id: "plan-approval", state: "waiting", hitl: true }],
          updatedAt: "2026-10-28T09:00:00.000Z",
        }),
      ]),
    ]);
    const r = app(s);
    await shows(r, "Questions for you (1)");
    r.stdin.write("a");
    await shows(r, "Which rounding?");
    r.stdin.write(KEY.down);
    await tick();
    r.stdin.write(KEY.down);
    await tick();
    r.stdin.write(KEY.enter);
    await shows(r, "Your answer:");
    r.stdin.write("Round to 5 cents");
    await shows(r, "Round to 5 cents");
    r.stdin.write(KEY.enter);
    await calls(s, 1);
    await shows(r, "Answered q001: Other");
    r.stdin.write(KEY.down);
    await shows(r, "waits at plan-approval");
    r.stdin.write(KEY.enter);
    await shows(r, "plan-approval · gate");
    r.stdin.write(KEY.down);
    await tick();
    r.stdin.write(KEY.enter);
    await shows(r, "Why? (it goes back to the run)");
    r.stdin.write("Too big");
    await shows(r, "Too big");
    r.stdin.write(KEY.enter);
    await calls(s, 2);
    expect(s.calls).toEqual([
      'answer q001 Other "Round to 5 cents"',
      "gate plan plan-approval reject Too big",
    ]);
    r.unmount();
  });

  test("ask a question: the answer streams in, then the conversation is selected", async () => {
    const s = new FakeService([
      snap(
        [runOf("docs")],
        [{ id: "20261028-why", title: "How is VAT computed?", host: "scenario", turns: 1, updatedAt: "x" }],
      ),
    ]);
    const r = app(s);
    await shows(r, "Task docs");
    r.stdin.write("?");
    await shows(r, "Ask about the code");
    r.stdin.write("How is VAT computed?");
    await shows(r, "How is VAT computed?");
    r.stdin.write(KEY.enter);
    await shows(r, "Streaming answer line");
    await shows(r, "cites files that do not exist: src/vat.ts:3");
    expect(r.lastFrame()).toContain("› How is VAT computed?");
    r.stdin.write("r");
    await shows(r, "Follow-up · 20261028-why");
    r.stdin.write("And for B2B?");
    await shows(r, "And for B2B?");
    r.stdin.write(KEY.enter);
    await calls(s, 2);
    expect(s.calls).toEqual(['ask "How is VAT computed?"', 'ask "And for B2B?" in 20261028-why']);
    r.unmount();
  });

  test("the command palette runs any action by name; keys run them directly", async () => {
    const s = new FakeService([
      snap([runOf("docs", { worktree: { id: "docs", path: ".metator/wt/docs", branch: "metator/docs" } })]),
    ]);
    const r = app(s);
    await shows(r, "Task docs");
    r.stdin.write(":");
    await shows(r, "Commands");
    r.stdin.write("stop the");
    await shows(r, "Stop the selected run's drive");
    await tick();
    r.stdin.write(KEY.enter);
    await calls(s, 1);
    r.stdin.write("c");
    await calls(s, 2);
    r.stdin.write("u");
    await calls(s, 3);
    expect(s.calls).toEqual(["stop docs", "continue docs", "apps up docs"]);
    r.unmount();
  });

  test("new run: workflow, task, autonomy, host and worktree, one question at a time", async () => {
    const s = new FakeService([snap([])]);
    const r = app(s);
    await shows(r, "No runs yet");
    r.stdin.write("n");
    await shows(r, "which workflow?");
    r.stdin.write(KEY.enter); // mt-feature
    await shows(r, "what is the task?");
    r.stdin.write("Add combined discount");
    await shows(r, "Add combined discount");
    r.stdin.write(KEY.enter);
    await shows(r, "New run · autonomy");
    r.stdin.write(KEY.enter); // L0
    await shows(r, "which AI host");
    r.stdin.write(KEY.down);
    await tick();
    r.stdin.write(KEY.enter); // scenario
    await shows(r, "its own git worktree?");
    r.stdin.write(KEY.enter);
    await calls(s, 1);
    expect(s.calls).toEqual(['new mt-feature "Add combined discount" scenario true']);
    r.unmount();
  });

  test("settings save the editor and the AI hosts", async () => {
    const s = new FakeService([snap([runOf("docs")])]);
    const r = app(s);
    await shows(r, "Task docs");
    r.stdin.write(",");
    await shows(r, "Settings · metator.config.yml");
    r.stdin.write(KEY.enter);
    await shows(r, "Settings · editor");
    r.stdin.write(KEY.enter); // VS Code
    await calls(s, 1);
    await shows(r, "Saved.");
    r.stdin.write(",");
    await shows(r, "AI hosts: claude");
    r.stdin.write(KEY.down);
    await tick();
    r.stdin.write(KEY.enter);
    await shows(r, "AI hosts that get the agents");
    r.stdin.write(KEY.down);
    await tick();
    r.stdin.write(" ");
    await tick();
    r.stdin.write(KEY.enter);
    await calls(s, 2);
    expect(s.calls).toEqual(['save {"editor":"code"}', 'save {"hostTargets":["claude","copilot"]}']);
    await shows(r, "metator agents update");
    r.unmount();
  });

  test("a terminal program takes the screen and comes back; q quits with the sessions visited; the bell rings", async () => {
    const s = new FakeService([
      snap([runOf("docs")]),
      snap([runOf("docs")]),
      snap([runOf("docs"), runOf("new", { attention: "you", questions: [question("x")] })]),
    ]);
    s.launchResult = { argv: ["sh"], cwd: "/r/shop" };
    const r = app(s);
    await until("the bell", () => r.bells() === 1);
    r.stdin.write("t");
    await until("the exit", () => r.exits.length === 1);
    expect(r.exits[0]).toMatchObject({
      kind: "launch",
      launch: { argv: ["sh"] },
      state: { tab: "overview" },
    });
    const q = app(new FakeService([snap([runOf("docs")])]));
    await shows(q, "Task docs");
    q.stdin.write("q");
    await until("quit", () => q.exits.length === 1);
    expect(q.exits).toEqual([{ kind: "quit", visited: ["20261028-mt-feature-docs"] }]);
  });
});
