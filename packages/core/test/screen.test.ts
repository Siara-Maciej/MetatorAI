import { describe, expect, test } from "bun:test";
import { paneStateOf, readHostPrompt } from "../src/domain/host-manifest.ts";
import { TextScreen } from "../src/domain/screen.ts";
import {
  CLAUDE_APPROVAL_OPTIONS,
  CLAUDE_APPROVAL_RAW,
  CLAUDE_APPROVAL_TEXT,
} from "./fixtures/claude-approval.ts";

const ESC = "\u001b";
const render = (raw: string, cols = 80, rows = 24) => {
  const s = new TextScreen({ cols, rows });
  s.write(raw);
  return s.text();
};

describe("TextScreen: the screen a terminal shows, from what was written to it", () => {
  test("a line redrawn with \\r shows its last drawing; escapes and colours are not text", () => {
    expect(render(`\r● · Thinking\r● ✢ Thinking\r● ✳ Done${ESC}[K\r\n`)).toBe("● ✳ Done");
    expect(render(`${ESC}[31mred${ESC}[0m plain\r\n`)).toBe("red plain");
    // A shorter drawing over a longer one keeps the rest until the line is erased.
    expect(render("abcdef\rxy\r\n")).toBe("xycdef");
    expect(render(`abcdef\rxy${ESC}[K\r\n`)).toBe("xy");
    // A bare line feed starts the next line at the left (as a PTY's onlcr makes it).
    expect(render("one\ntwo")).toBe("one\ntwo");
  });

  test("erased lines (erase line, cursor up) and a frame drawn again over them", () => {
    const first = "one\r\ntwo\r\nthree";
    const erase = `${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[G`;
    expect(render(`top\r\n${first}${erase}uno\r\ndos`)).toBe("top\nuno\ndos");
  });

  test("cursor moves: column, position, forward and back; erase to the end of the screen", () => {
    expect(render(`abc${ESC}[1Gx\r\n`)).toBe("xbc");
    expect(render(`abc${ESC}[2DZ\r\n`)).toBe("aZc");
    expect(render(`a${ESC}[3Cb\r\n`)).toBe("a   b");
    expect(render(`l1\r\nl2\r\nl3${ESC}[2;1H${ESC}[J`, 80, 3)).toBe("l1");
    expect(render(`x${ESC}[2J${ESC}[Hfresh`)).toBe("fresh");
    // An OSC (a window title) and a private mode are no text either.
    expect(render(`${ESC}]0;title\u0007${ESC}[?2004hok`)).toBe("ok");
  });

  test("a long line wraps at the terminal's width, so a frame erased by its rows is erased whole", () => {
    expect(render("abcdefgh", 4)).toBe("abcd\nefgh");
    const erase = `${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[G`;
    expect(render(`abcdefgh${erase}new`, 4)).toBe("new");
  });

  test("the screen keeps a bounded scrollback; what was written in pieces renders the same", () => {
    const s = new TextScreen({ cols: 20, rows: 5, scrollback: 10 });
    for (let i = 0; i < 100; i++) s.write(`line ${i}\r\n`);
    // 5 rows and 10 of scrollback; the last is the empty line the cursor is on.
    expect(s.text().split("\n")).toHaveLength(14);
    expect(s.text().split("\n").at(-1)).toBe("line 99");
    const whole = render(CLAUDE_APPROVAL_RAW, 100, 40);
    const pieces = new TextScreen({ cols: 100, rows: 40 });
    for (let i = 0; i < CLAUDE_APPROVAL_RAW.length; i += 7) pieces.write(CLAUDE_APPROVAL_RAW.slice(i, i + 7));
    expect(pieces.text()).toBe(whole);
  });

  test("Claude Code's approval screen renders as a person sees it: no spinner frames, the box once", () => {
    const text = render(CLAUDE_APPROVAL_RAW, 100, 40);
    expect(text).toContain("│ Bash command");
    expect(text).toContain("❯ 1. Yes");
    expect(text).not.toContain("Running…");
    expect(text).not.toContain("\r");
    expect(text.split("\n").filter((l) => l.includes("Thinking"))).toHaveLength(1);
  });
});

describe("readHostPrompt: a host's prompt as one readable line and its numbered choices", () => {
  const screen = render(CLAUDE_APPROVAL_RAW, 100, 40);

  test("Claude Code's approval box: what it asks to run and why, and its four choices", () => {
    const read = readHostPrompt(screen, "Do you want to proceed?");
    expect(read.text).toBe(CLAUDE_APPROVAL_TEXT);
    expect(read.options.map((o) => o.label)).toEqual(CLAUDE_APPROVAL_OPTIONS);
    expect(read.options.map((o) => o.key)).toEqual(["1", "2", "3", "4"]);
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

  test("the pane's state reads the prompt from the rendered screen: blocked, with the readable line and the choices", () => {
    const state = paneStateOf({
      alive: true,
      screen,
      manifest: {
        host: "claude",
        screen: { blocked: ["Do you want to (proceed|run)"], idle: [], lines: 6 },
        quietMs: 5000,
        hooks: true,
      } as never,
      now: new Date("2026-11-20T10:00:10Z"),
      lastOutputAt: new Date("2026-11-20T10:00:00Z"),
      openQuestion: false,
    });
    expect(state).toEqual({
      state: "blocked",
      reason: CLAUDE_APPROVAL_TEXT,
      menu: CLAUDE_APPROVAL_OPTIONS.map((label, i) => ({ key: String(i + 1), label })),
    });
  });
});
