import { describe, expect, test } from "bun:test";
import {
  ANSWERED_IN_PANE,
  ATTACH_PANE,
  DEFAULT_PATHS,
  DriverLock,
  GuardAsked,
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
  CLAUDE_APPROVAL_COMMIT_SCREEN,
  CLAUDE_APPROVAL_MULTILINE_SCREEN,
  CLAUDE_APPROVAL_OPTIONS,
  CLAUDE_APPROVAL_RAW,
  CLAUDE_APPROVAL_TEXT,
  CLAUDE_BULLETED_REPLY_SCREEN,
  CLAUDE_COMMIT_COMMAND,
  CLAUDE_MULTILINE_COMMAND,
  CLAUDE_NOT_A_QUESTION_SCREENS,
  CLAUDE_TEXT_QUESTION_SCREEN,
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
  const asked = new GuardAsked(fs, clock);
  const prompts = new HostPrompts({
    guardReason: async (paneId, command) => (await asked.reasonFor(paneId, command))?.reason,
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
    rendered: (paneId) => broker.screen(paneId),
  });
  const start = (paneId: string, host: string, runId?: string, role?: string) => {
    const pty = new FakePty(1001);
    broker
      .start({
        paneId,
        ...(runId ? { runId } : {}),
        role: (role ?? (runId ? "conductor" : "apps")) as never,
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
  return { journal, questions, prompts, typed, start, init, clock, broker, asked };
}

describe("an agent that asks the person in words at the end of its turn", () => {
  const typeScreen = (screen: string) => `${screen.split("\n").join("\r\n")}\r\n`;

  test("a run's conductor that asks with numbered options: a pane question with its run, the whole message, its choices; 1 is typed for the first", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const pty = w.start("w2:p1", "claude", run.runId);
    pty.print(typeScreen(CLAUDE_TEXT_QUESTION_SCREEN));
    // Still at work (output just now): not a question yet.
    expect((await w.prompts.tick())._unsafeUnwrap().asked).toEqual([]);
    w.clock.advance(20_000);
    const asked = (await w.prompts.tick())._unsafeUnwrap().asked;
    const q = w.questions.open()[0];
    expect(asked).toEqual([{ paneId: "w2:p1", runId: run.runId, questionId: q?.id as string }]);
    // The prompt is the agent's own sentence: nothing is glued to it.
    expect([
      q?.runId,
      q?.source,
      q?.prompt.endsWith("(only gates.full exists: typecheck, test)."),
      q?.text?.split("\n")[3],
    ]).toEqual([run.runId, "agent", true, "Options:"]);
    expect(q?.options.map((o) => o.label)).toEqual([
      "1. Start the gatekeeper again and have it run",
      "2. You add steps to gates.quick in the config",
      "3. Stop the run.",
      "4. Something else you'd like.",
      "Other",
      LEAVE_PANE,
    ]);
    // Never in the run's journal: it is the pane's question.
    expect((await w.journal.questions(run.runId))._unsafeUnwrap()).toEqual([]);
    expect(w.prompts.asksInPane("w2:p1")).toBe(true);
    (
      await w.prompts.answerPane({
        paneId: "w2:p1",
        question: q?.id as string,
        choices: ["1. Start the gatekeeper again and have it run"],
        by: "ana",
      })
    )._unsafeUnwrap();
    expect(w.typed).toEqual(["w2:p1 1"]);
    expect(w.prompts.asksInPane("w2:p1")).toBe(false);
    // The agent works again: the item is gone, and the same message is not asked twice.
    pty.print("● Starting mt-gatekeeper-2 with only the full gate.\r\n");
    expect((await w.prompts.tick())._unsafeUnwrap().resolved).toEqual(["w2:p1"]);
    w.clock.advance(20_000);
    expect((await w.prompts.tick())._unsafeUnwrap().asked).toEqual([]);
  });

  test("a chat's reply words: the word is typed; Other types the person's words; Leave it types nothing", async () => {
    const w = world();
    const pty = w.start("w1:p1", "claude");
    pty.print(typeScreen(CLAUDE_BULLETED_REPLY_SCREEN));
    w.clock.advance(20_000);
    await w.prompts.tick();
    const q = w.questions.open()[0];
    (
      await w.prompts.answerPane({
        paneId: "w1:p1",
        question: q?.id as string,
        choices: ['"stop": I close the run as aborted.'],
        by: "ana",
      })
    )._unsafeUnwrap();
    expect(w.typed).toEqual(["w1:p1 stop"]);
    const other = world();
    const chat = other.start("w1:p1", "claude");
    chat.print(typeScreen(CLAUDE_BULLETED_REPLY_SCREEN));
    other.clock.advance(20_000);
    await other.prompts.tick();
    const id = other.questions.open()[0]?.id as string;
    (
      await other.prompts.answerPane({
        paneId: "w1:p1",
        question: id,
        choices: [],
        text: "run only the full gate",
        by: "ana",
      })
    )._unsafeUnwrap();
    expect(other.typed).toEqual(["w1:p1 run only the full gate"]);
    const leave = world();
    leave.start("w1:p1", "claude").print(typeScreen(CLAUDE_BULLETED_REPLY_SCREEN));
    leave.clock.advance(20_000);
    await leave.prompts.tick();
    (
      await leave.prompts.answerPane({
        paneId: "w1:p1",
        question: leave.questions.open()[0]?.id as string,
        choices: [LEAVE_PANE],
        by: "ana",
      })
    )._unsafeUnwrap();
    expect(leave.typed).toEqual([]);
  });

  test("a report, a wait for a worker, a shell: no question", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    w.start("w2:p1", "claude", run.runId).print(typeScreen(CLAUDE_NOT_A_QUESTION_SCREENS[1] as string));
    w.start("w2:p2", "claude", run.runId, "shell").print(typeScreen(CLAUDE_TEXT_QUESTION_SCREEN));
    w.clock.advance(20_000);
    expect((await w.prompts.tick())._unsafeUnwrap().asked).toEqual([]);
    expect(w.questions.open()).toEqual([]);
  });
});

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

  test("a host asks because MetatorAI's guard asked: the card carries the guard's reason, which the host's prompt does not show", async () => {
    const w = world();
    const why = "this commit holds debug changes: src/server.ts. Commit only when the person says so.";
    // The chat's pre-tool hook asked about that commit (its command as the hook got it).
    (await w.asked.record("w1:p1", CLAUDE_COMMIT_COMMAND, "ask", why))._unsafeUnwrap();
    const chat = w.start("w1:p1", "claude");
    chat.print(`${CLAUDE_APPROVAL_COMMIT_SCREEN.split("\n").join("\r\n")}\r\n`);
    await w.prompts.tick();
    const q = w.questions.open()[0];
    expect([q?.command, q?.reason]).toEqual([CLAUDE_COMMIT_COMMAND, why]);
    expect(q?.prompt).not.toContain("│");
    // In a run's pane the same, on the run's question; another command has no reason of the guard's.
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    (await w.asked.record("w2:p1", CLAUDE_COMMIT_COMMAND, "ask", why))._unsafeUnwrap();
    w.start("w2:p1", "claude", run.runId).print(
      `${CLAUDE_APPROVAL_COMMIT_SCREEN.split("\n").join("\r\n")}\r\n`,
    );
    const other = w.start("w2:p2", "claude", run.runId);
    other.print(`${CLAUDE_APPROVAL_MULTILINE_SCREEN.split("\n").join("\r\n")}\r\n`);
    await w.prompts.tick();
    const asked = (await w.journal.questions(run.runId))._unsafeUnwrap();
    expect(asked.map((x) => [x.command?.slice(0, 7), x.reason])).toEqual([
      ["git add", why],
      ["metator", undefined],
    ]);
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
