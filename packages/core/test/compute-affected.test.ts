import { describe, expect, test } from "bun:test";
import { ComputeAffected } from "../src/application/compute-affected.ts";
import { MetatorError } from "../src/domain/errors.ts";
import type { Edge } from "../src/domain/graph.ts";
import { err, ok } from "../src/domain/result.ts";
import type { ImportGraphReader, Vcs } from "../src/ports/index.ts";

const edges: Edge[] = [
  { from: "packages/a/src/ui.ts", to: "packages/a/src/service.ts", kind: "internal" },
  { from: "packages/a/test/service.test.ts", to: "packages/a/src/service.ts", kind: "internal" },
];
const graphReader: ImportGraphReader = { read: async () => ok(edges) };
const vcs = (files: string[]): Vcs => ({
  listFiles: async () => ok([]),
  changedFiles: async () => ok(files),
});
const testGlobs = ["**/*.test.ts"];

describe("ComputeAffected", () => {
  test("uses VCS diff when no explicit files are given", async () => {
    const useCase = new ComputeAffected(vcs(["packages/a/src/service.ts"]), graphReader, testGlobs);
    const result = await useCase.execute({ base: "main" });
    expect(result).toEqual(
      ok({
        changed: ["packages/a/src/service.ts"],
        files: ["packages/a/src/service.ts", "packages/a/src/ui.ts", "packages/a/test/service.test.ts"],
        tests: ["packages/a/test/service.test.ts"],
      }),
    );
  });

  test("explicit changed files take precedence over VCS", async () => {
    const failingVcs: Vcs = {
      listFiles: async () => ok([]),
      changedFiles: async () => err(new MetatorError("INTERNAL", "should not be called")),
    };
    const result = await new ComputeAffected(failingVcs, graphReader, testGlobs).execute({
      changed: ["packages/a/src/ui.ts"],
    });
    expect(result._unsafeUnwrap().files).toEqual(["packages/a/src/ui.ts"]);
  });

  test("propagates graph reader errors", async () => {
    const broken: ImportGraphReader = {
      read: async () => err(new MetatorError("STALE_INDEX", "index is stale")),
    };
    const result = await new ComputeAffected(vcs([]), broken, testGlobs).execute({});
    expect(result._unsafeUnwrapErr().code).toBe("STALE_INDEX");
  });
});
