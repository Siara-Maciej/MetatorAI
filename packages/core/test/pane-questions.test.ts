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
  PaneQuestions,
  PaneSensor,
  PtyBroker,
  RunJournal,
  RunRepository,
  WorkflowCatalog,
} from "@metator/core";
import {
  CLAUDE_APPROVAL_MULTILINE_SCREEN,
  CLAUDE_APPROVAL_OPTIONS,
  CLAUDE_APPROVAL_RAW,
  CLAUDE_APPROVAL_TEXT,
  CLAUDE_MULTILINE_COMMAND,
  FakePty,
  FakeScreenRenderer,
  FixedClock,
  InMemoryFileSystem,
} from "@metator/testing";
import { ok } from "../src/domain/result.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
/** Claude Code after the approval: the box erased and the tool's output drawn. */
const APPROVED = `${"\u001b[2K\u001b[1A".repeat(16)}\u001b[2K\u001b[G● Bash(metator workflow list)\r\n  ⎿  mt-feature  W1\r\n`;

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-20T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const broker = new PtyBroker({
    repo,
    journal,
    clock,
    idleMs: 60_000,
    after: () => () => {},
    screens: new FakeScreenRenderer(),
  });
  const sensor = new PaneSensor({ broker, manifests: new HostManifestCatalog(fs), journal, clock });
  const lock = new DriverLock(repo, journal, clock);
  const questions = new PaneQuestions(clock);
  const typed: string[] = [];
  const prompts = new HostPrompts({
    sensor,
    journal,
    lock,
    panes: questions,
    identity: { of: async (paneId) => (paneId === "w1:p1" ? { role: "apps", agent: "chat" } : undefined) },
    type: async (paneId, text) => {
      typed.push(`${paneId} ${text}`);
      return ok(undefined);
    },
    screen: (paneId) => broker.backlog(paneId),
  });
  const start = (paneId: string, host: string, runId?: string) => {
    const pty = new FakePty(1001);
    broker
      .start({
        paneId,
        ...(runId ? { runId } : {}),
        role: runId ? "conductor" : "apps",
        host,
        sessionId: `${host}-1`,
        pty,
        size: { cols: 100, rows: 40 },
      })
      ._unsafeUnwrap();
    return pty;
  };
  const init = (task: string) =>
    new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock).execute({ workflow: "demo", task });
  return { journal, questions, prompts, typed, start, init, clock, broker };
}

describe("host prompts in a pane without a run (the intake chat)", () => {
  test("Claude Code's approval becomes a pane's question: its readable prompt and its choices; answered in the app, its number is typed", async () => {
    const w = world();
    const pty = w.start("w1:p1", "claude");
    pty.print(CLAUDE_APPROVAL_RAW);
    const report = (await w.prompts.tick())._unsafeUnwrap();
    const open = w.questions.open();
    expect(report.asked).toEqual([{ paneId: "w1:p1", questionId: open[0]?.id as string }]);
    expect(open).toEqual([
      {
        id: "p001",
        paneId: "w1:p1",
        source: "permission",
        agent: "chat",
        host: "claude",
        prompt: CLAUDE_APPROVAL_TEXT,
        options: [
          ...CLAUDE_APPROVAL_OPTIONS.map((label) => ({ label })),
          {
            label: ATTACH_PANE,
            description: "Take the keyboard of the session and answer the host yourself",
          },
          { label: LEAVE_PANE, description: "Leave the prompt as it is; the session waits" },
        ],
        multiSelect: false,
        askedAt: "2026-11-20T10:00:00.000Z",
      },
    ]);
    // Asked once while it stays on the screen.
    expect((await w.prompts.tick())._unsafeUnwrap().asked).toEqual([]);
    const answered = (
      await w.prompts.answerPane({ paneId: "w1:p1", question: "p001", choices: ["yes"], by: "ana" })
    )._unsafeUnwrap();
    expect(answered.answer).toEqual({ choices: ["Yes"], by: "ana", at: "2026-11-20T10:00:00.000Z" });
    // The menu's key for the choice; Enter follows as its own write (the daemon's `type`).
    expect(w.typed).toEqual(["w1:p1 1"]);
    expect(w.questions.open()).toEqual([]);
    // The host moves on: the item is gone; the answer stays the person's.
    pty.print(APPROVED);
    expect((await w.prompts.tick())._unsafeUnwrap().resolved).toEqual(["w1:p1"]);
    expect(w.questions.get("w1:p1", "p001")?.answer?.by).toBe("ana");
    expect(w.typed).toEqual(["w1:p1 1"]);
  });

  test("answered at the terminal: the prompt goes away and the item closes as answered in the pane", async () => {
    const w = world();
    const pty = w.start("w1:p1", "claude");
    pty.print(CLAUDE_APPROVAL_RAW);
    await w.prompts.tick();
    pty.print(APPROVED);
    expect((await w.prompts.tick())._unsafeUnwrap().resolved).toEqual(["w1:p1"]);
    expect(w.questions.get("w1:p1", "p001")?.answer).toEqual({
      choices: [],
      text: ANSWERED_IN_PANE,
      by: "pane:w1:p1",
      at: "2026-11-20T10:00:00.000Z",
    });
    // A card answer after that is refused: the pane answered first; nothing is typed.
    const late = await w.prompts.answerPane({
      paneId: "w1:p1",
      question: "p001",
      choices: ["Yes"],
      by: "ana",
    });
    expect(late._unsafeUnwrapErr().message).toBe("question p001 of pane w1:p1 is already answered");
    expect(w.typed).toEqual([]);
  });

  test("a pane that is gone takes its open question out of the inbox", async () => {
    const w = world();
    const pty = w.start("w1:p1", "claude");
    pty.print(CLAUDE_APPROVAL_RAW);
    await w.prompts.tick();
    expect(w.questions.open()).toHaveLength(1);
    w.broker.close("w1:p1");
    await w.prompts.tick();
    expect(w.questions.open()).toEqual([]);
  });

  test("an agent's question in a run-less pane: its words and options; the chosen words are typed", async () => {
    const w = world();
    const pty = w.start("w1:p1", "scenario");
    pty.print("Which workflow? [mt-feature / mt-bugfix]\n");
    await w.prompts.tick();
    const q = w.questions.open()[0];
    expect([q?.source, q?.prompt, q?.options.map((o) => o.label)]).toEqual([
      "agent",
      "Which workflow?",
      ["mt-feature", "mt-bugfix", ATTACH_PANE, "Other"],
    ]);
    (
      await w.prompts.answerPane({
        paneId: "w1:p1",
        question: q?.id as string,
        choices: [],
        text: "both",
        by: "ana",
      })
    )._unsafeUnwrap();
    expect(w.typed).toEqual(["w1:p1 both"]);
  });

  test("an answer the pane cannot take: an unknown question, a choice it does not offer, no name", async () => {
    const w = world();
    const pty = w.start("w1:p1", "claude");
    pty.print(CLAUDE_APPROVAL_RAW);
    await w.prompts.tick();
    const answer = (choices: string[], by = "ana", question = "p001") =>
      w.prompts.answerPane({ paneId: "w1:p1", question, choices, by });
    expect((await answer(["Yes"], "ana", "p009"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await answer(["Maybe"]))._unsafeUnwrapErr().message).toStartWith("choose from: Yes, ");
    expect((await answer(["Yes"], " "))._unsafeUnwrapErr().message).toBe("say who answers: --by <name>");
    // Leave it: nothing typed, the item stays answered while the prompt waits.
    (await answer([LEAVE_PANE]))._unsafeUnwrap();
    expect(w.typed).toEqual([]);
    expect(w.questions.open()).toEqual([]);
  });

  test("a host asks to run a command over several lines: the question carries it whole, the prompt starts with it", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = w.start("w2:p1", "claude", run.runId);
    pty.print(`${CLAUDE_APPROVAL_MULTILINE_SCREEN.split("\n").join("\r\n")}\r\n`);
    await w.prompts.tick();
    const q = (await w.journal.questions(run.runId))._unsafeUnwrap()[0];
    expect([q?.command, q?.prompt.startsWith("metator run delegate build --agent mt-implementer")]).toEqual([
      CLAUDE_MULTILINE_COMMAND,
      true,
    ]);
    // A pane without a run: the same on its pane question.
    const chat = w.start("w1:p1", "claude");
    chat.print(`${CLAUDE_APPROVAL_MULTILINE_SCREEN.split("\n").join("\r\n")}\r\n`);
    await w.prompts.tick();
    expect(w.questions.open()[0]?.command).toBe(CLAUDE_MULTILINE_COMMAND);
  });

  test("a run's pane with a host menu: the menu's choices are the card's options and the chosen one's key is typed", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = w.start("w2:p1", "claude", run.runId);
    pty.print(CLAUDE_APPROVAL_RAW);
    const asked = (await w.prompts.tick())._unsafeUnwrap().asked;
    const q = (await w.journal.questions(run.runId))._unsafeUnwrap()[0];
    expect([asked[0]?.runId, q?.source, q?.prompt]).toEqual([run.runId, "permission", CLAUDE_APPROVAL_TEXT]);
    expect(q?.options.map((o) => o.label)).toEqual([
      ...CLAUDE_APPROVAL_OPTIONS,
      ATTACH_PANE,
      LEAVE_PANE,
      "Other",
    ]);
    await w.journal.answer(run.runId, q?.id as string, {
      choices: ["Yes, and switch to auto mode"],
      by: "ana",
    });
    await w.prompts.deliver(run.runId, q?.id as string);
    expect(w.typed).toEqual(["w2:p1 3"]);
    expect(w.questions.open()).toEqual([]);
  });
});
