/**
 * The text a terminal shows, from what a program wrote to it (ADR-0091): the lines as a person
 * sees them, not the bytes. A terminal UI redraws in place (a spinner with `\r`, a frame erased
 * line by line and drawn again), so the raw stream holds every frame it ever drew; this keeps only
 * the last drawing of each cell. It reads the subset of VT100 that hosts' renderers use (cursor
 * moves, erase in line and display, the alternate screen) and treats every other escape as no
 * text. Colours, wide glyphs and scroll regions are not modelled.
 */
export interface ScreenSize {
  readonly cols: number;
  readonly rows: number;
}

const ESC = "\u001b";
const BEL = "\u0007";
/** Lines kept above the visible screen. */
const SCROLLBACK = 1000;

export class TextScreen {
  private cols: number;
  private rows: number;
  private readonly scrollback: number;
  /** Every line kept, the visible screen at the bottom; a cell is one character. */
  private lines: string[][] = [[]];
  private row = 0;
  private col = 0;
  /** The last column was written: the next character starts a new line. */
  private wrapPending = false;
  private saved: { row: number; col: number } = { row: 0, col: 0 };
  /** The main screen while the alternate one is shown. */
  private main: { lines: string[][]; row: number; col: number } | undefined;
  /** An escape sequence cut by the end of a write, kept for the next. */
  private pending = "";

  constructor(size: ScreenSize & { readonly scrollback?: number }) {
    this.cols = Math.max(1, size.cols);
    this.rows = Math.max(1, size.rows);
    this.scrollback = size.scrollback ?? SCROLLBACK;
  }

  resize(size: ScreenSize): void {
    this.cols = Math.max(1, size.cols);
    this.rows = Math.max(1, size.rows);
  }

  write(data: string): void {
    const text = this.pending + data;
    this.pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === ESC) {
        const end = this.escape(text, i);
        if (end === undefined) {
          this.pending = text.slice(i);
          return;
        }
        i = end;
        continue;
      }
      i++;
      if (ch === "\r") {
        this.col = 0;
        this.wrapPending = false;
      } else if (ch === "\n") {
        // A new line starts at the left, as a PTY's output translation (onlcr) makes it anyway.
        this.col = 0;
        this.down(1, true);
      } else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch === "\t") this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (ch >= " " && ch !== "\u007f") this.put(ch);
    }
  }

  /** The lines shown and kept, without trailing blanks, the last blank lines left out. */
  text(): string {
    const out = this.lines.map((l) => l.join("").trimEnd());
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  /** The index of the visible screen's first line. */
  private get top(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  private line(row: number): string[] {
    while (this.lines.length <= row) this.lines.push([]);
    return this.lines[row] as string[];
  }

  private put(ch: string): void {
    if (this.wrapPending) {
      this.col = 0;
      this.down(1, true);
      this.wrapPending = false;
    }
    const line = this.line(this.row);
    while (line.length < this.col) line.push(" ");
    line[this.col] = ch;
    if (this.col === this.cols - 1) this.wrapPending = true;
    else this.col++;
  }

  private down(n: number, scroll: boolean): void {
    this.wrapPending = false;
    for (let k = 0; k < n; k++) {
      if (this.row + 1 >= this.lines.length) {
        if (!scroll) return;
        this.lines.push([]);
        const limit = this.rows + this.scrollback;
        if (this.lines.length > limit) this.lines.splice(0, this.lines.length - limit);
      }
      this.row = Math.min(this.row + 1, this.lines.length - 1);
    }
  }

  private up(n: number): void {
    this.wrapPending = false;
    this.row = Math.max(this.top, this.row - n);
  }

  /** The escape at `at`, carried out; the index after it, or undefined when it is cut short. */
  private escape(text: string, at: number): number | undefined {
    const next = text[at + 1];
    if (next === undefined) return undefined;
    if (next === "[") {
      let j = at + 2;
      while (j < text.length && !/[@-~]/.test(text[j] as string)) j++;
      if (j >= text.length) return undefined;
      this.csi(text.slice(at + 2, j), text[j] as string);
      return j + 1;
    }
    if (next === "]" || next === "P" || next === "_" || next === "^") {
      // A string (a window title, a hyperlink): ends at BEL or ESC \.
      for (let j = at + 2; j < text.length; j++) {
        if (text[j] === BEL) return j + 1;
        if (text[j] === ESC && text[j + 1] === "\\") return j + 2;
      }
      return undefined;
    }
    if (next === "7") this.saved = { row: this.row - this.top, col: this.col };
    else if (next === "8") this.restore();
    else if (next === "(" || next === ")") return at + 3 <= text.length ? at + 3 : undefined;
    return at + 2;
  }

  private restore(): void {
    this.row = Math.min(this.top + this.saved.row, this.lines.length - 1);
    this.col = this.saved.col;
    this.wrapPending = false;
  }

  private csi(params: string, final: string): void {
    const priv = params.startsWith("?");
    const nums = (priv ? params.slice(1) : params).split(";").map((p) => (p === "" ? undefined : Number(p)));
    const n = (i: number, d: number) => {
      const v = nums[i];
      return v === undefined || Number.isNaN(v) || v === 0 ? d : v;
    };
    if (priv) {
      if ((final === "h" || final === "l") && nums.some((v) => v === 1049 || v === 47 || v === 1047))
        this.alternate(final === "h");
      return;
    }
    switch (final) {
      case "A":
        this.up(n(0, 1));
        return;
      case "B":
        this.down(n(0, 1), false);
        return;
      case "C":
        this.col = Math.min(this.cols - 1, this.col + n(0, 1));
        this.wrapPending = false;
        return;
      case "D":
        this.col = Math.max(0, this.col - n(0, 1));
        this.wrapPending = false;
        return;
      case "E":
        this.down(n(0, 1), false);
        this.col = 0;
        return;
      case "F":
        this.up(n(0, 1));
        this.col = 0;
        return;
      case "G":
        this.col = Math.min(this.cols - 1, n(0, 1) - 1);
        this.wrapPending = false;
        return;
      case "H":
      case "f": {
        const top = this.top;
        this.line(top + this.rows - 1);
        this.row = Math.min(top + n(0, 1) - 1, top + this.rows - 1);
        this.col = Math.min(this.cols - 1, n(1, 1) - 1);
        this.wrapPending = false;
        return;
      }
      case "J":
        this.eraseDisplay(nums[0] ?? 0);
        return;
      case "K":
        this.eraseLine(nums[0] ?? 0);
        return;
      case "s":
        this.saved = { row: this.row - this.top, col: this.col };
        return;
      case "u":
        this.restore();
        return;
      default:
        return;
    }
  }

  private eraseLine(mode: number): void {
    const line = this.line(this.row);
    if (mode === 0) line.length = Math.min(line.length, this.col);
    else if (mode === 1) for (let c = 0; c <= this.col && c < line.length; c++) line[c] = " ";
    else line.length = 0;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0);
      this.lines.length = this.row + 1;
    } else if (mode === 1) {
      for (let r = this.top; r < this.row; r++) this.lines[r] = [];
      this.eraseLine(1);
    } else {
      // The whole visible screen (3: and the scrollback); the cursor stays where it is.
      const top = mode === 3 ? 0 : this.top;
      for (let r = top; r < this.lines.length; r++) this.lines[r] = [];
    }
  }

  private alternate(on: boolean): void {
    if (on && !this.main) {
      this.main = { lines: this.lines, row: this.row, col: this.col };
      this.lines = [[]];
      this.row = 0;
      this.col = 0;
    } else if (!on && this.main) {
      ({ lines: this.lines, row: this.row, col: this.col } = this.main);
      this.main = undefined;
    }
    this.wrapPending = false;
  }
}

/** A whole stream rendered at once: what a terminal of this size shows after it. */
export function renderScreen(raw: string, size: ScreenSize): string {
  const screen = new TextScreen(size);
  screen.write(raw);
  return screen.text();
}
