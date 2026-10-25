import { describe, expect, test } from "bun:test";
import { ComputeAffected } from "../src/application/compute-affected.ts";
import { ok } from "../src/domain/result.ts";
import type { ImportGraphReader, Vcs } from "../src/ports/index.ts";

describe("ComputeAffected edge cases", () => {
  test("defaults the diff base to HEAD", async () => {
    const bases: string[] = [];
    const vcs: Vcs = {
      changedFiles: async (base) => {
        bases.push(base);
        return ok([]);
      },
    };
    const graph: ImportGraphReader = { read: async () => ok([]) };
    await new ComputeAffected(vcs, graph, []).execute({});
    expect(bases).toEqual(["HEAD"]);
  });

  test("output is sorted and de-duplicated regardless of input order", async () => {
    const graph: ImportGraphReader = {
      read: async () =>
        ok([
          { from: "z.ts", to: "a.ts", kind: "internal" },
          { from: "m.ts", to: "a.ts", kind: "internal" },
        ]),
    };
    const vcs: Vcs = { changedFiles: async () => ok(["a.ts", "a.ts"]) };
    const result = await new ComputeAffected(vcs, graph, []).execute({});
    expect(result._unsafeUnwrap().files).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  test("test globs honor negation (e.g. exclude e2e from unit selection)", async () => {
    const graph: ImportGraphReader = {
      read: async () =>
        ok([
          { from: "src/a.test.ts", to: "src/a.ts", kind: "internal" },
          { from: "e2e/a.e2e.test.ts", to: "src/a.ts", kind: "internal" },
        ]),
    };
    const vcs: Vcs = { changedFiles: async () => ok(["src/a.ts"]) };
    const result = await new ComputeAffected(vcs, graph, ["**/*.test.ts", "!e2e/**"]).execute({});
    expect(result._unsafeUnwrap().tests).toEqual(["src/a.test.ts"]);
  });

  test("changes to files outside the graph still surface (new files, configs)", async () => {
    const graph: ImportGraphReader = { read: async () => ok([]) };
    const vcs: Vcs = { changedFiles: async () => ok(["biome.json"]) };
    const result = await new ComputeAffected(vcs, graph, ["**/*.test.ts"]).execute({});
    expect(result._unsafeUnwrap()).toEqual({ changed: ["biome.json"], files: ["biome.json"], tests: [] });
  });
});
