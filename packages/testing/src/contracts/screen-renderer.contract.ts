import { describe, expect, test } from "bun:test";
import type { ScreenRenderer } from "@metator/core";
import { CLAUDE_APPROVAL_RAW, CLAUDE_SCROLLED_RAW } from "../fixtures/claude-screens.ts";

const ESC = "\u001b";

/**
 * Every ScreenRenderer adapter must pass this suite (MT-TEST-002): what a terminal shows after
 * a program wrote to it, as a person reads it: the last drawing of each cell, no escapes, rows
 * without trailing blanks, the last blank rows left out.
 */
export function screenRendererContract(name: string, make: () => ScreenRenderer): void {
  const render = async (raw: string, cols = 80, rows = 24) => {
    const s = make().open({ cols, rows });
    s.write(raw);
    const text = await s.text();
    s.dispose();
    return text;
  };

  describe(`ScreenRenderer contract: ${name}`, () => {
    test("a line redrawn with \\r shows its last drawing; escapes and colours are not text", async () => {
      expect(await render(`\r● · Thinking\r● ✢ Thinking\r● ✳ Done${ESC}[K\r\n`)).toBe("● ✳ Done");
      expect(await render(`${ESC}[31mred${ESC}[0m plain\r\n`)).toBe("red plain");
      // A shorter drawing over a longer one keeps the rest until the line is erased.
      expect(await render("abcdef\rxy\r\n")).toBe("xycdef");
      expect(await render(`abcdef\rxy${ESC}[K\r\n`)).toBe("xy");
      // A bare line feed starts the next line at the left (as a PTY's onlcr makes it).
      expect(await render("one\ntwo")).toBe("one\ntwo");
    });

    test("erased lines (erase line, cursor up) and a frame drawn again over them", async () => {
      const first = "one\r\ntwo\r\nthree";
      const erase = `${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[G`;
      expect(await render(`top\r\n${first}${erase}uno\r\ndos`)).toBe("top\nuno\ndos");
    });

    test("cursor moves: column, position, forward and back; erase to the end of the screen", async () => {
      expect(await render(`abc${ESC}[1Gx\r\n`)).toBe("xbc");
      expect(await render(`abc${ESC}[2DZ\r\n`)).toBe("aZc");
      expect(await render(`a${ESC}[3Cb\r\n`)).toBe("a   b");
      expect(await render(`l1\r\nl2\r\nl3${ESC}[2;1H${ESC}[J`, 80, 3)).toBe("l1");
      expect(await render(`x${ESC}[2J${ESC}[Hfresh`)).toBe("fresh");
      // An OSC (a window title) and a private mode are no text either.
      expect(await render(`${ESC}]0;title\u0007${ESC}[?2004hok`)).toBe("ok");
    });

    test("a long line wraps at the terminal's width, so a frame erased by its rows is erased whole", async () => {
      expect(await render("abcdefgh", 4)).toBe("abcd\nefgh");
      const erase = `${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[G`;
      expect(await render(`abcdefgh${erase}new`, 4)).toBe("new");
    });

    test("a wide glyph takes two cells: an emoji and an East Asian letter, as a UI counts them", async () => {
      expect(await render(`😀${ESC}[3Gx\r\n`)).toBe("😀x");
      expect(await render(`漢字${ESC}[5Gok\r\n`)).toBe("漢字ok");
      // A frame with an emoji, redrawn by column: the cursor lands where the UI meant.
      expect(await render(`● ✅ done ${ESC}[1G● ✅ DONE\r\n`)).toBe("● ✅ DONE");
    });

    test("a scroll region scrolls inside itself: the rows below it stay where they are", async () => {
      // Rows 1-3 scroll; row 4 is a footer the UI drew once.
      const raw = `${ESC}[4;1Hfooter${ESC}[1;3r${ESC}[1;1H${["a", "b", "c", "d", "e"].join("\r\n")}${ESC}[r`;
      const shown = (await render(raw, 20, 4)).split("\n");
      expect(shown.slice(-4)).toEqual(["c", "d", "e", "footer"]);
    });

    test("the screen keeps a bounded scrollback; what was written in pieces renders the same", async () => {
      const s = make().open({ cols: 20, rows: 5, scrollback: 10 });
      for (let i = 0; i < 100; i++) s.write(`line ${i}\r\n`);
      const lines = (await s.text()).split("\n");
      // 5 rows and 10 of scrollback; the last is the empty line the cursor is on.
      expect(lines).toHaveLength(14);
      expect(lines.at(-1)).toBe("line 99");
      s.dispose();
      const whole = await render(CLAUDE_APPROVAL_RAW, 100, 40);
      const pieces = make().open({ cols: 100, rows: 40 });
      for (let i = 0; i < CLAUDE_APPROVAL_RAW.length; i += 7)
        pieces.write(CLAUDE_APPROVAL_RAW.slice(i, i + 7));
      expect(await pieces.text()).toBe(whole);
      pieces.dispose();
    });

    test("Claude Code's approval screen renders as a person sees it: no spinner frames, the box once", async () => {
      const text = await render(CLAUDE_APPROVAL_RAW, 100, 40);
      expect(text).toContain("│ Bash command");
      expect(text).toContain("❯ 1. Yes");
      expect(text).not.toContain("Running…");
      expect(text).not.toContain("\r");
      expect(text.split("\n").filter((l) => l.includes("Thinking"))).toHaveLength(1);
    });

    test("Claude Code's output scrolled in its region above the prompt: the last lines and the prompt, once", async () => {
      const text = await render(CLAUDE_SCROLLED_RAW, 60, 12);
      const rows = text.split("\n");
      // The region scrolled, not the screen: the tool's line stays on top, nothing went to scrollback.
      expect(rows).toHaveLength(12);
      expect(rows[0]).toBe("● Bash(bun test)");
      expect(rows.at(-1)).toBe(" Do you want to proceed? ✅");
      expect(rows.filter((r) => r.includes("Do you want to proceed?"))).toHaveLength(1);
      expect(text).toContain("↑ 37 more lines");
      expect(text).toContain("test 40 passed");
    });

    test("a resize keeps what is shown", async () => {
      const s = make().open({ cols: 40, rows: 10 });
      s.write("kept\r\n");
      s.resize({ cols: 60, rows: 12 });
      expect(await s.text()).toBe("kept");
      s.dispose();
    });
  });
}
