import { describe, expect, test } from "bun:test";
import {
  addPane,
  addTab,
  addWorkspace,
  EMPTY_LAYOUT,
  LayoutDocument,
  paneOf,
  panesOf,
  removePane,
  removeWorkspace,
  stripAnsi,
  tailLines,
  updatePane,
  workspaceOfRun,
} from "../src/domain/layout.ts";

const AT = "2026-11-09T10:00:00.000Z";
const shell = { kind: "command" as const, argv: ["sh"] };

describe("layout", () => {
  test("workspaces, tabs and panes get ids that count up and are never reused", () => {
    const w1 = addWorkspace(EMPTY_LAYOUT, { label: "repo", cwd: "/repo", at: AT });
    const w2 = addWorkspace(w1.layout, {
      label: "r",
      cwd: "/repo/.metator/wt/r",
      runId: "r",
      group: "w1",
      at: AT,
    });
    expect([w1.workspace.id, w1.workspace.tabs[0]?.id, w1.workspace.tabs[0]?.label]).toEqual([
      "w1",
      "w1:t1",
      "main",
    ]);
    expect([w2.workspace.id, w2.workspace.tabs[0]?.label, w2.workspace.group, w2.workspace.runId]).toEqual([
      "w2",
      "run",
      "w1",
      "r",
    ]);
    const p1 = addPane(w2.layout, {
      workspace: "w2",
      role: "conductor",
      label: "c",
      cwd: "/x",
      process: shell,
      runId: "r",
      at: AT,
    });
    const t2 = addTab(p1?.layout ?? EMPTY_LAYOUT, "w2", "apps");
    const p2 = addPane(t2?.layout ?? EMPTY_LAYOUT, {
      workspace: "w2",
      tab: "w2:t2",
      role: "apps",
      label: "logs",
      cwd: "/x",
      process: shell,
      at: AT,
    });
    expect([p1?.pane.id, t2?.tab.id, p2?.pane.id, p2?.pane.tab]).toEqual([
      "w2:p1",
      "w2:t2",
      "w2:p2",
      "w2:t2",
    ]);
    const layout = p2?.layout ?? EMPTY_LAYOUT;
    expect(panesOf(layout, "w2").map((p) => p.id)).toEqual(["w2:p1", "w2:p2"]);
    expect(workspaceOfRun(layout, "r")?.id).toBe("w2");
    // Removing the pane in the second tab removes the emptied tab; the first tab stays even when empty.
    const less = removePane(layout, "w2:p2");
    expect(workspaceOfRun(less, "r")?.tabs.map((t) => t.id)).toEqual(["w2:t1"]);
    const empty = removePane(less, "w2:p1");
    expect(workspaceOfRun(empty, "r")?.tabs).toEqual([{ id: "w2:t1", label: "run", panes: [] }]);
    const next = addPane(empty, {
      workspace: "w2",
      role: "shell",
      label: "sh",
      cwd: "/x",
      process: shell,
      at: AT,
    });
    expect(next?.pane.id).toBe("w2:p3");
    expect(removeWorkspace(next?.layout ?? EMPTY_LAYOUT, "w2")).toMatchObject({
      workspaces: [w1.workspace],
      panes: [],
    });
    expect(
      addPane(layout, { workspace: "w9", role: "shell", label: "x", cwd: "/x", process: shell, at: AT }),
    ).toBeUndefined();
    expect(addTab(layout, "w9", "x")).toBeUndefined();
  });

  test("a pane's session id is kept in its record; the document round-trips", () => {
    const p = addPane(addWorkspace(EMPTY_LAYOUT, { label: "repo", cwd: "/repo", at: AT }).layout, {
      workspace: "w1",
      role: "worker",
      label: "impl",
      cwd: "/repo",
      process: { kind: "host", host: "copilot", agent: "mt-implementer", prompt: "do it" },
      runId: "r",
      worker: { name: "impl-1", stage: "build" },
      at: AT,
    });
    const layout = updatePane(p?.layout ?? EMPTY_LAYOUT, "w1:p1", (pane) =>
      pane.process.kind === "host" ? { ...pane, process: { ...pane.process, sessionId: "s-1" } } : pane,
    );
    expect(paneOf(layout, "w1:p1")?.process).toEqual({
      kind: "host",
      host: "copilot",
      agent: "mt-implementer",
      prompt: "do it",
      sessionId: "s-1",
    });
    const parsed = LayoutDocument.parse(LayoutDocument.stamp(layout), "layout.json");
    expect(parsed._unsafeUnwrap()).toEqual(layout);
  });

  test("terminal text loses its escapes; the tail keeps the last lines", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m \x1b]0;title\x07done\x1b[2J")).toBe("ok done");
    expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });
});
