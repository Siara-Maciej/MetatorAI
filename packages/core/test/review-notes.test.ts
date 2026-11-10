import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  editorArgv,
  InitRun,
  nextNoteId,
  notesMessage,
  notesRefs,
  OpenEditor,
  ok,
  parseUnifiedDiff,
  type ReviewNote,
  ReviewNotes,
  RunChanges,
  RunJournal,
  RunMessages,
  RunRepository,
  WorkflowCatalog,
  withReplies,
} from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const PATCH = `diff --git a/src/invoice.ts b/src/invoice.ts
index 1111111..2222222 100644
--- a/src/invoice.ts
+++ b/src/invoice.ts
@@ -1,4 +1,5 @@
 export function round2(n: number) {
-  return Math.round(n * 100) / 100;
+  const sign = n < 0 ? -1 : 1;
+  return (sign * Math.round(Math.abs(n) * 100)) / 100;
 }
 
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
diff --git a/.metator/runs/x/plan.json b/.metator/runs/x/plan.json
new file mode 100644
--- /dev/null
+++ b/.metator/runs/x/plan.json
@@ -0,0 +1 @@
+{}
`;

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-09T22:40:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const initRun = new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock);
  const messages = new RunMessages(fs, repo, journal, clock);
  const notes = new ReviewNotes({ fs, repo, messages, clock });
  return { fs, clock, repo, journal, initRun, messages, notes };
}

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  id: "n001",
  file: "src/invoice.ts",
  line: 3,
  side: "new",
  text: "half-down for negatives?",
  by: "maciej",
  at: "2026-11-09T22:40:00.000Z",
  status: "draft",
  ...over,
});

describe("review-note domain", () => {
  test("ids count up; the message lists each note with its place; refs are the files once", () => {
    expect(nextNoteId([])).toBe("n001");
    expect(nextNoteId(["n001", "n003"])).toBe("n004");
    const text = notesMessage([
      note(),
      note({ id: "n002", file: undefined, line: undefined, side: undefined, text: "tests?" }),
      note({ id: "n003", side: "old", text: "old" }),
    ]);
    expect(text.split("\n")).toEqual([
      "Review notes from a person on this change:",
      "- src/invoice.ts:3: half-down for negatives?",
      "- the change: tests?",
      "- src/invoice.ts:3 (old): old",
    ]);
    expect(notesRefs([note(), note({ id: "n002" }), note({ id: "n003", file: "src/new.ts" })])).toEqual([
      "src/invoice.ts",
      "src/new.ts",
    ]);
  });

  test("a unified diff parses into files with counts and numbered lines", () => {
    const files = parseUnifiedDiff(PATCH);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["src/invoice.ts", "modified", 2, 1],
      ["src/new.ts", "added", 2, 0],
      [".metator/runs/x/plan.json", "added", 1, 0],
    ]);
    const lines = files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["context", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["add", undefined, 3],
      ["context", 3, 4],
      ["context", 4, 5],
    ]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test("the editor argv: VS Code gets -r, the directory and --goto; a terminal editor +line; others the file", () => {
    expect(editorArgv("code", { dir: "/w", file: "src/a.ts", line: 10, reuse: true })).toEqual([
      "code",
      "-r",
      "/w",
      "--goto",
      "/w/src/a.ts:10",
    ]);
    expect(editorArgv("cursor --new-window", { dir: "/w" })).toEqual(["cursor", "--new-window", "/w"]);
    expect(editorArgv("nvim", { dir: "/w", file: "src/a.ts", line: 10 })).toEqual([
      "nvim",
      "+10",
      "/w/src/a.ts",
    ]);
    expect(editorArgv("zed", { dir: "/w", file: "src/a.ts", line: 10 })).toEqual(["zed", "/w/src/a.ts"]);
    expect(editorArgv("zed", { dir: "/w" })).toEqual(["zed", "/w"]);
  });

  test("a sent note reads as addressed once a review reply names its message", () => {
    const sent = note({ status: "sent", sentIn: "m001" });
    const reply = {
      id: "m002",
      fromRun: "r",
      toRun: "r",
      at: "",
      topic: "review-reply" as const,
      text: "done",
      refs: ["m001"],
      by: "mt-implementer-1",
    };
    expect(withReplies([sent, note({ id: "n002" })], [reply]).map((n) => n.status)).toEqual([
      "addressed",
      "draft",
    ]);
    expect(withReplies([sent], [{ ...reply, topic: "info" }]).map((n) => n.status)).toEqual(["sent"]);
  });
});

describe("ReviewNotes", () => {
  test("add, send as one review message, the notes remember it; a reply marks them addressed; status by hand", async () => {
    const w = world();
    const run = (await w.initRun.execute({ workflow: "demo", task: "Add the discount" }))._unsafeUnwrap();
    expect((await w.notes.add(run.runId, { text: " ", by: "maciej" })).isErr()).toBe(true);
    expect((await w.notes.add(run.runId, { line: 3, text: "x", by: "maciej" })).isErr()).toBe(true);
    const a = (
      await w.notes.add(run.runId, {
        file: "src/invoice.ts",
        line: 3,
        side: "new",
        text: "half-down?",
        by: "maciej",
      })
    )._unsafeUnwrap();
    const b = (await w.notes.add(undefined, { text: "tests for 1000.00", by: "maciej" }))._unsafeUnwrap();
    expect([a.id, b.id, a.status]).toEqual(["n001", "n002", "draft"]);
    expect(await w.fs.exists(`${DEFAULT_PATHS.runs}/${run.runId}/review/notes.json`)).toBe(true);
    expect((await w.notes.send(run.runId, { by: "maciej" })).isOk()).toBe(true);
    const sent = (await w.notes.list(run.runId))._unsafeUnwrap();
    expect(sent.notes.map((n) => [n.status, n.sentIn])).toEqual([
      ["sent", "m001"],
      ["sent", "m001"],
    ]);
    const messages = (await w.messages.list(run.runId))._unsafeUnwrap();
    expect(messages.map((m) => [m.topic, m.refs, m.by])).toEqual([["review", ["src/invoice.ts"], "maciej"]]);
    expect(messages[0]?.text).toContain("- src/invoice.ts:3: half-down?");
    // Nothing left to send; a reply from the agent addresses them; the person can reopen one.
    expect((await w.notes.send(run.runId, { by: "maciej" })).isErr()).toBe(true);
    (
      await w.messages.send({
        from: run.runId,
        to: run.runId,
        topic: "review-reply",
        text: "rounded half-down",
        refs: ["m001"],
        by: "mt-implementer-1",
      })
    )._unsafeUnwrap();
    expect((await w.notes.list(run.runId))._unsafeUnwrap().notes.map((n) => n.status)).toEqual([
      "addressed",
      "addressed",
    ]);
    const reopened = (await w.notes.setStatus(run.runId, "n002", "draft"))._unsafeUnwrap();
    expect([reopened.status, reopened.sentIn]).toEqual(["draft", undefined]);
    expect((await w.notes.setStatus(run.runId, "n009", "addressed")).isErr()).toBe(true);
  });
});

describe("OpenEditor and RunChanges", () => {
  test("the editor opens the run's worktree (or the repository) with --goto, the run notes it; no editor is a usage error", async () => {
    const w = world();
    const run = (await w.initRun.execute({ workflow: "demo", task: "Add the discount" }))._unsafeUnwrap();
    const launched: { argv: readonly string[]; cwd: string }[] = [];
    let editor = "code";
    const open = new OpenEditor({
      root: "/repo",
      repo: w.repo,
      panes: { pane: async (id) => ok({ id, cwd: "/repo/.worktrees/x", runId: run.runId } as never) },
      options: {
        get: async (key) => ok({ key, value: editor, source: "user", definition: {} as never, layers: {} }),
      },
      launcher: {
        detached: async (argv, cwd) => {
          launched.push({ argv, cwd });
          return ok(undefined);
        },
      },
      journal: w.journal,
    });
    const r = (await open.execute({ runId: run.runId, file: "src/invoice.ts", line: 10 }))._unsafeUnwrap();
    expect(r).toEqual({
      argv: ["code", "-r", "/repo", "--goto", "/repo/src/invoice.ts:10"],
      dir: "/repo",
      runId: run.runId,
    });
    expect((await open.execute({ paneId: "w1:p2" }))._unsafeUnwrap().dir).toBe("/repo/.worktrees/x");
    expect(launched).toHaveLength(2);
    const activity = (await w.journal.activity(run.runId))._unsafeUnwrap();
    expect(activity.map((a) => [a.type, a.origin, a.text])).toContainEqual([
      "text",
      "inbox",
      "opened in the editor: src/invoice.ts:10",
    ]);
    editor = " ";
    expect((await open.execute({ runId: run.runId })).isErr()).toBe(true);
    expect((await open.execute({ runId: "nope" })).isErr()).toBe(true);
  });

  test("the change of a run: files with counts without MetatorAI's own, one file as hunks; a worktree measured against the repository's HEAD", async () => {
    const w = world();
    const run = (await w.initRun.execute({ workflow: "demo", task: "Add the discount" }))._unsafeUnwrap();
    const asked: { dir: string; base: string }[] = [];
    const changes = new RunChanges({
      root: "/repo",
      repo: w.repo,
      changesAt: (dir) => ({
        patch: async (base) => {
          asked.push({ dir, base });
          return ok(PATCH);
        },
        changedFiles: async () => ok([]),
      }),
      runner: { run: async () => ({ exitCode: 0, stdout: "abc123\n", stderr: "", durationMs: 1 }) },
    });
    const view = (await changes.execute({ runId: run.runId, file: "src/invoice.ts" }))._unsafeUnwrap();
    expect(view.files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/invoice.ts", 2, 1],
      ["src/new.ts", 2, 0],
    ]);
    expect(view.diff?.hunks[0]?.lines).toHaveLength(6);
    expect([view.dir, view.base]).toEqual(["/repo", "HEAD"]);
    // A run in a worktree: its directory, against the repository's HEAD.
    const record = (await w.repo.load(run.runId))._unsafeUnwrap();
    (
      await w.repo.save({
        ...record,
        worktree: { id: "wt1", path: ".metator/worktrees/wt1", branch: "run/x" },
      })
    )._unsafeUnwrap();
    const inTree = (await changes.execute({ runId: run.runId }))._unsafeUnwrap();
    expect([inTree.dir, inTree.base, inTree.diff]).toEqual([
      "/repo/.metator/worktrees/wt1",
      "abc123",
      undefined,
    ]);
    expect(asked.map((a) => a.dir)).toEqual(["/repo", "/repo/.metator/worktrees/wt1"]);
  });
});
