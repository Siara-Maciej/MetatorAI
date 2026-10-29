import { describe, expect, test } from "bun:test";
import type { ContractDiffer } from "@metator/core";

/** Specifications of one contract kind that every differ of that kind must classify alike. */
export interface DifferFixtures {
  readonly base: string;
  /** `base` with something added (a path, an optional field). */
  readonly compatible: string;
  /** `base` with something consumers use removed. */
  readonly breaking: string;
  /** Not a specification of the kind at all. */
  readonly invalid: string;
}

/** Every ContractDiffer adapter must pass this suite (F7.4, ADR-0069). */
export function contractDifferContract(
  name: string,
  make: () => ContractDiffer,
  fixtures: DifferFixtures,
): void {
  const side = (text: string) => ({ path: "spec", text });
  describe(`ContractDiffer contract: ${name}`, () => {
    test("names its contract kind; an identical specification has no changes", async () => {
      const differ = make();
      expect(differ.kind.length).toBeGreaterThan(0);
      const same = (await differ.compare(side(fixtures.base), side(fixtures.base)))._unsafeUnwrap();
      expect(same.changes).toEqual([]);
    });

    test("an addition is a change and not breaking; a removal is breaking", async () => {
      const added = (await make().compare(side(fixtures.base), side(fixtures.compatible)))._unsafeUnwrap();
      expect(added.changes.length).toBeGreaterThan(0);
      expect(added.changes.filter((c) => c.severity === "breaking")).toEqual([]);
      const removed = (await make().compare(side(fixtures.base), side(fixtures.breaking)))._unsafeUnwrap();
      expect(removed.changes.some((c) => c.severity === "breaking")).toBe(true);
      for (const c of [...added.changes, ...removed.changes])
        expect([c.code.length > 0, c.message.length > 0]).toEqual([true, true]);
    });

    test("an invalid specification on either side is an error value, never a throw", async () => {
      expect((await make().compare(side(fixtures.invalid), side(fixtures.base))).isErr()).toBe(true);
      expect((await make().compare(side(fixtures.base), side(fixtures.invalid))).isErr()).toBe(true);
    });
  });
}
