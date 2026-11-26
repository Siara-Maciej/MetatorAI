/**
 * UX and accessibility fixes: a confirm before what cannot be taken back, fields that commit on
 * Enter, a conflicting key said on its row, a neutral word for work not started, the wording of
 * activity and the daemon's policy, and the Board's cards on the keyboard.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { finishQuestion, newTaskProblem } from "../src/features/backlog/model.ts";
import { planLintShown } from "../src/features/plans/plan-edit.ts";
import { activityLine, sessionOfferedAbove } from "../src/features/runs/model.ts";
import { fieldValue, keyConflicts } from "../src/features/settings/model.ts";
import { exactDuration } from "../src/features/system/model.ts";
import type { BoardCard } from "../src/shared/model/board.ts";
import { boardCards } from "../src/shared/model/board.ts";
import { closePaneQuestion, closeThreadQuestion } from "../src/shared/model/confirm.ts";
import { firstLevel, LOOKS } from "../src/shared/model/look.ts";
import type { Run } from "../src/shared/model/runs.ts";
import { filterTasks, taskState, workTasks } from "../src/shared/model/tasks.ts";

const pane = (over: Record<string, unknown> = {}) =>
  ({
    id: "w1:p2",
    role: "shell",
    label: "shell",
    process: { kind: "command" },
    live: { alive: true },
    ...over,
  }) as never;

describe("closing a live pane asks first (ui.confirmClosePane)", () => {
  test("a live pane asks with its label and id; the option off, or nothing alive, asks nothing", () => {
    expect(closePaneQuestion(pane(), true)).toBe("Close shell (w1:p2)?");
    expect(closePaneQuestion(pane(), false)).toBeUndefined();
    expect(closePaneQuestion(pane({ live: { alive: false } }), true)).toBeUndefined();
    expect(closePaneQuestion(pane({ live: undefined }), true)).toBeUndefined();
    expect(closePaneQuestion(pane({ ended: { at: "x", exitCode: 0 } }), true)).toBeUndefined();
  });
  test("a chat whose agent lives asks before it is stopped; a stopped chat closes at once", () => {
    expect(closeThreadQuestion({ title: "Invoice discount" }, pane(), true)).toBe(
      'Close the chat "Invoice discount"? Its agent stops; its tasks go on.',
    );
    expect(closeThreadQuestion({ title: "x" }, undefined, true)).toBeUndefined();
    expect(closeThreadQuestion({ title: "x" }, pane({ live: { alive: false } }), true)).toBeUndefined();
    expect(closeThreadQuestion({ title: "x" }, pane(), false)).toBeUndefined();
  });
});

describe("the Backlog's Done, Drop and + task", () => {
  test("Done and Drop say what they do and that the app cannot reopen the task", () => {
    const issue = { id: "i001", title: "Flaky checkout.spec" };
    expect(finishQuestion(issue, "done")).toBe(
      'Mark i001 "Flaky checkout.spec" done? The app cannot reopen it.',
    );
    expect(finishQuestion(issue, "drop")).toBe('Drop i001 "Flaky checkout.spec"? The app cannot reopen it.');
  });
  test("a title of spaces is no title", () => {
    expect(newTaskProblem("   ")).toBe("a task needs a title");
    expect(newTaskProblem("")).toBe("a task needs a title");
    expect(newTaskProblem(" Flaky ")).toBeUndefined();
  });
});

describe("a settings field", () => {
  const number = { kind: "number" as const };
  test("an emptied number changes nothing; a typed one is a number; the same value changes nothing", () => {
    expect(fieldValue(number, "", 5000)).toBeUndefined();
    expect(fieldValue(number, "  ", 5000)).toBeUndefined();
    expect(fieldValue(number, "5000", 5000)).toBeUndefined();
    expect(fieldValue(number, "0", 5000)).toEqual({ value: 0 });
    expect(fieldValue(number, "90000", 5000)).toEqual({ value: 90000 });
    expect(fieldValue(number, "abc", 5000)).toBeUndefined();
  });
  test("lists and keys are split on commas; text is kept as typed; the same text changes nothing", () => {
    expect(fieldValue({ kind: "keybinding" }, "prefix+z, f5", ["prefix+z"])).toEqual({
      value: ["prefix+z", "f5"],
    });
    expect(fieldValue({ kind: "list" }, "a, , b", ["a"])).toEqual({ value: ["a", "b"] });
    expect(fieldValue({ kind: "keybinding" }, "prefix+z", ["prefix+z"])).toBeUndefined();
    expect(fieldValue({ kind: "string" }, "zsh", "")).toEqual({ value: "zsh" });
    expect(fieldValue({ kind: "command" }, "", "code")).toEqual({ value: "" });
    expect(fieldValue({ kind: "string" }, "zsh", "zsh")).toBeUndefined();
  });

  const key = (k: string, value: readonly string[]) =>
    ({ key: k, value, definition: { kind: "keybinding" } }) as never;
  test("a key bound twice is said on both rows, whatever its case or spelling of escape", () => {
    const conflicts = keyConflicts([
      key("keys.zoom", ["prefix+z"]),
      key("keys.closePane", ["prefix+x", "Prefix+Z"]),
      key("keys.release", ["prefix+escape"]),
      key("keys.copyMode", ["prefix+esc"]),
      key("keys.help", ["prefix+?"]),
      { key: "ui.paneLabels", value: true, definition: { kind: "boolean" } } as never,
    ]);
    expect(conflicts).toEqual({
      "keys.zoom": ["prefix+z is also keys.closePane"],
      "keys.closePane": ["Prefix+Z is also keys.zoom"],
      "keys.release": ["prefix+escape is also keys.copyMode"],
      "keys.copyMode": ["prefix+esc is also keys.release"],
    });
    expect(keyConflicts([key("keys.zoom", ["prefix+z"]), key("keys.help", ["prefix+?"])])).toEqual({});
  });
});

describe("work not started reads to do, not blocked", () => {
  test("a backlog task not started is to do; a step that waits and a run nothing drives stay blocked", () => {
    expect(firstLevel("todo")).toBe("to do");
    expect(firstLevel("pending")).toBe("blocked");
    expect(firstLevel("idle")).toBe("blocked");
    expect(LOOKS.first["to do"]).toEqual({ glyph: "○", tone: "faint" });
  });
  test("the Board's blocked filter does not match a task not started", () => {
    const tasks = workTasks(
      boardCards({
        runs: [],
        issues: [
          {
            repo: "shop",
            issues: [
              {
                id: "i001",
                title: "Flaky",
                status: "open",
                createdAt: "2026-11-18T10:00:00Z",
                updatedAt: "2026-11-18T10:00:00Z",
              } as never,
            ],
          },
        ],
        plans: [],
        now: Date.parse("2026-11-18T12:00:00Z"),
      }),
      [],
    );
    expect(tasks.map(taskState)).toEqual(["to do"]);
    expect(filterTasks(tasks, { repos: [], states: ["blocked"], text: "" })).toEqual([]);
  });
});

describe("wording", () => {
  test("an event that names its agent does not name it twice", () => {
    expect(activityLine({ agent: "mt-implementer", text: "mt-implementer started" })).toBe(
      "mt-implementer started",
    );
    expect(activityLine({ agent: "mt-implementer", text: "wrote src/a.ts" })).toBe(
      "mt-implementer wrote src/a.ts",
    );
    expect(activityLine({ text: "stage build" })).toBe("stage build");
  });
  test("the daemon's policy durations are exact", () => {
    expect(exactDuration(90_000)).toBe("1.5 min");
    expect(exactDuration(60_000)).toBe("1 min");
    expect(exactDuration(45_000)).toBe("45 s");
    expect(exactDuration(100_000)).toBe("100 s");
    expect(exactDuration(5_400_000)).toBe("1.5 h");
    expect(exactDuration(1500)).toBe("1500 ms");
  });
  test("a plan's lint shows only for a workflow that writes a plan, or a board that has one", () => {
    expect(planLintShown({ artifactsOfWorkflow: ["plan.json", "report.md"] }, false)).toBe(true);
    expect(planLintShown({ artifactsOfWorkflow: ["report.md"] }, false)).toBe(false);
    expect(planLintShown({ artifactsOfWorkflow: [] }, true)).toBe(true);
    expect(planLintShown(undefined, true)).toBe(false);
  });
});

describe("a run's Terminal tab with no terminal", () => {
  const run = (over: Partial<Run> = {}): Run =>
    ({
      runId: "r1",
      status: "active",
      attention: "stopped",
      questions: [],
      driving: false,
      driver: "agent",
      stages: [],
      ...over,
    }) as Run;
  test("the bar above offers a session for an idle run, and for one whose question waits on a card", () => {
    expect(sessionOfferedAbove(run(), [])).toBe(true);
    expect(sessionOfferedAbove(run({ questions: [{ id: "q1" }] as never }), [])).toBe(true);
  });
  test("a run driven in the background has no bar: the tab offers the session itself", () => {
    expect(sessionOfferedAbove(run({ driving: true, attention: "driving" }), [])).toBe(false);
    expect(sessionOfferedAbove(run({ status: "done" }), [])).toBe(false);
  });
});

describe("a Board card on the keyboard", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("Space opens the card; Space on its own Start a run does not open it; the card is named", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { CardTile } = await import("../src/features/board/tiles.tsx");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onOpen = mock(() => {});
    const onStart = mock(() => {});
    const card = {
      key: "issue:shop/i001",
      kind: "issue",
      column: "todo",
      title: "Flaky checkout.spec",
      repo: "shop",
      state: "todo",
      ageMs: 0,
      updatedAt: "2026-11-18T10:00:00Z",
      needsYou: false,
      escalated: false,
      issueId: "i001",
    } as BoardCard;
    await act(() =>
      root.render(
        <CardTile card={card} col={0} row={0} onOpen={onOpen} onStart={onStart} onDrag={() => {}} />,
      ),
    );
    const tile = host.querySelector<HTMLElement>("[role=button]");
    expect(tile?.getAttribute("aria-label")).toBe("Flaky checkout.spec, to do");
    expect(tile?.textContent).toContain("to do");
    const space = () => new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(() => {
      tile?.dispatchEvent(space());
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    const start = host.querySelector<HTMLElement>("button.card-action");
    await act(() => {
      start?.dispatchEvent(space());
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
  });
});
