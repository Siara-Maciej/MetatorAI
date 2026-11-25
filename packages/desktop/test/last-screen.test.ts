import { describe, expect, test } from "bun:test";
import { endedWhen, lastScreen, resumeCommand } from "../src/features/terminals/terminals.ts";
import type { PaneView } from "../src/shared/api/api.ts";

const ENTER = "\u001b[?1049h";
const LEAVE = "\u001b[?1049l";
// What Claude Code 2.1 prints as it exits (recorded from `/exit`): modes reset, the alternate screen
// left, then the hint to resume.
const BEFORE_LEAVE = "\u001b[?25h\u001b[?1006l\u001b[?1000l\u001b[<u";
const EXIT_TAIL =
  BEFORE_LEAVE +
  LEAVE +
  "\u001b[>4m\u001b[?2004l\u001b7\u001b[r\u001b8\u001b]0;\u0007\u001b[?25h" +
  "\r\nResume this session with:\r\nclaude --resume 8f3c21d0-5a1e-4c55-9d0b-3a5e1c2f7b10\r\n";

describe("lastScreen: a finished full-screen program keeps its last screen", () => {
  test("Claude Code's exit: the stream is cut where it left the alternate screen", () => {
    const work = `${ENTER}\u001b[2J\u001b[H✓ 14 tests pass\r\nSummary: discount per line`;
    // The modes reset before the leave stay: they draw nothing.
    expect(lastScreen(work + EXIT_TAIL)).toBe(work + BEFORE_LEAVE);
  });

  test("a stream that never entered the alternate screen is unchanged", () => {
    const shell = "$ ls\r\na.txt b.txt\r\n$ exit\r\n";
    expect(lastScreen(shell)).toBe(shell);
  });

  test("a program still in the alternate screen is unchanged", () => {
    const live = `$ claude\r\n${ENTER}drawing…`;
    expect(lastScreen(live)).toBe(live);
  });

  test("a shell that left vim and printed much after keeps its own output", () => {
    const after = `\r\n${"build output line\r\n".repeat(60)}`;
    const stream = `$ vim a.txt\r\n${ENTER}vim screen${LEAVE}${after}`;
    expect(lastScreen(stream)).toBe(stream);
  });

  test("the limit counts printed characters, not escapes", () => {
    const stream = `${ENTER}screen${LEAVE}${"\u001b[0m".repeat(500)}ok`;
    expect(lastScreen(stream, 5)).toBe(`${ENTER}screen`);
    expect(lastScreen(`${ENTER}screen${LEAVE}printed!`, 5)).toBe(`${ENTER}screen${LEAVE}printed!`);
  });

  test("the older 1047 and 47 forms are recognized too", () => {
    expect(lastScreen("\u001b[?1047hA\u001b[?1047l")).toBe("\u001b[?1047hA");
    expect(lastScreen("\u001b[?47hB\u001b[?47l")).toBe("\u001b[?47hB");
  });

  test("only the last alternate screen counts: one entered again after a leave is still on", () => {
    const stream = `${ENTER}first${LEAVE}between${ENTER}second`;
    expect(lastScreen(stream)).toBe(stream);
    expect(lastScreen(`${stream}${LEAVE}`)).toBe(stream);
  });

  test("an OSC title ended by ESC \\ is not printed text", () => {
    const stream = `${ENTER}screen${LEAVE}\u001b]0;a very long window title\u001b\\`;
    expect(lastScreen(stream, 3)).toBe(`${ENTER}screen`);
  });
});

describe("resumeCommand", () => {
  const host = (extra: object) =>
    ({ process: { kind: "host", host: "claude", agent: "mt-implementer", prompt: "", ...extra } }) as Pick<
      PaneView,
      "process"
    >;

  test("a Claude Code pane resumes by the session id it was started with", () => {
    expect(resumeCommand({ ...host({}), live: { sessionId: "abc" } })).toBe("claude --resume abc");
    expect(resumeCommand(host({ sessionId: "kept" }))).toBe("claude --resume kept");
  });

  test("another host, a command or no session id says nothing", () => {
    expect(
      resumeCommand({ process: { kind: "host", host: "copilot", agent: "a", prompt: "" } } as never),
    ).toBeUndefined();
    expect(resumeCommand({ process: { kind: "command", argv: ["bash"] } } as never)).toBeUndefined();
    expect(resumeCommand(host({}))).toBeUndefined();
  });
});

describe("endedWhen", () => {
  const at = "2026-11-19T10:12:04.000Z";
  const local = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const p = (createdAt: string) => ({ createdAt, ended: { at, reason: "exited" as const } });

  test("the local time it ended and how long it ran", () => {
    expect(endedWhen(p("2026-11-19T10:00:00.000Z"))).toBe(`${local(at)} · 12m 04s`);
    expect(endedWhen(p("2026-11-19T10:11:30.000Z"))).toBe(`${local(at)} · 34s`);
    expect(endedWhen(p("2026-11-19T08:00:00.000Z"))).toBe(`${local(at)} · 2h 12m`);
  });

  test("a pane that has not ended, or a bad start, says less", () => {
    expect(endedWhen({ createdAt: "2026-11-19T10:00:00.000Z" })).toBeUndefined();
    expect(endedWhen(p("not a date"))).toBe(local(at));
    expect(endedWhen({ createdAt: at, ended: { at: "nope", reason: "exited" } })).toBeUndefined();
  });
});
