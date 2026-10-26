/**
 * MT-CODE-003: a released document version never changes in place. Every version has a frozen
 * schema snapshot; an older version also has an example that must still parse (the migration test).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineDocument, type VersionedDocument } from "../../packages/core/src/index.ts";
import { files, ROOT, read } from "./lib.ts";
import { documents, exampleFile, renderSnapshot, SCHEMA_DIR, snapshotFile, snapshotOf } from "./schemas.ts";

type Store = (file: string) => string | undefined;

function problems(
  docs: ReadonlyMap<string, VersionedDocument<unknown>>,
  stored: Store,
  present: readonly string[],
): string[] {
  const out: string[] = [];
  const expected = new Set<string>();
  for (const doc of docs.values()) {
    for (let v = 1; v <= doc.current; v++) {
      const file = snapshotFile(doc.kind, v);
      expected.add(file);
      const text = stored(file);
      if (text === undefined)
        out.push(`${file}: missing; run \`bun run schemas:freeze\` to freeze ${doc.kind} v${v}`);
      // Compared as data: formatters may rewrite the file's whitespace.
      else if (!Bun.deepEquals(JSON.parse(text), snapshotOf(doc, v), true))
        out.push(`${file}: ${doc.kind} v${v} changed in place; add v${v + 1} with an upgrade instead`);
      if (v === doc.current) continue;
      const example = exampleFile(doc.kind, v);
      expected.add(example);
      const raw = stored(example);
      if (raw === undefined)
        out.push(`${example}: missing; an example of ${doc.kind} v${v} proves its migration`);
      else {
        const parsed = doc.parse(JSON.parse(raw), example);
        if (parsed.isErr())
          out.push(`${example}: does not migrate to v${doc.current}: ${parsed.error.message}`);
      }
    }
  }
  for (const f of present) if (!expected.has(f)) out.push(`${f}: no document version has this snapshot`);
  return out;
}

describe("MT-CODE-003", () => {
  test("every document version is frozen and every older version migrates", async () => {
    const docs = documents();
    // Every definition is exported, so none escapes the check.
    let definitions = 0;
    for (const f of await files("packages/*/src/**/*.ts"))
      definitions += [...(await read(f)).matchAll(/= defineDocument\(/g)].length;
    expect(docs.size).toBe(definitions);

    const present = (await files(`${SCHEMA_DIR}/*.json`)).sort();
    const stored: Store = (file) =>
      existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), "utf8") : undefined;
    expect(problems(docs, stored, present)).toEqual([]);
  });

  test("rejects a version changed in place, a missing snapshot, a stale one and a broken migration", () => {
    const V1 = z.strictObject({ name: z.string() });
    const V2 = z.strictObject({ title: z.string() });
    const released = defineDocument("Note", { latest: V1 });
    const changed = defineDocument("Note", {
      latest: z.strictObject({ name: z.string(), tags: z.array(z.string()) }),
    });
    const store = new Map([[snapshotFile("Note", 1), renderSnapshot(snapshotOf(released, 1))]]);
    const get: Store = (f) => store.get(f);

    expect(problems(new Map([["Note", released]]), get, [...store.keys()])).toEqual([]);
    expect(problems(new Map([["Note", changed]]), get, [...store.keys()])).toEqual([
      `${SCHEMA_DIR}/Note.v1.json: Note v1 changed in place; add v2 with an upgrade instead`,
    ]);
    expect(problems(new Map(), get, [...store.keys()])).toEqual([
      `${SCHEMA_DIR}/Note.v1.json: no document version has this snapshot`,
    ]);

    const v2 = defineDocument("Note", {
      history: [{ schema: V1 }],
      latest: V2,
      upgrade: () => ({ wrong: 1 }),
    });
    store.set(snapshotFile("Note", 2), renderSnapshot(snapshotOf(v2, 2)));
    expect(problems(new Map([["Note", v2]]), get, [...store.keys()])).toEqual([
      `${SCHEMA_DIR}/Note.v1.example.json: missing; an example of Note v1 proves its migration`,
    ]);
    store.set(exampleFile("Note", 1), JSON.stringify({ kind: "Note", schemaVersion: 1, name: "a" }));
    expect(problems(new Map([["Note", v2]]), get, [...store.keys()])[0]).toContain("does not migrate to v2");
    expect(problems(new Map([["Note", v2]]), () => undefined, [])[0]).toContain(
      "missing; run `bun run schemas:freeze`",
    );
  });
});
