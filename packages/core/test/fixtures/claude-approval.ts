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
