import type { PtySize, ScreenModel, ScreenRenderer } from "@metator/core";
import { Terminal } from "@xterm/headless";

/** Rows kept above the visible screen. */
const SCROLLBACK = 1000;

/**
 * ScreenRenderer on @xterm/headless (ADR-0091): the terminal the desktop app draws, without a
 * window. Each pane's output goes through a real VT parser, so cursor moves, erasing, wrapping,
 * scroll regions and the alternate screen are what a person sees; the rows are read back as text.
 */
export class XtermScreenRenderer implements ScreenRenderer {
  open(size: PtySize & { readonly scrollback?: number }): ScreenModel {
    const term = new Terminal({
      cols: Math.max(1, size.cols),
      rows: Math.max(1, size.rows),
      scrollback: size.scrollback ?? SCROLLBACK,
      allowProposedApi: true,
      // A bare line feed starts the next line at the left, as a PTY's output translation does.
      convertEol: true,
    });
    term.unicode.register(WIDE_EMOJI);
    term.unicode.activeVersion = WIDE_EMOJI.version;
    return {
      write: (data) => term.write(data),
      resize: (s) => term.resize(Math.max(1, s.cols), Math.max(1, s.rows)),
      // Written data is parsed asynchronously: an empty write's callback comes after all of it.
      text: () => new Promise<string>((resolve) => term.write("", () => resolve(rowsOf(term)))),
      dispose: () => term.dispose(),
    };
  }
}

function rowsOf(term: Terminal): string {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < buffer.length; i++)
    rows.push((buffer.getLine(i)?.translateToString(true) ?? "").trimEnd());
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.join("\n");
}

/**
 * Character widths as terminal UIs count them (`string-width`): an emoji drawn as a picture takes
 * two cells, as East Asian wide and fullwidth letters do; marks and format characters take none.
 * xterm's built-in Unicode 6 table counts an emoji as one cell, so a UI's cursor arithmetic after
 * an emoji would land one cell off.
 */
const WIDE_EMOJI = {
  version: "metator-wide-emoji",
  wcwidth(codepoint: number): 0 | 1 | 2 {
    if (codepoint < 32 || (codepoint >= 0x7f && codepoint < 0xa0)) return 0;
    const ch = String.fromCodePoint(codepoint);
    if (ZERO.test(ch)) return 0;
    if (EMOJI.test(ch) || WIDE.some(([a, b]) => codepoint >= a && codepoint <= b)) return 2;
    return 1;
  },
  charProperties(codepoint: number, _preceding: number): number {
    // xterm's packed value: the width in bits 1-2, no grapheme state, never joined.
    return (WIDE_EMOJI.wcwidth(codepoint) & 3) << 1;
  },
};
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;
/** East Asian Wide and Fullwidth blocks (UAX #11). */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];
