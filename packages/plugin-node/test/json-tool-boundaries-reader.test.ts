import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixture } from "@metator/testing";
import { JsonToolBoundariesReader } from "../src/json-tool-boundaries-reader.ts";

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-boundaries-"));
  dirs.push(dir);
  await writeFixture(dir, files);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("JsonToolBoundariesReader", () => {
  test("Turborepo boundaries from turbo.json (with comments) and Nx depConstraints from .eslintrc.json", async () => {
    const root = await fixture({
      "turbo.json": `{
        // Turborepo allows comments
        "boundaries": { "tags": { "type:ui": { "dependencies": { "deny": ["type:db"] } } } },
      }`,
      ".eslintrc.json": JSON.stringify({
        rules: {
          "@nx/enforce-module-boundaries": [
            "error",
            { depConstraints: [{ sourceTag: "scope:shop", onlyDependOnLibsWithTags: ["scope:shop"] }] },
          ],
        },
      }),
    });
    expect((await new JsonToolBoundariesReader(root).read())._unsafeUnwrap()).toEqual([
      { source: "turbo.json", rules: [{ from: "type:ui", deny: ["type:db"] }] },
      { source: ".eslintrc.json", rules: [{ from: "scope:shop", allow: ["scope:shop"] }] },
    ]);
  });

  test("missing, broken or rule-less files add nothing", async () => {
    const root = await fixture({ "turbo.json": "{ broken", ".eslintrc": JSON.stringify({ rules: {} }) });
    expect((await new JsonToolBoundariesReader(root).read())._unsafeUnwrap()).toEqual([]);
    const empty = await fixture({ "README.md": "x" });
    expect((await new JsonToolBoundariesReader(empty).read())._unsafeUnwrap()).toEqual([]);
  });
});
