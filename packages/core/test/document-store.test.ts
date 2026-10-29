import { expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { z } from "zod";
import { DocumentStore } from "../src/application/document-store.ts";
import { defineDocument } from "../src/domain/versioned.ts";

const Note = defineDocument("Note", { latest: z.strictObject({ id: z.string(), text: z.string() }) });
const store = (fs: InMemoryFileSystem) =>
  new DocumentStore(fs, "notes", Note, { noun: "note", listHint: "list them", comment: "A note." });

test("documents by id: saved with a header and comment, loaded, listed in id order", async () => {
  const fs = new InMemoryFileSystem();
  const notes = store(fs);
  await notes.save({ id: "b", text: "two" });
  await notes.save({ id: "a", text: "one" });
  expect((await fs.read("notes/a.yml"))._unsafeUnwrap()).toBe(
    "# A note.\nkind: Note\nschemaVersion: 1\nid: a\ntext: one\n",
  );
  expect((await notes.load("a"))._unsafeUnwrap()).toEqual({ id: "a", text: "one" });
  expect((await notes.list())._unsafeUnwrap().map((n) => n.id)).toEqual(["a", "b"]);
  expect([await notes.exists("a"), await notes.exists("zzz")]).toEqual([true, false]);
});

test("a missing document is NOT_FOUND with the hint; a file whose id is not its name is invalid", async () => {
  const fs = new InMemoryFileSystem({
    "notes/x.yml": "kind: Note\nschemaVersion: 1\nid: y\ntext: t\n",
    "notes/x.extra.yml": "anything",
  });
  const notes = store(fs);
  const missing = (await notes.load("nope"))._unsafeUnwrapErr();
  expect([missing.code, missing.hint]).toEqual(["NOT_FOUND", "list them"]);
  expect((await notes.load("x"))._unsafeUnwrapErr().message).toBe("notes/x.yml: its id is y, not x");
  // Files with a further dot (an analysis next to its plan) are not documents of the store.
  expect((await notes.list())._unsafeUnwrapErr().message).toBe("notes/x.yml: its id is y, not x");
});
