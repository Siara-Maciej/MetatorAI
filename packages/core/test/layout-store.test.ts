import { expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { LayoutStore } from "../src/application/layout-store.ts";
import { EMPTY_LAYOUT } from "../src/domain/layout.ts";
import { ok } from "../src/domain/result.ts";

test("no layout file is the empty layout; a saved layout reads back", async () => {
  const store = new LayoutStore(new InMemoryFileSystem());
  expect((await store.load())._unsafeUnwrap()).toEqual(EMPTY_LAYOUT);
  await store.save({ ...EMPTY_LAYOUT, next: { workspace: 4, pane: 9 } });
  expect((await store.load())._unsafeUnwrap().next).toEqual({ workspace: 4, pane: 9 });
});

test("two changes made at once are both kept: each reads what the other wrote (R5)", async () => {
  const store = new LayoutStore(new InMemoryFileSystem());
  const bump = () =>
    store.update((layout) =>
      ok({
        layout: { ...layout, next: { ...layout.next, pane: layout.next.pane + 1 } },
        value: layout.next.pane,
      }),
    );
  const seen = await Promise.all([bump(), bump(), bump()]);
  expect(seen.map((r) => r._unsafeUnwrap())).toEqual([1, 2, 3]);
  expect((await store.load())._unsafeUnwrap().next.pane).toBe(4);
});
