import { describe, expect, test } from "bun:test";
import {
  CLAUDE_BULLETED_REPLY_SCREEN,
  CLAUDE_NOT_A_QUESTION_SCREENS,
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
});
