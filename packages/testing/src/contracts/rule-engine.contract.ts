import { describe, expect, test } from "bun:test";
import type { RuleEngine } from "@metator/core";

export interface RuleEngineWorld {
  /** The engine on a project that configures the tool, with at least one rule and one finding. */
  readonly engine: RuleEngine;
  /** The engine on a project that does not use the tool at all. */
  readonly bare: RuleEngine;
  /** The engine on the same kind of project when the tool's binary cannot be started; omitted by a fake. */
  readonly missing?: RuleEngine;
  /** A finding `engine.check()` reports. */
  readonly finding: { readonly file: string; readonly toolRuleId: string };
  /**
   * For an engine that checks the files it is given: a file of the project with no finding.
   * Omitted by an engine that only checks the project as a whole.
   */
  readonly clean?: string;
}

/**
 * Every RuleEngine adapter passes this suite: rules listed in a stable order, a project that does
 * not use the tool has nothing to check, findings are the engine's own with repo-relative files
 * in a stable order, files that are gone are skipped, and a tool that is not installed is an
 * error value (never a throw, never an empty success).
 */
export function ruleEngineContract(name: string, make: () => Promise<RuleEngineWorld>): void {
  describe(`RuleEngine contract: ${name}`, () => {
    test("lists its rules, each with an id and a source, sorted by id", async () => {
      const w = await make();
      const rules = (await w.engine.rules())._unsafeUnwrap();
      expect(rules.length).toBeGreaterThan(0);
      const ids = rules.map((r) => r.id);
      expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of rules) {
        expect(r.id.length).toBeGreaterThan(0);
        expect(r.source.length).toBeGreaterThan(0);
        expect(typeof r.hasTest).toBe("boolean");
      }
    }, 120_000);

    test("a project that does not use the tool has no rules and nothing to check", async () => {
      const w = await make();
      expect((await w.bare.rules())._unsafeUnwrap()).toEqual([]);
      expect((await w.bare.check())._unsafeUnwrap()).toEqual([]);
    }, 120_000);

    test("findings are the engine's own, with repo-relative files, the same on every run", async () => {
      const w = await make();
      const first = (await w.engine.check())._unsafeUnwrap();
      expect(first.some((d) => d.file === w.finding.file && d.toolRuleId === w.finding.toolRuleId)).toBe(
        true,
      );
      for (const d of first) {
        expect(d.source).toBe(w.engine.engine);
        expect(d.file.startsWith("/") || d.file.includes("\\") || d.file.startsWith("./")).toBe(false);
        expect(d.message.length).toBeGreaterThan(0);
      }
      expect((await w.engine.check())._unsafeUnwrap()).toEqual(first);
    }, 120_000);

    test("checking given files reports nothing the whole project does not; a file that is gone is skipped", async () => {
      const w = await make();
      const all = (await w.engine.check())._unsafeUnwrap();
      const some = (await w.engine.check([w.finding.file, "gone/not-here.ts"]))._unsafeUnwrap();
      for (const d of some) expect(all).toContainEqual(d);
      expect(some.some((d) => d.file === w.finding.file && d.toolRuleId === w.finding.toolRuleId)).toBe(true);
      if (w.clean !== undefined) expect((await w.engine.check([w.clean]))._unsafeUnwrap()).toEqual([]);
    }, 120_000);

    test("a tool that cannot be started is BIN_NOT_FOUND, not a throw and not an empty success", async () => {
      const w = await make();
      if (!w.missing) return;
      expect((await w.missing.check())._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
    }, 120_000);
  });
}
