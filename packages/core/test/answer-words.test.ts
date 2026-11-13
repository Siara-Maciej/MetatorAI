import { describe, expect, test } from "bun:test";
import { ANSWERS_WITH_WORDS, needsWords, withNeedsText, wordsRequired } from "../src/domain/answer-words.ts";

describe("the answers that need the person's own words", () => {
  test("only Reject and Other do; Deny, Approve and a listed option are whole answers", () => {
    expect(ANSWERS_WITH_WORDS).toEqual(["Reject", "Other"]);
    expect(["Reject", "Other", "Deny", "Approve", "Allow", "Use zod"].map((c) => needsWords([c]))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect([needsWords([]), needsWords(["Use zod", "Other"]), needsWords(["Deny", "Allow"])]).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("the words are the answer with Other, a reason that may stay empty with Reject", () => {
    expect([wordsRequired(["Other"]), wordsRequired(["Reject"]), wordsRequired(["Deny"])]).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("a served question marks those options with needsText and keeps every field it had", () => {
    const q = {
      id: "q001",
      prompt: "Allow Bash?",
      options: [{ label: "Allow" }, { label: "Deny", description: "refuse" }, { label: "Reject" }, { label: "Other" }],
    };
    expect(withNeedsText(q)).toEqual({
      id: "q001",
      prompt: "Allow Bash?",
      options: [
        { label: "Allow" },
        { label: "Deny", description: "refuse" },
        { label: "Reject", needsText: true },
        { label: "Other", needsText: true },
      ],
    });
    expect(q.options[2]).toEqual({ label: "Reject" });
  });
});
