/**
 * What Claude Code writes to its terminal while it asks leave to run a command, as its renderer
 * (Ink) does it: a spinner redrawn in place with `\r`, then each frame erased line by line
 * (erase line, cursor up) and drawn again, the approval box last. Built from the screens a real
 * session showed when its intake chat ran `metator workflow list`.
 */
const ESC = "\u001b";
const eraseLines = (n: number) => `${`${ESC}[2K${ESC}[1A`.repeat(n - 1)}${ESC}[2K${ESC}[G`;
const frame = (lines: readonly string[]) => lines.join("\r\n");

const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽"];
const BOX = [
  `${ESC}[38;5;174m╭──────────────────────────────────────────────────────────────╮${ESC}[39m`,
  "│ Bash command                                                 │",
  "│                                                              │",
  "│   metator workflow list                                      │",
  "│   List the workflows of this repository                      │",
  "│                                                              │",
  "│ This command requires approval                               │",
  "│                                                              │",
  "│ Do you want to proceed?                                      │",
  `│ ${ESC}[36m❯ 1. Yes${ESC}[39m                                                     │`,
  "│   2. Yes, and don't ask again for: metator workflow *        │",
  "│   3. Yes, and switch to auto mode                            │",
  "│   4. No, and tell Claude what to do differently (esc)        │",
  "╰──────────────────────────────────────────────────────────────╯",
];

export const CLAUDE_APPROVAL_RAW = [
  `${ESC}[?25l`,
  "> I want a new feature: prices in the customer's currency\r\n\r\n",
  // The spinner: one line, redrawn in place a few hundred times.
  ...Array.from({ length: 300 }, (_, i) => `\r● ${SPINNER[i % SPINNER.length]} Thinking… (${i % 60}s)`),
  "\r\n",
  frame(["● Bash(metator workflow list)", "  ⎿  Running…"]),
  eraseLines(2),
  frame(["● Bash(metator workflow list)", "  ⎿  Waiting for approval…", "", ...BOX]),
  "\r\n",
].join("");

/** The prompt a person reads on that screen, in one line. */
export const CLAUDE_APPROVAL_TEXT = "Bash command: metator workflow list — This command requires approval";

export const CLAUDE_APPROVAL_OPTIONS = [
  "Yes",
  "Yes, and don't ask again for: metator workflow *",
  "Yes, and switch to auto mode",
  "No, and tell Claude what to do differently (esc)",
];

/**
 * The approval as Claude Code 2.1.329 drew it in a real intake chat (rendered rows): no box, a
 * rule above, a tip line, the command's description, then the command between dashed rules.
 */
export const CLAUDE_APPROVAL_REAL_SCREEN = [
  "● Running 2 shell commands…",
  "  ⎿  $ metator workflow list",
  "",
  "──────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  " List available workflows",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " metator workflow list",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " This command requires approval",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don’t ask again for: metator workflow *",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

/**
 * Claude Code running `bun test` with its output scrolling in a scroll region (rows 2-9) under
 * the tool's line, then the count of lines it no longer shows and its question at the bottom,
 * with a wide emoji: a terminal of 60×12. A renderer that ignores scroll regions scrolls the whole
 * screen (the header goes, the rows grow); one that counts an emoji as one cell misplaces it.
 */
export const CLAUDE_SCROLLED_RAW = [
  "\u001b[2J\u001b[H● Bash(bun test)",
  "\u001b[2;9r\u001b[2;1H",
  ...Array.from({ length: 40 }, (_, i) => `  test ${i + 1} passed\r\n`),
  "\u001b[r",
  "\u001b[10;1H  ↑ 37 more lines",
  "\u001b[12;1H Do you want to proceed? ✅",
].join("");

const RULE = "╌".repeat(82);
/** Claude Code 2.1's approval of a command that runs over several lines (a worker's card), rendered rows. */
export const CLAUDE_APPROVAL_MULTILINE_SCREEN = [
  "● Bash(metator run delegate build …)",
  "",
  "──────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  " Delegate the build stage to a worker",
  RULE,
  ' metator run delegate build --agent mt-implementer --card "Implement step S1:',
  " add the currency field to Price and its migration.",
  ' Write the failing test first; summary of at most 10 lines."',
  RULE,
  " This command requires approval",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

export const CLAUDE_MULTILINE_COMMAND =
  'metator run delegate build --agent mt-implementer --card "Implement step S1:\nadd the currency field to Price and its migration.\nWrite the failing test first; summary of at most 10 lines."';

/** A path longer than the terminal is wide: the terminal wraps it onto the next row, mid-name. */
export const CLAUDE_WRAPPED_COMMAND =
  "cat /home/user/shop/packages/billing/src/currencies/conversions/rates/european-central-bank/daily-reference-rates.ts";
const wrapped = ` ${CLAUDE_WRAPPED_COMMAND}`;
export const CLAUDE_APPROVAL_WRAPPED_SCREEN = [
  "──────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  " Read the rates module",
  RULE,
  wrapped.slice(0, 82),
  wrapped.slice(82),
  RULE,
  " This command requires approval",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don’t ask again for: cat *",
  "   3. No",
].join("\n");
