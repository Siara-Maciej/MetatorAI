/**
 * `symbols find` and `graph callers` end to end: the real `metator` process on a real
 * Bun-workspaces monorepo (real `bun install`, real oxc parsing and resolution).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMonorepo } from "@metator/testing";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await createMonorepo(repo.root);
  await repo.commit("init");
}, 60_000);
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("metator symbols find / graph callers (real CLI)", () => {
  test("find names the defining file and the barrel that re-exports it", async () => {
    const r = await metator(["symbols", "find", "add"], repo.root);
    expect(r.json.data).toEqual({
      name: "add",
      definitions: [{ file: "packages/money/src/money.ts", line: 2, typeOnly: false }],
      reexportedBy: ["packages/money/src/index.ts"],
    });
  });

  test("callers come in directly and across packages through the package entry", async () => {
    const r = await metator(["graph", "callers", "add"], repo.root);
    expect(r.code).toBe(0);
    const callers = (r.json.data as { callers: { file: string; via: string }[] }).callers;
    expect(callers).toContainEqual(
      expect.objectContaining({
        file: "packages/money/src/money.test.ts",
        via: "packages/money/src/money.ts",
      }),
    );
    expect(callers).toContainEqual(
      expect.objectContaining({
        file: "packages/billing/src/invoice.ts",
        via: "packages/money/src/index.ts",
      }),
    );
  });

  test("an unknown symbol is NOT_FOUND; one defined twice needs --file", async () => {
    expect((await metator(["graph", "callers", "nothingLikeThis"], repo.root)).json.error).toMatchObject({
      code: "NOT_FOUND",
    });
    await repo.write("packages/billing/src/add.ts", "export const add = 0;\n");
    try {
      const r = await metator(["graph", "callers", "add"], repo.root);
      expect([r.code, (r.json.error as Data).code]).toEqual([64, "USAGE"]);
      const one = await metator(
        ["graph", "callers", "add", "--file", "packages/billing/src/add.ts"],
        repo.root,
      );
      expect((one.json.data as Data).callers).toEqual([]);
    } finally {
      await repo.git("clean", "-fq", "packages/billing/src/add.ts");
    }
  });

  test("dogfood: RunGate is used by the runtime through @metator/core", async () => {
    const r = await metator(["graph", "callers", "RunGate", "--root", SELF], SELF);
    const callers = (r.json.data as { callers: { file: string }[] }).callers.map((c) => c.file);
    expect(callers).toContain("packages/runtime/src/bootstrap.ts");
  });
});
