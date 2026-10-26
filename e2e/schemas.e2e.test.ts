/** `* schema` commands end to end: the real `metator` process prints each document's JSON Schema. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

interface Schema {
  readonly properties: Record<string, { const?: unknown }>;
  readonly required: readonly string[];
}

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
});
afterAll(async () => {
  await repo.dispose();
});

const CASES: readonly { argv: string[]; kind: string; fields: string[] }[] = [
  { argv: ["patterns", "schema"], kind: "Pattern", fields: ["id", "detection", "exemplar"] },
  { argv: ["config", "schema"], kind: "MetatorConfig", fields: ["gates", "paths"] },
  { argv: ["meta", "agents-schema"], kind: "Agent", fields: ["id", "role", "delegates"] },
  { argv: ["eval", "schema"], kind: "EvalCase", fields: ["id"] },
];

describe("metator * schema (real CLI)", () => {
  for (const { argv, kind, fields } of CASES) {
    test(`${argv.join(" ")} prints the ${kind} JSON Schema with its header`, async () => {
      const r = await metator(argv, repo.root);
      expect(r.code).toBe(0);
      const schema = r.json.data as Schema;
      expect(schema.properties.kind?.const).toBe(kind);
      expect(schema.properties.schemaVersion?.const).toBe(1);
      expect(schema.required.slice(0, 2)).toEqual(["kind", "schemaVersion"]);
      for (const field of fields) expect(Object.keys(schema.properties)).toContain(field);
    });
  }

  test("a schema command takes no arguments", async () => {
    expect((await metator(["eval", "schema", "extra"], repo.root)).code).toBe(64);
  });
});
