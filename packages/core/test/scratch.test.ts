import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { Scratch } from "../src/application/scratch.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

/**
 * A working tree as a list of changes: a snapshot is how many there are; the patch between two
 * snapshots names the files changed in between (one line per file: `file@n`).
 */
function world() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2026-11-21T10:00:00.000Z"));
  const changes: string[] = [];
  // What the working tree and the index hold of each recorded change, and what no longer applies.
  const tree = new Set<string>();
  const index = new Set<string>();
  const stale = new Set<string>();
  const reverted: string[] = [];
  const lines = (patch: string) => patch.split("\n").filter(Boolean);
  const patches = {
    snapshot: async () => ok(String(changes.length)),
    between: async (from: string, to: string) => {
      const part = changes.slice(Number(from), Number(to));
      return ok({ files: [...new Set(part.map((c) => c.split("@")[0] as string))], patch: part.join("\n") });
    },
    holding: async (patch: string, where: "tree" | "index" | "tracked") =>
      ok([
        ...new Set(
          lines(patch)
            .filter((l) => (where === "index" ? index : tree).has(l))
            // A file whose name starts with `new` is one nobody added to git.
            .filter((l) => where !== "tracked" || !l.startsWith("new"))
            .map((l) => l.split("@")[0] as string),
        ),
      ]),
    revert: async (patch: string) => {
      const bad = lines(patch).find((l) => stale.has(l));
      if (bad)
        return err(
          new MetatorError(
            "COMMAND_FAILED",
            `the patch no longer applies: ${bad.split("@")[0]} changed since`,
          ),
        );
      for (const l of lines(patch)) {
        tree.delete(l);
        index.delete(l);
      }
      reverted.push(patch);
      return ok(undefined);
    },
  };
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
      },
    });
    expect((await w.scratch.list())._unsafeUnwrap()).toEqual([
      {
        id: "s001",
        files: ["src/price.ts", "src/tax.ts"],
        note: "log every rounding",
        at: "2026-11-21T10:01:00.000Z",
      },
    ]);
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
    expect(second.recorded).toEqual({ id: "s002", files: ["src/cart.ts"], at: "2026-11-21T10:01:00.000Z" });
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
    expect((await w.scratch.list())._unsafeUnwrap()).toEqual([]);
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
    expect(one).toEqual({ dropped: [{ id: "s002", files: ["b.ts"] }], failed: [] });
    expect((await w.scratch.list())._unsafeUnwrap().map((r) => r.id)).toEqual(["s001", "s003"]);
    const all = (await w.scratch.drop({ by: "ana" }))._unsafeUnwrap();
    expect(all.dropped.map((d) => d.id)).toEqual(["s003", "s001"]);
    expect(w.reverted).toEqual(["b.ts@1", "c.ts@2", "a.ts@0"]);
    expect([(await w.scratch.list())._unsafeUnwrap(), w.tree.size]).toEqual([[], 0]);
    const unknown = (await w.scratch.drop({ ids: ["s009"], by: "ana" }))._unsafeUnwrapErr();
    expect([unknown.code, unknown.message]).toEqual(["NOT_FOUND", "scratch record s009 not found"]);
    expect((await w.scratch.drop({ by: " " }))._unsafeUnwrapErr().message).toBe(
      "say who removes them: --by <name>",
    );
  });

  test("a patch that no longer applies is reported and kept, never forced; the others are still dropped", async () => {
    const w = world();
    await record(w, "a.ts");
    await record(w, "b.ts");
    w.stale.add("a.ts@0");
    const r = (await w.scratch.drop({ by: "ana" }))._unsafeUnwrap();
    expect(r).toEqual({
      dropped: [{ id: "s002", files: ["b.ts"] }],
      failed: [{ id: "s001", files: ["a.ts"], why: "the patch no longer applies: a.ts changed since" }],
    });
    expect((await w.scratch.list())._unsafeUnwrap().map((x) => x.id)).toEqual(["s001"]);
    expect(w.tree.has("a.ts@0")).toBe(true);
  });

  test("a change the person removed by hand is gone from the list: a record holds only what is still in the tree", async () => {
    const w = world();
    await record(w, "a.ts", "b.ts");
    w.tree.delete("a.ts@0");
    expect((await w.scratch.list())._unsafeUnwrap()).toMatchObject([{ id: "s001", files: ["b.ts"] }]);
    w.tree.delete("b.ts@1");
    expect((await w.scratch.list())._unsafeUnwrap()).toEqual([]);
    // What is gone everywhere is no record any more.
    expect(await w.fs.exists(".metator/scratch/s001.json")).toBe(false);
  });

  test("the commit guard's question: which debug files would this commit hold", async () => {
    const w = world();
    await record(w, "a.ts", "b.ts", "new.log");
    // Nothing staged: a plain commit holds none; `commit -a` holds what is in the tree of tracked files.
    expect((await w.scratch.inCommit(false))._unsafeUnwrap()).toEqual([]);
    expect((await w.scratch.inCommit(true))._unsafeUnwrap()).toEqual(["a.ts", "b.ts"]);
    w.index.add("b.ts@1");
    expect((await w.scratch.inCommit(false))._unsafeUnwrap()).toEqual(["b.ts"]);
    // A new file that was added is in the commit, with or without -a.
    w.index.add("new.log@2");
    expect((await w.scratch.inCommit(true))._unsafeUnwrap()).toEqual(["a.ts", "b.ts", "new.log"]);
  });
});
