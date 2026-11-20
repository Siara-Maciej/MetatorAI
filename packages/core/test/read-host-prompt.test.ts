import { describe, expect, test } from "bun:test";
import {
  CLAUDE_APPROVAL_MULTILINE_SCREEN,
  CLAUDE_APPROVAL_REAL_SCREEN,
  CLAUDE_APPROVAL_TEXT,
  CLAUDE_APPROVAL_WRAPPED_SCREEN,
  CLAUDE_MULTILINE_COMMAND,
  CLAUDE_WRAPPED_COMMAND,
} from "@metator/testing";
import { readHostPrompt } from "../src/domain/host-manifest.ts";

// The screens as rendered rows; rendering bytes is the ScreenRenderer's (its contract, and the
// real Claude screens through @xterm/headless, are in plugin-node's tests).

describe("readHostPrompt: a host's prompt as one readable line and its numbered choices", () => {
  test("a tip line in a host's question is not what it asks about", () => {
    const edit = [
      "● Update(src/currency.ts)",
      "─────────────────────────────────────────────",
      " Edit file",
      ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
      " src/currency.ts",
      " Do you want to make this edit to currency.ts?",
      " ❯ 1. Yes",
      "   2. Yes, allow all edits during this session (shift+tab)",
      "   3. No",
    ].join("\n");
    expect(readHostPrompt(edit, "Do you want to make this edit to currency.ts?").text).toBe(
      "Edit file: src/currency.ts — Do you want to make this edit to currency.ts?",
    );
  });

  test("Claude Code 2.1's real approval (no box): the command, not its tip, names what is asked", () => {
    expect(readHostPrompt(CLAUDE_APPROVAL_REAL_SCREEN, "Do you want to proceed?")).toEqual({
      // The prompt starts with the command; the command is there whole.
      text: "metator workflow list — This command requires approval",
      command: "metator workflow list",
      options: [
        { key: "1", label: "Yes" },
        { key: "2", label: "Yes, and don’t ask again for: metator workflow *" },
        { key: "3", label: "Yes, and switch to auto mode · auto mode handles these prompts for you" },
        { key: "4", label: "No" },
      ],
    });
  });

  test("a command over several lines is whole in `command`, its line breaks kept; the prompt starts with its first line", () => {
    const read = readHostPrompt(CLAUDE_APPROVAL_MULTILINE_SCREEN, "Do you want to proceed?");
    expect(read.command).toBe(CLAUDE_MULTILINE_COMMAND);
    expect(read.text).toBe(
      'metator run delegate build --agent mt-implementer --card "Implement step S1: — This command requires approval',
    );
    expect(read.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  });

  test("a command the terminal wrapped mid-name is one line again; a long prompt is cut at the bound", () => {
    const read = readHostPrompt(CLAUDE_APPROVAL_WRAPPED_SCREEN, "Do you want to proceed?");
    expect(read.command).toBe(CLAUDE_WRAPPED_COMMAND);
    expect(read.text.startsWith("cat /home/user/shop/packages/billing/src/")).toBe(true);
    expect(read.text.endsWith(" — This command requires approval")).toBe(true);
  });

  test("the same prompt without a box (a newer layout) reads the same", () => {
    const bare = [
      "● Bash(metator workflow list)",
      "  ⎿  Waiting for approval…",
      "",
      " Bash command",
      "",
      "   metator workflow list",
      "   List the workflows of this repository",
      "",
      " This command requires approval",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for: metator workflow *",
      "   3. Yes, and switch to auto mode",
      "   4. No",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n");
    const read = readHostPrompt(bare, "Esc to cancel · Tab to amend");
    expect(read.text).toBe(CLAUDE_APPROVAL_TEXT);
    expect(read.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and don't ask again for: metator workflow *",
      "Yes, and switch to auto mode",
      "No",
    ]);
  });

  test("a line without a menu or a box is itself (an agent's `question [a / b]`), and nothing is ever longer than the bound", () => {
    expect(readHostPrompt("first session\nGo on? [yes / no]", "Go on? [yes / no]")).toEqual({
      text: "Go on? [yes / no]",
      options: [],
    });
    // One numbered line, or a list that does not start at 1, is no menu of the host's.
    const box = "╭────╮\n│ Run the tests now? │\n│ 3. later │\n│ 4. never │\n╰────╯";
    expect(readHostPrompt(box, "Run the tests now?").options).toEqual([]);
    const long = `Allow ${"x".repeat(1000)} (y/n)`;
    expect(readHostPrompt(long, long).text.length).toBeLessThanOrEqual(200);
    expect(readHostPrompt(long, long).text.endsWith("…")).toBe(true);
  });
});
