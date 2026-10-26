/**
 * MT-TEST-003: every core and plugin module with behavior is guarded by a mutant in
 * scripts/mutants.ts, which `bun run test:mutation` requires the unit suite to kill.
 */
import { describe, expect, test } from "bun:test";
import { MUTANTS, type Mutant } from "../../scripts/mutants.ts";
import { sources } from "./lib.ts";

/** Code that runs: a function, a class or an arrow function (types and constants alone do not). */
const BEHAVIOR = /\bfunction\b|\bclass\s+\w+|=>/;

function unguarded(modules: ReadonlyMap<string, string>, mutants: readonly Pick<Mutant, "file">[]): string[] {
  const guarded = new Set(mutants.map((m) => m.file));
  return [...modules]
    .filter(([file, text]) => !file.endsWith("/index.ts") && BEHAVIOR.test(text) && !guarded.has(file))
    .map(([file]) => `${file}: no mutant in scripts/mutants.ts`);
}

describe("MT-TEST-003", () => {
  test("every core and plugin module with behavior has a mutant", async () => {
    const modules = new Map([
      ...(await sources("packages/core/src/**/*.ts")),
      ...(await sources("packages/plugin-*/src/**/*.ts")),
    ]);
    expect(modules.size).toBeGreaterThan(40);
    expect(unguarded(modules, MUTANTS)).toEqual([]);
  });

  test("rejects a module with behavior and no mutant", () => {
    const modules = new Map([
      ["packages/core/src/domain/a.ts", "export function a() {}"],
      ["packages/core/src/domain/b.ts", "export const b = (x: number) => x + 1;"],
      ["packages/core/src/domain/types.ts", "export interface T { readonly a: string }"],
      ["packages/core/src/index.ts", 'export * from "./domain/a.ts";'],
    ]);
    expect(unguarded(modules, [{ file: "packages/core/src/domain/a.ts" }])).toEqual([
      "packages/core/src/domain/b.ts: no mutant in scripts/mutants.ts",
    ]);
  });
});
