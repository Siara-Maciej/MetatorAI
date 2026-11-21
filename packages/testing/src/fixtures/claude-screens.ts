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

/** The input box under Claude Code's last message: its rule, its prompt, its footer. */
const INPUT_BOX = [
  "──────────────────────────────── mt-orchestrator ─",
  "❯",
  "──────────────────────────────────────────────────",
  "  ⏸ manual mode on · ? for shortcuts",
];

/**
 * A real conductor (Claude Code, shop-web) that ended its turn with a question in words and
 * numbered options, and waited: the rendered screen, verbatim.
 */
export const CLAUDE_TEXT_QUESTION_SCREEN = [
  " ● The gatekeeper (mt-gatekeeper-1) stopped: gates.quick has no steps in",
  "   metator.config.yml (only gates.full exists: typecheck, test).",
  "",
  "   Options:",
  "   1. Start the gatekeeper again and have it run",
  "      only metator gate full, skipping the empty",
  "      quick gate. This is what I'd recommend.",
  "   2. You add steps to gates.quick in the config",
  "      first, then I run the gatekeeper again.",
  "   3. Stop the run.",
  "   4. Something else you'd like.",
  "",
  " ✻ Crunched for 5s · done 6:48 PM",
  "",
  ...INPUT_BOX,
].join("\n");

/** The same conductor's later turns, after a nudge: it says it still waits. */
export const CLAUDE_STILL_WAITING_SCREEN = [
  " ● Still waiting for your reply: 1, 2 or 3.",
  "",
  " ● Still waiting for your reply: 1, 2 or 3 (or 4).",
  "",
  ...INPUT_BOX,
].join("\n");

/** A real conductor (billing) that offered words to reply with, as bullets. */
export const CLAUDE_BULLETED_REPLY_SCREEN = [
  " ● mt-gatekeeper-2 stopped as well: the gates did not run in its worktree.",
  "",
  "   What I can do next, reply with one of:",
  '   - "start a gatekeeper": I start a third one.',
  '   - "gates pass" or "gates fail": you ran them yourself and tell me the result.',
  '   - "stop": I close the run as aborted.',
  "",
  "   Reply in your own words if none fits, or just tell me here.",
  "",
  ...INPUT_BOX,
].join("\n");

/** Turns that ask nobody anything: a progress report, a wait for a worker, a finished summary. */
export const CLAUDE_NOT_A_QUESTION_SCREENS = [
  [
    " ● Delegated build to mt-implementer-1 and mt-implementer-2. They work in parallel;",
    "   I collect both when they report.",
    "",
    ...INPUT_BOX,
  ].join("\n"),
  [" ● Waiting for mt-gatekeeper-1…", "", ...INPUT_BOX].join("\n"),
  [
    " ● Done: all 3 steps are merged and the gates pass.",
    "   - billing: the new currency field and its migration",
    "   - shop-api: prices converted at the daily rate",
    "   - shop-web: the price tag shows the currency",
    "",
    " ✻ Worked for 2m 10s",
    "",
    ...INPUT_BOX,
  ].join("\n"),
];

/**
 * The real conversation agent (Claude Code, mt-chat, 2026-11-21) proposing the quick way and
 * then asking two numbered clarifying questions, with Claude Code's side panel drawn at the right
 * (the `│` column): the rendered screen, verbatim. Its numbered items are questions and
 * explanations, not choices.
 */
export const CLAUDE_CLARIFYING_QUESTIONS_SCREEN = [
  "                                                                                     │",
  "  price, with a test for it. This one is meant to stay.                              │",
  "                                                                                     │",
  "  Ran 1 shell command                                                                │",
  "                                                                                     │",
  "● This is too small for the full workflow: do it as quick? The check passed with no  │",
  "  escalators. It would touch src/catalog.ts (lowercase the SKU before the lookup) and│",
  "  test/server.test.ts (a test that MUG-01 returns 3990).                             │                      No changes this session",
  "                                                                                     │",
  "  Two things to settle first:                                                        │",
  "                                                                                     │",
  "  1. Which SKU goes back in the response? For GET /prices/MUG-01, should the body say│",
  '     "sku": "mug-01" (the catalog\'s own spelling, my recommendation) or "MUG-01"     │',
  "     (exactly what was requested)? Right now server.ts:12 sends back whatever was    │",
  "     requested.                                                                      │",
  "  2. The debug line is gone. It was removed from src/server.ts on disk after the     │",
  "     commit, so the checkout now has an uncommitted change that takes it out. The    │",
  "     quick run may then ask whether to run here (alongside that change) or in a      │",
  "     worktree of its own. I'd use a worktree to keep the two apart.                  │",
  "                                                                                     │",
  "  Say yes and answer those two, and I'll start the quick run.                        │",
  "                                                                                     │",
  "✻ Cooked for 8s · done 7:24 PM                                                       │",
  "                                                                                     │",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── mt-chat ─",
  "❯",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ manual mode on · ? for shortcuts",
].join("\n");

/**
 * The same agent's status report after it started the quick run (verbatim): bullets of
 * `Label: value` facts, no question, "I'll correct it if you meant otherwise". It asks nothing.
 */
export const CLAUDE_STATUS_REPORT_SCREEN = [
  '● I started the quick run. I took your "yes" as accepting both',
  "  recommendations; I'll correct it if you meant otherwise.",
  "",
  "  - Run: 20261121-mt-quick-make-the-sku-lookup-case-insensitive-so",
  "  - Its terminal: pane w2:p2, at the build stage.",
  "  - SKU in the response: I wrote into the task that it should be the",
  "    catalog's spelling (mug-01 for /prices/MUG-01). That probably means",
  "    touching src/server.ts as well, not only the two files I listed.",
  "  - Where it runs: it didn't ask \"here or worktree\", so it didn't flag the",
  "    checkout as dirty. I didn't pick a worktree, and I haven't checked",
  "    whether it's working in this checkout. If it is, the run's diff will",
  "    sit next to the uncommitted removal of the debug line in src/server.ts.",
  "    Keep that in mind when you look at the result.",
  "",
  '  It ends with an uncommitted diff and a "Quick change ready: look at the',
  '  diff" card in your inbox. Nothing gets committed.',
  "",
  "  What I did: quick, run",
  "  20261121-mt-quick-make-the-sku-lookup-case-insensitive-so.",
  "",
  "✻ Cooked for 21s · done 7:26 PM",
  "",
  ...INPUT_BOX,
].join("\n");

/** The same agent's answer to a question about the code (verbatim, cut): a numbered explanation; "which matches" asks nothing. */
export const CLAUDE_NUMBERED_ANSWER_SCREEN = [
  "● GET /prices/{sku} doesn't calculate anything. It looks the SKU up in a fixed table and returns the stored net price.",
  "",
  "  How a request is handled",
  '  1. Route check: handle matches the path against ^/prices/([^/]+)$. Anything other than a GET to that path gets 404 "not found" (src/server.ts:7-8).',
  "  2. SKU: the path segment is URL-decoded (src/server.ts:9).",
  "  3. Lookup: priceCentsOf(sku) (src/server.ts:10) just reads CATALOG[sku] (src/catalog.ts:8).",
  '  4. Unknown SKU: if there\'s no entry, it returns 404 "unknown product" (src/server.ts:11).',
  "  5. Response: { sku, amountCents } as JSON (src/server.ts:12-13). Its shape is PriceResponse (src/contract.ts:2-6), which matches openapi.yaml:15-19.",
  "",
  "  What I did: direct (reading only). I changed nothing, and there's nothing uncommitted and no scratch to clean up.",
  "",
  "✻ Cooked for 13s · done 7:21 PM",
  "",
  ...INPUT_BOX,
].join("\n");
