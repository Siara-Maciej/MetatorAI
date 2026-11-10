import { describe, expect, test } from "bun:test";
import type { CodeHost, IntakeSource } from "@metator/core";

/** What the adapter under test must be able to reach for the suite. */
export interface CodeHostFixture {
  /** A source the adapter can list, holding at least the item below. */
  readonly source: IntakeSource;
  readonly item: { readonly ref: string; readonly title: string };
  /** A source whose server or project does not exist. */
  readonly missing: IntakeSource;
}

/** Every CodeHost adapter must pass this suite (T2, ADR-0083). */
export function codeHostContract(name: string, make: () => CodeHost, fixture: CodeHostFixture): void {
  describe(`CodeHost contract: ${name}`, () => {
    test("lists a source's items with an id, a title and labels; listing twice names the same ids", async () => {
      const first = (await make().listItems(fixture.source))._unsafeUnwrap();
      const found = first.find((i) => i.ref === fixture.item.ref);
      expect(found?.title).toBe(fixture.item.title);
      for (const i of first) {
        expect([i.ref.length > 0, i.title.length > 0, Array.isArray(i.labels), typeof i.body]).toEqual([
          true,
          true,
          true,
          "string",
        ]);
      }
      const second = (await make().listItems(fixture.source))._unsafeUnwrap();
      expect(second.map((i) => i.ref)).toEqual(first.map((i) => i.ref));
    });

    test("a source that cannot be reached is an error value, never a throw", async () => {
      const r = await make().listItems(fixture.missing);
      expect(r.isErr()).toBe(true);
      expect(r._unsafeUnwrapErr().message.length).toBeGreaterThan(0);
    });
  });
}
