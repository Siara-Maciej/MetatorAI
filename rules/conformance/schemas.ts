import type { VersionedDocument } from "../../packages/core/src/index.ts";
import * as core from "../../packages/core/src/index.ts";

/** Snapshots of every released document version (MT-CODE-003): `docs/metator/schemas/<Kind>.v<N>.json`. */
export const SCHEMA_DIR = "docs/metator/schemas";

export interface SchemaSnapshot {
  readonly kind: "SchemaSnapshot";
  readonly schemaVersion: 1;
  readonly document: string;
  readonly version: number;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown>;
}

const isDocument = (v: unknown): v is VersionedDocument<unknown> =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { kind?: unknown }).kind === "string" &&
  typeof (v as { current?: unknown }).current === "number" &&
  typeof (v as { jsonSchema?: unknown }).jsonSchema === "function";

/** Every versioned document @metator/core exports, by kind. */
export function documents(): Map<string, VersionedDocument<unknown>> {
  const out = new Map<string, VersionedDocument<unknown>>();
  for (const value of Object.values(core)) if (isDocument(value)) out.set(value.kind, value);
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

export const snapshotFile = (kind: string, version: number) => `${SCHEMA_DIR}/${kind}.v${version}.json`;
export const exampleFile = (kind: string, version: number) =>
  `${SCHEMA_DIR}/${kind}.v${version}.example.json`;

export function snapshotOf(doc: VersionedDocument<unknown>, version: number): SchemaSnapshot {
  return {
    kind: "SchemaSnapshot",
    schemaVersion: 1,
    document: doc.kind,
    version,
    input: doc.jsonSchema("input", version),
    output: doc.jsonSchema("output", version),
  };
}

export const renderSnapshot = (s: SchemaSnapshot) => `${JSON.stringify(s, null, 2)}\n`;
