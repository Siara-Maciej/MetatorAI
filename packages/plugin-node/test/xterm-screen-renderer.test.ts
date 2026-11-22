import { describe, expect, test } from "bun:test";
import { paneStateOf, readHostPrompt } from "@metator/core";
import {
  CLAUDE_APPROVAL_OPTIONS,
  CLAUDE_APPROVAL_RAW,
  CLAUDE_APPROVAL_TEXT,
  FakeScreenRenderer,
  screenRendererContract,
} from "@metator/testing";
import { XtermScreenRenderer } from "../src/xterm-screen-renderer.ts";

screenRendererContract("XtermScreenRenderer", () => new XtermScreenRenderer());

const rendered = async (raw: string, cols = 100, rows = 40) => {
  const s = new XtermScreenRenderer().open({ cols, rows });
  s.write(raw);
  const text = await s.text();
  s.dispose();
  return text;
};

describe("a host's prompt read from the screen @xterm/headless renders", () => {
  test("Claude Code's approval box: what it asks to run and why, and its four choices", async () => {
    const read = readHostPrompt(await rendered(CLAUDE_APPROVAL_RAW), "Do you want to proceed?");
    expect(read.text).toBe(CLAUDE_APPROVAL_TEXT);
    expect(read.options.map((o) => o.label)).toEqual(CLAUDE_APPROVAL_OPTIONS);
    expect(read.options.map((o) => o.key)).toEqual(["1", "2", "3", "4"]);
  });

  test("the pane's state from that screen: blocked, the readable line, the choices", async () => {
    const state = paneStateOf({
      alive: true,
      screen: await rendered(CLAUDE_APPROVAL_RAW),
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
    expect([state.state, state.reason, state.menu?.map((m) => m.label)]).toEqual([
      "blocked",
      CLAUDE_APPROVAL_TEXT,
      CLAUDE_APPROVAL_OPTIONS,
    ]);
  });

  test("the unit tests' fake renders the plain fixtures the same", async () => {
    const fake = new FakeScreenRenderer().open({ cols: 100, rows: 40 });
    fake.write(CLAUDE_APPROVAL_RAW);
    expect(await fake.text()).toBe(await rendered(CLAUDE_APPROVAL_RAW));
  });
});
