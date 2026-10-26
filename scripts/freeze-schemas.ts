/**
 * Freezes the schema of every document version that has no snapshot yet (MT-CODE-003).
 * Existing snapshots are never rewritten: a released version does not change in place.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { documents, renderSnapshot, snapshotFile, snapshotOf } from "../rules/conformance/schemas.ts";

const root = join(import.meta.dir, "..");
const written: string[] = [];
for (const doc of documents().values()) {
  for (let v = 1; v <= doc.current; v++) {
    const file = snapshotFile(doc.kind, v);
    if (existsSync(join(root, file))) continue;
    await Bun.write(join(root, file), renderSnapshot(snapshotOf(doc, v)));
    written.push(file);
  }
}
console.log(written.length === 0 ? "every version is frozen" : `froze ${written.join(", ")}`);
