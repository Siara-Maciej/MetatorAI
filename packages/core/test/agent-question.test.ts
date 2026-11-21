import { describe, expect, test } from "bun:test";
import {
  CLAUDE_BULLETED_REPLY_SCREEN,
  CLAUDE_CLARIFYING_QUESTIONS_SCREEN,
  CLAUDE_NOT_A_QUESTION_SCREENS,
  CLAUDE_NUMBERED_ANSWER_SCREEN,
  CLAUDE_STATUS_REPORT_SCREEN,
  CLAUDE_STILL_WAITING_SCREEN,
  CLAUDE_TEXT_QUESTION_SCREEN,
} from "@metator/testing";
import { agentQuestionOf } from "../src/domain/agent-question.ts";

describe("agentQuestionOf: an agent that ended its turn asking the person in words", () => {
  test("the real conductor's numbered options: one-line prompt, the whole message, each option by its number", () => {
    const q = agentQuestionOf(CLAUDE_TEXT_QUESTION_SCREEN);
    expect(q?.prompt).toBe(
      "The gatekeeper (mt-gatekeeper-1) stopped: gates.quick has no steps in metator.config.yml (only gates.full exists: typecheck, test). Which option?",
    );
    expect(q?.text).toBe(
      [
        "The gatekeeper (mt-gatekeeper-1) stopped: gates.quick has no steps in",
        "metator.config.yml (only gates.full exists: typecheck, test).",
        "",
        "Options:",
        "1. Start the gatekeeper again and have it run",
        "   only metator gate full, skipping the empty",
        "   quick gate. This is what I'd recommend.",
        "2. You add steps to gates.quick in the config",
        "   first, then I run the gatekeeper again.",
        "3. Stop the run.",
        "4. Something else you'd like.",
      ].join("\n"),
    );
    expect(q?.options).toEqual([
      { label: "1. Start the gatekeeper again and have it run", reply: "1" },
      { label: "2. You add steps to gates.quick in the config", reply: "2" },
      { label: "3. Stop the run.", reply: "3" },
      { label: "4. Something else you'd like.", reply: "4" },
    ]);
  });

  test("the real conductor's reply words as bullets: each typed as its word", () => {
    const q = agentQuestionOf(CLAUDE_BULLETED_REPLY_SCREEN);
    expect(q?.options).toEqual([
      { label: '"start a gatekeeper": I start a third one.', reply: "start a gatekeeper" },
      {
        label: '"gates pass" or "gates fail": you ran them yourself and tell me the result.',
        reply: "gates pass",
      },
      { label: '"stop": I close the run as aborted.', reply: "stop" },
    ]);
    expect(q?.prompt).toBe(
      "mt-gatekeeper-2 stopped as well: the gates did not run in its worktree. Which option?",
    );
  });

  test("a turn that says it still waits for the person is a question, without options of its own", () => {
    expect(agentQuestionOf(CLAUDE_STILL_WAITING_SCREEN)).toEqual({
      prompt: "Still waiting for your reply: 1, 2 or 3 (or 4).",
      text: "Still waiting for your reply: 1, 2 or 3 (or 4).",
      options: [],
    });
  });

  test("a question mark at the end asks; a progress report, a wait for a worker and a summary do not", () => {
    expect(agentQuestionOf(" ● Should prices round per line or per invoice?\n\n❯")?.prompt).toBe(
      "Should prices round per line or per invoice?",
    );
    for (const screen of CLAUDE_NOT_A_QUESTION_SCREENS) expect(agentQuestionOf(screen)).toBeUndefined();
    expect(agentQuestionOf("")).toBeUndefined();
  });

  test("a terminal without Claude's bullets (another host, the scenario host): its last paragraph, above the command it waits in", () => {
    const screen = [
      "$ metator run delegate build --agent mt-tester --card x",
      "The worker failed: the tests do not compile.",
      "Options:",
      "1. Fix the tests first.",
      "2. Stop the run.",
      "$ read -r line; printf 'answer: %s\\n' \"$line\"",
    ].join("\n");
    expect(agentQuestionOf(screen)?.options.map((o) => o.reply)).toEqual(["1", "2"]);
    expect(agentQuestionOf("$ sleep 120\nworking on it\n$ make")).toBeUndefined();
  });

  test("numbered items that are questions or explanations are not choices: the first question is the prompt, the person answers in words", () => {
    const q = agentQuestionOf(CLAUDE_CLARIFYING_QUESTIONS_SCREEN);
    expect(q?.prompt).toBe("This is too small for the full workflow: do it as quick?");
    expect(q?.options).toEqual([]);
    // The side panel Claude Code draws at the right is no part of the message.
    expect(q?.text).not.toContain("│");
    expect(q?.text).not.toContain("No changes this session");
    expect(q?.text.split("\n")[0]).toBe(
      "This is too small for the full workflow: do it as quick? The check passed with no",
    );
    expect(q?.text).toContain(
      "1. Which SKU goes back in the response? For GET /prices/MUG-01, should the body say",
    );
    expect(q?.text.split("\n").at(-1)).toBe("Say yes and answer those two, and I'll start the quick run.");
    // One item that is a question is enough; so is one that runs over several sentences.
    const one = agentQuestionOf(
      " ● Two ways. Which one?\n   1. Should it be the catalog's spelling?\n   2. Keep the request's.\n\n❯",
    );
    expect([one?.prompt, one?.options]).toEqual(["Which one?", []]);
    const long = agentQuestionOf(
      " ● Before I start:\n   1. The cache is stale. It was built last week. Nobody refreshed it. I can rebuild it.\n   2. The tests are slow.\n\n   Tell me how to go on.\n\n❯",
    );
    expect(long?.options).toEqual([]);
  });

  test("a status report asks nothing: bullets of facts, no question mark, conditionals that are no wait", () => {
    expect(agentQuestionOf(CLAUDE_STATUS_REPORT_SCREEN)).toBeUndefined();
    expect(agentQuestionOf(CLAUDE_NUMBERED_ANSWER_SCREEN)).toBeUndefined();
    for (const report of [
      " ● I added the log line.\n   - Changed file: src/server.ts\n   - Not committed: no commit will pick it up by accident\n\n❯",
      " ● Done. Let me know if you want it reverted.\n\n❯",
      " ● Started. I'll correct it if you meant otherwise; tell me if anything looks off.\n\n❯",
    ])
      expect(agentQuestionOf(report)).toBeUndefined();
    // Facts stay facts although one of them holds words that elsewhere ask to choose.
    expect(
      agentQuestionOf(
        " ● I recorded the edit.\n   - Changed file: src/server.ts\n   - To undo: reply with drop and I take it out\n\n❯",
      ),
    ).toBeUndefined();
    // The same bullets under a question are still a question, and words that ask to choose still ask.
    expect(
      agentQuestionOf(
        " ● Which way?\n   - Direct: I edit it now\n   - Quick: a small run\n\n   Pick one.\n\n❯",
      )?.options.length,
    ).toBe(2);
    expect(
      agentQuestionOf(
        " ● I can do either.\n   1. Rebuild it.\n   2. Leave it.\n\n   Let me know which.\n\n❯",
      )?.options.map((o) => o.reply),
    ).toEqual(["1", "2"]);
  });
});
