import { describe, expect, test } from "bun:test";
import {
  CLAUDE_BULLETED_REPLY_SCREEN,
  CLAUDE_CLARIFYING_QUESTIONS_SCREEN,
  CLAUDE_CLOSING_QUESTION_SCREEN,
  CLAUDE_CUT_QUESTIONS_SCREEN,
  CLAUDE_CUT_REPORT_SCREEN,
  CLAUDE_GREETING_SCREEN,
  CLAUDE_LETTERED_CHOICES_AGAIN_SCREEN,
  CLAUDE_LETTERED_CHOICES_SCREEN,
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
      "The gatekeeper (mt-gatekeeper-1) stopped: gates.quick has no steps in metator.config.yml (only gates.full exists: typecheck, test).",
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
    // No question sentence: the first sentence alone, nothing glued to it.
    expect(q?.prompt).toBe("mt-gatekeeper-2 stopped as well: the gates did not run in its worktree.");
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

  test("a greeting that lists what the person can do and invites them is no question", () => {
    expect(agentQuestionOf(CLAUDE_GREETING_SCREEN)).toBeUndefined();
    for (const invitation of [
      "How can I help?",
      "What can I help you with today?",
      "What do you want to work on?",
      "Where would you like to start?",
    ])
      expect(agentQuestionOf(` ● Hi. The checkout is clean.\n\n   ${invitation}\n\n❯`)).toBeUndefined();
    // A question about the work is one, also after a greeting; so is a decision the agent needs.
    expect(agentQuestionOf(" ● Hi. The index is not built.\n\n   Should I build it now?\n\n❯")?.prompt).toBe(
      "Should I build it now?",
    );
    expect(agentQuestionOf(" ● The tests fail.\n\n   What do you want to do?\n\n❯")?.prompt).toBe(
      "What do you want to do?",
    );
  });

  test("choices under a question: the prompt is that question, never a statement with words glued on", () => {
    const again = agentQuestionOf(CLAUDE_LETTERED_CHOICES_AGAIN_SCREEN);
    expect(again?.prompt).toBe("How do you want to get this into the README?");
    expect(again?.options).toEqual([
      { label: "(a) Tell the conductor (recommended): I send your words to pane w3:p6.", reply: "a" },
      { label: "(b) After the run: once this run's diff is ready, I make one small", reply: "b" },
      { label: "(c) You add it yourself.", reply: "c" },
    ]);
    // A choice that takes three sentences to explain is still a choice, under its question.
    const first = agentQuestionOf(CLAUDE_LETTERED_CHOICES_SCREEN);
    expect(first?.prompt).toBe("How do you want to get the README line in?");
    expect(first?.options.map((o) => o.reply)).toEqual(["a", "b", "c"]);
    expect(first?.text.split("\n")[0]).toBe("The worker has already ended, so I haven't sent anything. It's");
    // No screen of the real chat keeps the synthetic words.
    for (const screen of [
      CLAUDE_TEXT_QUESTION_SCREEN,
      CLAUDE_BULLETED_REPLY_SCREEN,
      CLAUDE_LETTERED_CHOICES_SCREEN,
      CLAUDE_LETTERED_CHOICES_AGAIN_SCREEN,
      CLAUDE_CUT_REPORT_SCREEN,
    ])
      expect(agentQuestionOf(screen)?.prompt).not.toContain("Which option?");
  });

  test("a question that closes the turn is the prompt, not the one the message began with", () => {
    expect(agentQuestionOf(CLAUDE_CLOSING_QUESTION_SCREEN)).toMatchObject({
      prompt: "Should I add it to this run's task too, or keep this run to the test only?",
      options: [],
    });
  });

  test("a message longer than its pane: no wrapped line and no cut sentence becomes the prompt", () => {
    // Numbered clarifying questions, the start scrolled off: the sentence that waits for the answer.
    const questions = agentQuestionOf(CLAUDE_CUT_QUESTIONS_SCREEN);
    expect(questions?.prompt).toBe(
      "Once you answer, I'll start the run with your decisions in the task and give you its id.",
    );
    expect(questions?.options).toEqual([]);
    expect(questions?.text).toContain("2. Where conversion rates come from: a fixed table");
    // The same screen one scroll earlier: it ends inside the last item, a question over two lines.
    const before = agentQuestionOf(
      CLAUDE_CUT_QUESTIONS_SCREEN.replace(/\n\n {2}Once you answer[^✻]*/, "\n\n"),
    );
    expect([before?.prompt, before?.options]).toEqual([
      "Autonomy: should the run stop for your approval only at the plan, or at every stage?",
      [],
    ]);
    // What it found as bullets, then "Tell me how to proceed.": the bullets are no choices.
    expect(agentQuestionOf(CLAUDE_CUT_REPORT_SCREEN)).toMatchObject({
      prompt: "Tell me how to proceed.",
      options: [],
    });
    // Choices without a question sentence, the start cut: the first whole sentence, not the cut one.
    const cut = agentQuestionOf(
      "  field.\n\n  The build has no currency. Reply with one of:\n  1. Add it.\n  2. Stop.\n\n❯",
    );
    expect([cut?.prompt, cut?.options.map((o) => o.reply)]).toEqual([
      "The build has no currency.",
      ["1", "2"],
    ]);
  });

  test("a list is choices only with words that say so: its question, a cue before it, or a cue after it", () => {
    const bullets = "\n   - Rebuild the index.\n   - Leave it as it is.\n\n";
    const of = (before: string, after: string) =>
      agentQuestionOf(` ● The index is stale. ${before}${bullets}   ${after}\n\n❯`);
    expect(of("Which way?", "I recommend the first.")?.options.length).toBe(2);
    expect(of("Choose one:", "I recommend the first.")?.options.length).toBe(2);
    expect(of("Two ways.", "Let me know which.")?.options.length).toBe(2);
    expect(of("Two ways.", "Pick one.")?.options.length).toBe(2);
    // Told to answer, but not to choose among them: a question without choices.
    expect(of("What I saw:", "Tell me how to go on.")).toMatchObject({
      prompt: "Tell me how to go on.",
      options: [],
    });
    // A question earlier in the message does not make a later list its choices.
    expect(of("Is that new? What I saw:", "Tell me how to go on.")?.options).toEqual([]);
    // Nothing asks: a report.
    expect(of("What I saw:", "I go on with the build.")).toBeUndefined();
    // Facts, or items that explain at length, are no choices for a cue after them either.
    const facts = agentQuestionOf(
      " ● Recorded.\n   - Changed file: src/a.ts\n   - Next step: the gate\n\n   Reply with yes to go on.\n\n❯",
    );
    expect([facts?.prompt, facts?.options]).toEqual(["Reply with yes to go on.", []]);
    const long = agentQuestionOf(
      " ● Two ways.\n   1. Rebuild it. It takes a minute. It needs the network.\n   2. Leave it.\n\n   Let me know which.\n\n❯",
    );
    expect([long?.prompt, long?.options]).toEqual(["Let me know which.", []]);
    // The question the choices stand under is the prompt, not an earlier one.
    expect(
      agentQuestionOf(
        " ● Is the cache stale? I think so.\n\n   Which way?\n   1. Rebuild.\n   2. Leave.\n\n❯",
      )?.prompt,
    ).toBe("Which way?");
    // A cut message whose first visible line is the tail of an item's question: no prompt of it.
    expect(
      agentQuestionOf(
        "     or at every stage?\n  2. Where do rates come from?\n\n  Once you answer, I start.\n\n❯",
      )?.prompt,
    ).toBe("Once you answer, I start.");
    // Items with blank lines between them are one list.
    expect(
      agentQuestionOf(" ● Which way?\n\n   1. Rebuild it.\n\n   2. Leave it.\n\n❯")?.options.map(
        (o) => o.reply,
      ),
    ).toEqual(["1", "2"]);
    // A sub-item belongs to its item: it is no choice of its own.
    expect(
      agentQuestionOf(
        " ● Which way?\n   1. Rebuild it.\n      - takes a minute\n      - needs the network\n   2. Leave it.\n\n❯",
      )?.options.map((o) => o.label),
    ).toEqual(["1. Rebuild it.", "2. Leave it."]);
  });
});
