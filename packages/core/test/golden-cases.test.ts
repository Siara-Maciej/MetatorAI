import { expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { z } from "zod";
import { loadGoldenCases, runGoldenCases } from "../src/application/golden-cases.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import { defineDocument } from "../src/domain/versioned.ts";
import type { Sandbox } from "../src/ports/index.ts";

const Case = defineDocument("Case", {
  latest: z.strictObject({ id: z.string(), files: z.record(z.string(), z.string()) }),
});
const yml = (id: string) => `kind: Case\nschemaVersion: 1\nid: ${id}\nfiles:\n  a.ts: "${id}"\n`;

function sandbox(): Sandbox & { made: Record<string, string>[]; disposed: number } {
  const box = {
    made: [] as Record<string, string>[],
    disposed: 0,
    create: async (files: Readonly<Record<string, string>>) => {
      box.made.push({ ...files });
      return ok({
        root: `/box${box.made.length}`,
        dispose: async () => {
          box.disposed++;
        },
      });
    },
  };
  return box;
}

test("golden cases are read in id order; one invalid case fails them all", async () => {
  const fs = new InMemoryFileSystem({
    "evals/2.yml": yml("a"),
    "evals/1.yml": yml("b"),
    "evals/x.txt": "no",
  });
  const cases = (await loadGoldenCases(fs, "evals", Case))._unsafeUnwrap();
  expect(cases.map((c) => c.id)).toEqual(["a", "b"]);
  await fs.write("evals/bad.yml", "kind: Case\nschemaVersion: 1\n");
  expect((await loadGoldenCases(fs, "evals", Case)).isErr()).toBe(true);
});

test("every selected case is scored in its own sandbox with the extra files under its own, then disposed", async () => {
  const box = sandbox();
  const cases = [
    { id: "a", files: { "a.ts": "A", "shared.md": "mine" } },
    { id: "b", files: { "b.ts": "B" } },
  ];
  const run = (only?: string) =>
    runGoldenCases({
      cases,
      ...(only ? { only } : {}),
      noun: "demo eval",
      dir: "evals",
      sandbox: box,
      extra: async () => ({ "shared.md": "extra", "agent.md": "x" }),
      score: async (c, root) => `${c.id}@${root}`,
    });
  expect((await run())._unsafeUnwrap()).toEqual(["a@/box1", "b@/box2"]);
  expect(box.made[0]).toEqual({ "shared.md": "mine", "agent.md": "x", "a.ts": "A" });
  expect(box.disposed).toBe(2);
  expect((await run("b"))._unsafeUnwrap()).toEqual(["b@/box3"]);
});

test("no case to run is NOT_FOUND and asks for nothing; a failing score still disposes its sandbox", async () => {
  const box = sandbox();
  let asked = 0;
  const base = {
    noun: "demo eval",
    dir: "evals",
    sandbox: box,
    extra: async () => {
      asked++;
      return {};
    },
  };
  const none = await runGoldenCases({ ...base, cases: [], score: async () => 1 });
  expect(none._unsafeUnwrapErr().message).toContain("demo eval cases in evals");
  const other = await runGoldenCases({
    ...base,
    cases: [{ id: "a", files: {} }],
    only: "zzz",
    score: async () => 1,
  });
  expect([other._unsafeUnwrapErr().code, other._unsafeUnwrapErr().message]).toEqual([
    "NOT_FOUND",
    expect.stringContaining("demo eval case zzz"),
  ]);
  expect([asked, box.made.length]).toEqual([0, 0]);
  const thrown = runGoldenCases({
    ...base,
    cases: [{ id: "a", files: {} }],
    score: async () => {
      throw new Error("boom");
    },
  });
  expect(thrown).rejects.toThrow("boom");
  await thrown.catch(() => undefined);
  expect(box.disposed).toBe(1);
  const noBox: Sandbox = { create: async () => err(new MetatorError("INTERNAL", "no sandbox")) };
  const failed = await runGoldenCases({
    ...base,
    cases: [{ id: "a", files: {} }],
    sandbox: noBox,
    score: async () => 1,
  });
  expect(failed._unsafeUnwrapErr().message).toBe("no sandbox");
});
