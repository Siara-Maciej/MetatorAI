import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineDocument, parseYamlDocument, renderYamlDocument } from "../src/domain/versioned.ts";

// A synthetic document with real history: v1 {name}, v2 {name, tags}, v3 {title, tags}.
const V1 = z.object({ name: z.string() }).strict();
const V2 = z.object({ name: z.string(), tags: z.array(z.string()) }).strict();
const V3 = z.object({ title: z.string(), tags: z.array(z.string()) }).strict();

const Note = defineDocument("Note", {
  history: [
    { schema: V1 },
    { schema: V2, fromPrevious: (p) => ({ ...(p as z.infer<typeof V1>), tags: [] }) },
  ],
  latest: V3,
  upgrade: (p) => {
    const { name, tags } = p as z.infer<typeof V2>;
    return { title: name, tags };
  },
});

describe("versioned documents", () => {
  test("current version is the number of versions; stamp writes the header", () => {
    expect(Note.current).toBe(3);
    expect(Note.stamp({ title: "a", tags: [] })).toEqual({
      kind: "Note",
      schemaVersion: 3,
      title: "a",
      tags: [],
    });
  });

  test("reads the current version directly", () => {
    const body = Note.parse(
      { kind: "Note", schemaVersion: 3, title: "t", tags: ["x"] },
      "n.json",
    )._unsafeUnwrap();
    expect(body).toEqual({ title: "t", tags: ["x"] });
  });

  test("migrates every older version step by step to the current one", () => {
    expect(Note.parse({ kind: "Note", schemaVersion: 1, name: "old" }, "n.json")._unsafeUnwrap()).toEqual({
      title: "old",
      tags: [],
    });
    expect(
      Note.parse({ kind: "Note", schemaVersion: 2, name: "mid", tags: ["a"] }, "n.json")._unsafeUnwrap(),
    ).toEqual({
      title: "mid",
      tags: ["a"],
    });
  });

  test("each version is validated with its own schema (v1 body with v3 keys is invalid)", () => {
    const error = Note.parse({ kind: "Note", schemaVersion: 1, title: "x" }, "n.json")._unsafeUnwrapErr();
    expect(error.code).toBe("INVALID_ARTIFACT");
    expect(error.message).toContain("does not match Note v1");
  });

  test("refuses documents from a newer version instead of misreading them", () => {
    const error = Note.parse(
      { kind: "Note", schemaVersion: 4, title: "x", tags: [] },
      "n.json",
    )._unsafeUnwrapErr();
    expect(error.message).toContain("schemaVersion 4 is newer than supported (3)");
    expect(error.hint).toContain("Upgrade metator-ai");
  });

  test("missing header, wrong kind and nonsense versions are rejected", () => {
    expect(Note.parse({ title: "x", tags: [] }, "n.json")._unsafeUnwrapErr().hint).toBe(
      'Expected "kind: Note" and "schemaVersion: 3" at the top of the document.',
    );
    expect(Note.parse({ kind: "Other", schemaVersion: 3 }, "n.json")._unsafeUnwrapErr().message).toContain(
      'expected kind "Note", found "Other"',
    );
    expect(Note.parse({ kind: "Note", schemaVersion: 0 }, "n.json").isErr()).toBe(true);
    expect(Note.parse({ kind: "Note", schemaVersion: 1.5, name: "x" }, "n.json").isErr()).toBe(true);
    expect(Note.parse("just a string", "n.json").isErr()).toBe(true);
  });

  test("a buggy migration is caught by the next version's schema", () => {
    const Broken = defineDocument("Broken", {
      history: [{ schema: V1 }],
      latest: V3,
      upgrade: (p) => ({ name: (p as { name: string }).name }), // forgets to rename and add tags
    });
    const error = Broken.parse({ kind: "Broken", schemaVersion: 1, name: "x" }, "b.json")._unsafeUnwrapErr();
    expect(error.message).toContain("migration Broken v1 → v2 produced an invalid document");
  });

  test("defining a later version without a migration is a programming error", () => {
    expect(() => defineDocument("Bad", { history: [{ schema: V1 }], latest: V2 })).toThrow(
      "needs a migration",
    );
  });

  test("errors carry the source file and use the configured error code", () => {
    const Spec = defineDocument("Spec", { latest: V1, errorCode: "INVALID_CONFIG", hint: "see docs" });
    const error = Spec.parse({ kind: "Spec", schemaVersion: 1, name: 3 }, "spec.yml")._unsafeUnwrapErr();
    expect([error.code, error.hint, error.message.startsWith("spec.yml:")]).toEqual([
      "INVALID_CONFIG",
      "see docs",
      true,
    ]);
  });

  test("JSON Schema includes the header as constants", () => {
    const schema = Note.jsonSchema() as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties.kind).toEqual({ const: "Note" });
    expect(schema.properties.schemaVersion).toEqual({ const: 3 });
    expect(schema.required.slice(0, 2)).toEqual(["kind", "schemaVersion"]);
  });

  test("JSON Schema of an older version describes that version", () => {
    const schema = Note.jsonSchema("input", 1) as { properties: Record<string, unknown> };
    expect(schema.properties.schemaVersion).toEqual({ const: 1 });
    expect(Object.keys(schema.properties)).toEqual(["kind", "schemaVersion", "name"]);
    expect(() => Note.jsonSchema("input", 4)).toThrow("Note has no schemaVersion 4");
  });
});

describe("renderYamlDocument", () => {
  test("writes the header first and round-trips", () => {
    const text = renderYamlDocument({ kind: "Note", schemaVersion: 3, title: "a", tags: [] });
    expect(text.split("\n")[0]).toBe("kind: Note");
    expect(Note.parse(parseYamlDocument(text, "n.yml")._unsafeUnwrap(), "n.yml")._unsafeUnwrap()).toEqual({
      title: "a",
      tags: [],
    });
  });

  test("puts a comment above the document", () => {
    const text = renderYamlDocument({ kind: "Note", schemaVersion: 3 }, "generated");
    expect(text).toBe("# generated\nkind: Note\nschemaVersion: 3\n");
  });
});

describe("validation messages name the field", () => {
  test("the first issue is reported with its path; a root issue without one", () => {
    const Doc = defineDocument("Probe", {
      latest: z.strictObject({ items: z.array(z.strictObject({ name: z.string() })) }),
    });
    const nested = Doc.parse({ kind: "Probe", schemaVersion: 1, items: [{}] }, "p.json")._unsafeUnwrapErr();
    expect(nested.message).toBe(
      "p.json: does not match Probe v1: items.0.name: Invalid input: expected string, received undefined",
    );
    const Root = defineDocument("Root", { latest: z.strictObject({}).refine(() => false, "always wrong") });
    expect(Root.parse({ kind: "Root", schemaVersion: 1 }, "r.json")._unsafeUnwrapErr().message).toBe(
      "r.json: does not match Root v1: always wrong",
    );
  });
});
