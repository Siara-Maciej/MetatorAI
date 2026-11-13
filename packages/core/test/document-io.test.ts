import { expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { z } from "zod";
import {
  documentFormat,
  loadDocument,
  parseDocumentText,
  readDocument,
  readJsonLines,
  scanDocuments,
  writeDocument,
} from "../src/application/document-io.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err } from "../src/domain/result.ts";
import { defineDocument } from "../src/domain/versioned.ts";

const Note = defineDocument("Note", { latest: z.strictObject({ id: z.string() }) });
const JSON_A = '{"kind":"Note","schemaVersion":1,"id":"a"}';

test("the format is the file name's: .json and .jsonl JSON, .md front matter, the rest YAML", () => {
  expect(["a.json", "a.jsonl", "a.md", "a.yml", "a.yaml", "a"].map(documentFormat)).toEqual([
    "json",
    "json",
    "front-matter",
    "yaml",
    "yaml",
    "yaml",
  ]);
});

test("a document's text is parsed in each format and validated; the source names it in errors", () => {
  expect(parseDocumentText(JSON_A, "n.json", Note)._unsafeUnwrap()).toEqual({ id: "a" });
  expect(parseDocumentText("kind: Note\nschemaVersion: 1\nid: b\n", "n.yml", Note)._unsafeUnwrap()).toEqual({
    id: "b",
  });
  expect(
    parseDocumentText("---\nkind: Note\nschemaVersion: 1\nid: c\n---\nbody\n", "n.md", Note)._unsafeUnwrap(),
  ).toEqual({ id: "c" });
  // The format given wins over the name.
  expect(parseDocumentText(JSON_A, "n.txt", Note, "json")._unsafeUnwrap()).toEqual({ id: "a" });
  expect(parseDocumentText("{", "n.json", Note)._unsafeUnwrapErr().message).toContain("n.json");
  expect(parseDocumentText('{"kind":"Other","schemaVersion":1}', "n.json", Note).isErr()).toBe(true);
});

test("an absent document reads as undefined; one that must be there is the file system's error", async () => {
  const fs = new InMemoryFileSystem({ "n.json": JSON_A });
  expect((await readDocument(fs, "n.json", Note))._unsafeUnwrap()).toEqual({ id: "a" });
  expect((await readDocument(fs, "none.json", Note))._unsafeUnwrap()).toBeUndefined();
  expect((await loadDocument(fs, "n.json", Note))._unsafeUnwrap()).toEqual({ id: "a" });
  expect((await loadDocument(fs, "none.json", Note)).isErr()).toBe(true);
});

test("a document is written with its header: JSON, or YAML under the comment", async () => {
  const fs = new InMemoryFileSystem();
  await writeDocument(fs, "n.json", Note, { id: "a" });
  await writeDocument(fs, "n.yml", Note, { id: "b" }, undefined, "A note.");
  await writeDocument(fs, "plain", Note, { id: "c" }, "json");
  expect((await fs.read("n.json"))._unsafeUnwrap()).toBe(
    '{\n  "kind": "Note",\n  "schemaVersion": 1,\n  "id": "a"\n}\n',
  );
  expect((await fs.read("n.yml"))._unsafeUnwrap()).toBe("# A note.\nkind: Note\nschemaVersion: 1\nid: b\n");
  expect((await fs.read("plain"))._unsafeUnwrap()).toStartWith("{");
});

test("JSON lines: no file is no lines; a bad line fails with its number, or is skipped", async () => {
  const fs = new InMemoryFileSystem({
    "log.jsonl": `${JSON_A}\n\n{"torn\n${JSON_A.replace('"a"', '"b"')}\n`,
  });
  expect((await readJsonLines(fs, "none.jsonl", Note, "fail"))._unsafeUnwrap()).toEqual([]);
  expect((await readJsonLines(fs, "log.jsonl", Note, "skip"))._unsafeUnwrap()).toEqual([
    { id: "a" },
    { id: "b" },
  ]);
  expect((await readJsonLines(fs, "log.jsonl", Note, "fail"))._unsafeUnwrapErr().message).toContain(
    "log.jsonl:3 ",
  );
  const unnumbered = (await readJsonLines(fs, "log.jsonl", Note, "fail", false))._unsafeUnwrapErr();
  expect(unnumbered.message).toContain("log.jsonl ");
});

test("a scan returns the valid documents in path order with their text, and why the others are not", async () => {
  const fs = new InMemoryFileSystem({
    "notes/b.yml": "kind: Note\nschemaVersion: 1\nid: b\n",
    "notes/a.yml": "kind: Note\nschemaVersion: 1\nid: a\n",
    "notes/bad.yml": "kind: Note\nschemaVersion: 1\n",
    "other/c.yml": "kind: Note\nschemaVersion: 1\nid: c\n",
  });
  const scan = await scanDocuments(fs, ["notes/*.yml"], Note);
  expect(scan.entries.map((e) => [e.source, e.value.id])).toEqual([
    ["notes/a.yml", "a"],
    ["notes/b.yml", "b"],
  ]);
  expect(scan.entries[0]?.text).toBe("kind: Note\nschemaVersion: 1\nid: a\n");
  expect(scan.problems.map((p) => p.source)).toEqual(["notes/bad.yml"]);
});

test("a file that cannot be read is a problem of the scan, or left out when asked", async () => {
  const inner = new InMemoryFileSystem({ "notes/a.yml": "kind: Note\nschemaVersion: 1\nid: a\n" });
  const fs = {
    exists: (p: string) => inner.exists(p),
    glob: async () => ["notes/a.yml", "notes/gone.yml"],
    read: async (p: string) =>
      p === "notes/gone.yml" ? err(new MetatorError("INTERNAL", "cannot read")) : inner.read(p),
  };
  const told = await scanDocuments(fs, ["notes/*.yml"], Note);
  expect([told.entries.length, told.problems.map((p) => p.error.message)]).toEqual([1, ["cannot read"]]);
  const skipped = await scanDocuments(fs, ["notes/*.yml"], Note, { unreadable: "skip" });
  expect([skipped.entries.length, skipped.problems]).toEqual([1, []]);
});
