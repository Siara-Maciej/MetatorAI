/**
 * `lessons add`, `findings check-quote` and `debug-tags check` end to end: real `metator`
 * processes on a real git repository.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const CODE = "export function total(a: number) {\n  if (a < 0) throw new Error();\n  return a;\n}\n";
// Built at run time, so this file never carries a real marker itself.
const TAG = `[DEBUG-${"c0de"}]`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("src/total.ts", CODE);
  await repo.write(
    "docs/metator/memory-map.yml",
    `kind: MemoryMap
schemaVersion: 1
items:
  - id: t4.lessons
    tier: T4
    kind: learned
    paths: ["docs/metator/lessons/*.md"]
    load: explicit
    writers: [mt-retro]
    readers: [mt-planner]
`,
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator lessons add (real CLI)", () => {
  test("a lesson with true evidence is written and passes memory validate", async () => {
    const args = ["--statement", "Reject negative totals first.", "--file", "src/total.ts", "--line", "3"];
    const r = await metator(
      [
        "lessons",
        "add",
        "--title",
        "Guard negative totals",
        ...args,
        "--quote",
        "if (a < 0) throw",
        "--tag",
        "billing",
      ],
      repo.root,
      { METATOR_NOW: "2026-10-26T12:00:00.000Z" },
    );
    expect(r.code).toBe(0);
    // The quote is on line 2: the lesson is written with the true line.
    expect(r.json.data).toMatchObject({ file: "docs/metator/lessons/guard-negative-totals.md", line: 2 });
    const text = await repo.read("docs/metator/lessons/guard-negative-totals.md");
    expect(text).toStartWith("---\nkind: Lesson\nschemaVersion: 1\nid: guard-negative-totals\n");
    expect(text).toContain('[[cite: src/total.ts:2 | "if (a < 0) throw"]]');
    const validate = await metator(["memory", "validate"], repo.root);
    expect([validate.code, JSON.stringify(validate.json.data)]).toEqual([
      0,
      expect.stringContaining('"ok":1'),
    ]);
  });

  test("no evidence, no lesson", async () => {
    const r = await metator(
      [
        "lessons",
        "add",
        "--title",
        "Made up",
        "--statement",
        "s",
        "--file",
        "src/total.ts",
        "--line",
        "1",
        "--quote",
        "not in the code",
      ],
      repo.root,
    );
    expect([r.code, (r.json.error as { code: string }).code]).toEqual([1, "CHECK_FAILED"]);
  });
});

describe("metator findings check-quote (real CLI)", () => {
  test("ok passes; a moved or missing quote fails with the true line", async () => {
    const at = (line: string, quote: string) =>
      metator(["findings", "check-quote", "src/total.ts", "--line", line, "--quote", quote], repo.root);
    const ok = await at("3", "return a;");
    expect([ok.code, ok.json.data]).toEqual([0, { file: "src/total.ts", status: "ok", line: 3 }]);
    const moved = await at("1", "return a;");
    expect([moved.code, (moved.json.error as { message: string }).message]).toEqual([
      1,
      "quote is on line 3 of src/total.ts, not 1",
    ]);
    expect((await at("1", "nowhere")).code).toBe(1);
    expect((await at("0", "x")).code).toBe(64);
  });
});

describe("metator debug-tags check (real CLI)", () => {
  test("a left marker fails, on the branch and across the repository", async () => {
    expect((await metator(["debug-tags", "check"], repo.root)).code).toBe(0);
    await repo.write("src/total.ts", CODE.replace("return a;", `console.log("${TAG}", a);\n  return a;`));
    for (const args of [
      ["debug-tags", "check", "--base", "main"],
      ["debug-tags", "check"],
    ]) {
      const r = await metator(args, repo.root);
      expect(r.code).toBe(1);
      expect((r.json.error as { details: { tags: unknown[] } }).details.tags).toEqual([
        { file: "src/total.ts", line: 3, tag: TAG },
      ]);
    }
    await repo.write("src/total.ts", CODE);
  });

  test("dogfood: MetatorAI carries no debug markers", async () => {
    const r = await metator(["debug-tags", "check", "--root", SELF], SELF);
    expect(r.code).toBe(0);
  }, 60_000);
});
