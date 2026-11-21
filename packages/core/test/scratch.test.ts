import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { Scratch } from "../src/application/scratch.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

/**
 * A working tree as a list of changes: a snapshot is how many there are; the patch between two
 * snapshots names the files changed in between (one line per file: `file@n`).
 */
/** A plain `git commit` (what is staged), and `git commit -a`. */
const STAGED = { tracked: false, untracked: false, paths: [] };
const DASH_A = { tracked: true, untracked: false, paths: [] };

function world() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2026-11-21T10:00:00.000Z"));
  const changes: string[] = [];
  // What the working tree and the index hold of each recorded change, and what no longer applies.
  const tree = new Set<string>();
  const index = new Set<string>();
  // Lines that are still in a file but no longer as recorded (the person rewrote around them).
  const stale = new Set<string>();
  const staleStaged = new Set<string>();
  const reverted: string[] = [];
  const lines = (patch: string) => patch.split("\n").filter(Boolean);
  const patches = {
    snapshot: async () => ok(String(changes.length)),
    between: async (from: string, to: string) => {
      const part = changes.slice(Number(from), Number(to));
      return ok({ files: [...new Set(part.map((c) => c.split("@")[0] as string))], patch: part.join("\n") });
    },
    holding: async (patch: string, where: "tree" | "index" | "tracked") =>
      ok(
        filesOf(
          lines(patch).filter((l) => (where === "index" ? index : tree).has(l) && !stale.has(l)),
          where,
        ),
      ),
    remains: async (patch: string, where: "tree" | "index" | "tracked") =>
      ok(
        filesOf(
          lines(patch).filter((l) => (where === "index" ? index.has(l) || staleStaged.has(l) : tree.has(l))),
          where,
        ),
      ),
    revert: async (patch: string, files?: readonly string[]) => {
      const mine = lines(patch).filter((l) => !files || files.includes(l.split("@")[0] as string));
      const bad = mine.find((l) => stale.has(l) || !tree.has(l));
      if (bad)
        return err(
          new MetatorError(
            "COMMAND_FAILED",
            `the patch no longer applies (${bad.split("@")[0]} changed since)`,
          ),
        );
      for (const l of mine) {
        tree.delete(l);
        index.delete(l);
      }
      reverted.push(mine.join("\n"));
      return ok(undefined);
    },
  };
  // A file whose name starts with `new` is one nobody added to git.
  const filesOf = (held: string[], where: string) => [
    ...new Set(
      held.filter((l) => where !== "tracked" || !l.startsWith("new")).map((l) => l.split("@")[0] as string),
    ),
  ];
  const edit = (...files: string[]) => {
    for (const f of files) {
      const line = `${f}@${changes.length}`;
      changes.push(line);
      tree.add(line);
    }
  };
  return {
    fs,
    clock,
    changes,
    tree,
    index,
    stale,
    staleStaged,
    reverted,
    edit,
    scratch: new Scratch({ fs, clock, patches }),
  };
}

describe("Scratch: a direct edit not meant for a commit, recorded as a patch (ADR-0093)", () => {
  test("begin, edit, end: the edit is one record with its files, its note and when; only what changed in between", async () => {
    const w = world();
    w.edit("src/earlier.ts");
    expect((await w.scratch.begin())._unsafeUnwrap()).toEqual({ begun: "2026-11-21T10:00:00.000Z" });
    w.edit("src/price.ts", "src/tax.ts");
    w.clock.advance(60_000);
    const ended = (await w.scratch.end({ note: "log every rounding" }))._unsafeUnwrap();
    expect(ended).toEqual({
      recorded: {
        id: "s001",
        files: ["src/price.ts", "src/tax.ts"],
        note: "log every rounding",
        at: "2026-11-21T10:01:00.000Z",
        state: "removable",
      },
    });
    expect((await w.scratch.list())._unsafeUnwrap()).toEqual({
      items: [
        {
          id: "s001",
          files: ["src/price.ts", "src/tax.ts"],
          note: "log every rounding",
          at: "2026-11-21T10:01:00.000Z",
          state: "removable",
        },
      ],
      gone: [],
    });
    // A versioned document under .metator/scratch/, with the patch itself.
    const doc = JSON.parse((await w.fs.read(".metator/scratch/s001.json"))._unsafeUnwrap());
    expect(doc).toMatchObject({
      kind: "ScratchRecord",
      schemaVersion: 1,
      id: "s001",
      patch: "src/price.ts@1\nsrc/tax.ts@2",
    });
    // The next one gets the next id; no note is no note.
    await w.scratch.begin();
    w.edit("src/cart.ts");
    const second = (await w.scratch.end({}))._unsafeUnwrap();
    expect(second.recorded).toEqual({
      id: "s002",
      files: ["src/cart.ts"],
      at: "2026-11-21T10:01:00.000Z",
      state: "removable",
    });
  });

  test("begin twice, end without begin, and an edit that changed nothing", async () => {
    const w = world();
    const none = (await w.scratch.end({}))._unsafeUnwrapErr();
    expect([none.code, none.message]).toEqual([
      "USAGE",
      "no scratch edit is open: begin one first (`metator scratch begin`)",
    ]);
    await w.scratch.begin();
    const twice = (await w.scratch.begin())._unsafeUnwrapErr();
    expect(twice.message).toBe(
      "a scratch edit is already open (begun 2026-11-21T10:00:00.000Z): end it first (`metator scratch end`)",
    );
    // Nothing changed: nothing is recorded, and the edit is closed.
    expect((await w.scratch.end({ note: "nothing" }))._unsafeUnwrap()).toEqual({ recorded: null });
    expect((await w.scratch.list())._unsafeUnwrap().items).toEqual([]);
    expect((await w.scratch.begin()).isOk()).toBe(true);
  });

  const record = async (w: ReturnType<typeof world>, ...files: string[]) => {
    await w.scratch.begin();
    w.edit(...files);
    return ((await w.scratch.end({}))._unsafeUnwrap().recorded as { id: string }).id;
  };

  test("drop takes the changes out again, the newest first; all of them, or the ones named", async () => {
    const w = world();
    await record(w, "a.ts");
    await record(w, "b.ts");
    await record(w, "c.ts");
    const one = (await w.scratch.drop({ ids: ["s002"], by: "ana" }))._unsafeUnwrap();
    expect(one).toEqual({ dropped: [{ id: "s002", files: ["b.ts"] }], failed: [], gone: [] });
    expect((await w.scratch.list())._unsafeUnwrap().items.map((r) => r.id)).toEqual(["s001", "s003"]);
    const all = (await w.scratch.drop({ by: "ana" }))._unsafeUnwrap();
    expect(all.dropped.map((d) => d.id)).toEqual(["s003", "s001"]);
    expect(w.reverted).toEqual(["b.ts@1", "c.ts@2", "a.ts@0"]);
    expect([(await w.scratch.list())._unsafeUnwrap().items, w.tree.size, await w.scratch.count()]).toEqual([
      [],
      0,
      0,
    ]);
    const unknown = (await w.scratch.drop({ ids: ["s009"], by: "ana" }))._unsafeUnwrapErr();
    expect([unknown.code, unknown.message]).toEqual(["NOT_FOUND", "scratch record s009 not found"]);
    expect((await w.scratch.drop({ by: " " }))._unsafeUnwrapErr().message).toBe(
      "say who removes them: --by <name>",
    );
  });

  test("a record whose lines changed since is remembered: reported by drop, listed as changed, counted, until the person deals with it", async () => {
    const w = world();
    await record(w, "a.ts");
    await record(w, "b.ts");
    w.stale.add("a.ts@0");
    const r = (await w.scratch.drop({ by: "ana" }))._unsafeUnwrap();
    expect(r).toEqual({
      dropped: [{ id: "s002", files: ["b.ts"] }],
      failed: [
        {
          id: "s001",
          files: ["a.ts"],
          why: "a.ts changed since it was recorded: its debug lines can no longer be taken out as they were. Take them out by hand, or forget the record (`metator scratch forget --id s001`)",
        },
      ],
      gone: [],
    });
    expect(w.tree.has("a.ts@0")).toBe(true);
    // Looked at again and again: it stays, with its state and why, and it still counts.
    for (const _ of [1, 2]) {
      const listed = (await w.scratch.list())._unsafeUnwrap();
      expect(listed).toEqual({
        items: [
          {
            id: "s001",
            files: ["a.ts"],
            at: "2026-11-21T10:00:00.000Z",
            state: "changed",
            why: "a.ts changed since it was recorded: its debug lines can no longer be taken out as they were. Take them out by hand, or forget the record (`metator scratch forget --id s001`)",
          },
        ],
        gone: [],
      });
    }
    expect(await w.scratch.count()).toBe(1);
    expect(await w.fs.exists(".metator/scratch/s001.json")).toBe(true);
  });

  test("a record with one file changed and one still as recorded: drop takes out what it can and keeps the rest", async () => {
    const w = world();
    await record(w, "a.ts", "b.ts");
    w.stale.add("a.ts@0");
    const r = (await w.scratch.drop({ by: "ana" }))._unsafeUnwrap();
    expect([r.dropped, r.failed.map((f) => [f.id, f.files])]).toEqual([[], [["s001", ["a.ts"]]]]);
    // b.ts was taken out; the record goes on with a.ts only.
    expect(w.tree.has("b.ts@1")).toBe(false);
    expect((await w.scratch.list())._unsafeUnwrap().items).toMatchObject([
      { id: "s001", files: ["a.ts"], state: "changed" },
    ]);
  });

  test("a record leaves by itself only when no file holds its lines any more, and the response that removes it says so", async () => {
    const w = world();
    await record(w, "a.ts", "b.ts");
    // One file's lines were taken out by hand: the record goes on with the other.
    w.tree.delete("a.ts@0");
    expect((await w.scratch.list())._unsafeUnwrap()).toMatchObject({
      items: [{ id: "s001", files: ["b.ts"], state: "removable" }],
      gone: [],
    });
    w.tree.delete("b.ts@1");
    expect(await w.scratch.count()).toBe(1);
    expect((await w.scratch.list())._unsafeUnwrap()).toEqual({
      items: [],
      gone: [{ id: "s001", files: ["a.ts", "b.ts"], why: "s001 is gone: a.ts, b.ts no longer hold it" }],
    });
    // Told once: the record is no more.
    expect(await w.fs.exists(".metator/scratch/s001.json")).toBe(false);
    expect((await w.scratch.list())._unsafeUnwrap()).toEqual({ items: [], gone: [] });
    // The same through drop: a record nothing holds is gone, not dropped and not failed.
    await record(w, "c.ts");
    w.tree.delete("c.ts@2");
    // (With no record left the next one is s001 again.)
    expect((await w.scratch.drop({ by: "ana" }))._unsafeUnwrap()).toEqual({
      dropped: [],
      failed: [],
      gone: [{ id: "s001", files: ["c.ts"], why: "s001 is gone: c.ts no longer holds it" }],
    });
  });

  test("forget: the person dismisses a record; the files stay as they are", async () => {
    const w = world();
    await record(w, "a.ts");
    await record(w, "b.ts");
    w.stale.add("a.ts@0");
    const r = (await w.scratch.forget({ ids: ["s001"], by: "ana" }))._unsafeUnwrap();
    expect(r).toEqual({ forgotten: [{ id: "s001", files: ["a.ts"] }] });
    expect([w.tree.has("a.ts@0"), w.reverted]).toEqual([true, []]);
    expect((await w.scratch.list())._unsafeUnwrap().items.map((i) => i.id)).toEqual(["s002"]);
    const errors = [
      await w.scratch.forget({ ids: [], by: "ana" }),
      await w.scratch.forget({ ids: ["s009"], by: "ana" }),
      await w.scratch.forget({ ids: ["s002"], by: "" }),
    ].map((e) => e._unsafeUnwrapErr().message);
    expect(errors).toEqual([
      "name the records to forget: --id <id> (repeatable)",
      "scratch record s009 not found",
      "say who forgets them: --by <name>",
    ]);
  });

  test("the commit guard's question: which debug files would this commit hold", async () => {
    const w = world();
    await record(w, "a.ts", "b.ts", "new.log");
    // Nothing staged: a plain commit holds none; `commit -a` holds what is in the tree of tracked files.
    expect((await w.scratch.inCommit(STAGED))._unsafeUnwrap()).toEqual([]);
    expect((await w.scratch.inCommit(DASH_A))._unsafeUnwrap()).toEqual(["a.ts", "b.ts"]);
    w.index.add("b.ts@1");
    expect((await w.scratch.inCommit(STAGED))._unsafeUnwrap()).toEqual(["b.ts"]);
    // A new file that was added is in the commit, with or without -a.
    w.index.add("new.log@2");
    expect((await w.scratch.inCommit(DASH_A))._unsafeUnwrap()).toEqual(["a.ts", "b.ts", "new.log"]);
    // Paths the same command line adds before it commits (`git add a.ts && git commit`), a
    // directory, a pattern; `git add -A` takes the new file nobody added yet.
    w.index.clear();
    const add = (...paths: string[]) => ({ tracked: false, untracked: false, paths });
    expect((await w.scratch.inCommit(add("a.ts")))._unsafeUnwrap()).toEqual(["a.ts"]);
    expect((await w.scratch.inCommit(add("new.log", "elsewhere")))._unsafeUnwrap()).toEqual(["new.log"]);
    expect((await w.scratch.inCommit(add("*.ts")))._unsafeUnwrap()).toEqual(["a.ts", "b.ts"]);
    expect((await w.scratch.inCommit(add("src")))._unsafeUnwrap()).toEqual([]);
    expect((await w.scratch.inCommit({ tracked: true, untracked: true, paths: [] }))._unsafeUnwrap()).toEqual(
      ["a.ts", "b.ts", "new.log"],
    );
    w.index.add("b.ts@1");
    w.index.add("new.log@2");
    // Lines that changed since (no longer removable as recorded) still stop a commit that holds them.
    w.stale.add("a.ts@0");
    expect((await w.scratch.inCommit(DASH_A))._unsafeUnwrap()).toEqual(["a.ts", "b.ts", "new.log"]);
    w.staleStaged.add("a.ts@0");
    expect((await w.scratch.inCommit(STAGED))._unsafeUnwrap()).toEqual(["a.ts", "b.ts", "new.log"]);
    // Asking never removes a record.
    w.tree.clear();
    w.index.clear();
    w.staleStaged.clear();
    expect((await w.scratch.inCommit(DASH_A))._unsafeUnwrap()).toEqual([]);
    expect(await w.scratch.count()).toBe(1);
  });
});
