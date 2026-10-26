import { describe, expect, test } from "bun:test";
import { FakeVcs, FixedClock, InMemoryFileSystem } from "@metator/testing";
import { CheckDebugTags } from "../src/application/debug-tags.ts";
import { AddLesson } from "../src/application/lessons.ts";
import { CheckQuote } from "../src/application/quotes.ts";
import { findDebugTags } from "../src/domain/debug-tags.ts";
import { LessonDocument } from "../src/domain/lesson.ts";
import { parseCitations } from "../src/domain/memory.ts";
import { readFrontMatter } from "../src/domain/versioned.ts";

const CODE = "export function total(a: number) {\n  if (a < 0) throw new Error();\n  return a;\n}\n";
const clock = new FixedClock(new Date("2026-10-26T12:00:00.000Z"));

describe("AddLesson", () => {
  const cite = { path: "src/total.ts", line: 2, quote: "if (a < 0) throw" };
  const add = (fs: InMemoryFileSystem) => new AddLesson(fs, clock, "docs/metator/lessons");

  test("writes a versioned lesson whose citation holds", async () => {
    const fs = new InMemoryFileSystem({ "src/total.ts": CODE });
    const r = (
      await add(fs).execute({
        title: "Guard negative totals",
        statement: "Totals reject negative input before any rounding.",
        cite,
        run: "20261026-feature-x",
        tags: ["billing"],
      })
    )._unsafeUnwrap();
    expect([r.file, r.line]).toEqual(["docs/metator/lessons/guard-negative-totals.md", 2]);
    const text = (await fs.read(r.file))._unsafeUnwrap();
    expect(
      readFrontMatter(text, r.file)
        .andThen((raw) => LessonDocument.parse(raw, r.file))
        ._unsafeUnwrap(),
    ).toEqual({
      id: "guard-negative-totals",
      title: "Guard negative totals",
      createdAt: "2026-10-26T12:00:00.000Z",
      run: "20261026-feature-x",
      tags: ["billing"],
    });
    expect(text).toContain("# Guard negative totals\n\nTotals reject negative input before any rounding.");
    expect(parseCitations(text, { markdown: true }).map((c) => [c.path, c.line, c.quote])).toEqual([
      ["src/total.ts", 2, "if (a < 0) throw"],
    ]);
  });

  test("a quote that moved is written with the line it is really on; no run, no tags", async () => {
    const fs = new InMemoryFileSystem({ "src/total.ts": CODE });
    const r = (
      await add(fs).execute({ title: "T", statement: "s", cite: { ...cite, line: 4 } })
    )._unsafeUnwrap();
    expect([r.line, r.lesson.run, r.lesson.tags]).toEqual([2, undefined, []]);
    expect((await fs.read(r.file))._unsafeUnwrap()).toContain("src/total.ts:2 |");
  });

  test("no evidence, no lesson: a missing file, a stale quote and a duplicate are errors", async () => {
    const fs = new InMemoryFileSystem({ "src/total.ts": CODE });
    const missing = await add(fs).execute({
      title: "T",
      statement: "s",
      cite: { ...cite, path: "src/gone.ts" },
    });
    expect(missing._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    const stale = await add(fs).execute({
      title: "T",
      statement: "s",
      cite: { ...cite, quote: "never there" },
    });
    expect(stale._unsafeUnwrapErr().code).toBe("CHECK_FAILED");
    expect(await fs.exists("docs/metator/lessons/t.md")).toBe(false);
    await add(fs).execute({ title: "T", statement: "s", cite });
    expect((await add(fs).execute({ title: "T", statement: "s", cite }))._unsafeUnwrapErr().code).toBe(
      "USAGE",
    );
  });

  test("a title with nothing to slug still gets a file name", async () => {
    const fs = new InMemoryFileSystem({ "src/total.ts": CODE });
    expect((await add(fs).execute({ title: "!!!", statement: "s", cite }))._unsafeUnwrap().file).toBe(
      "docs/metator/lessons/lesson.md",
    );
  });
});

describe("CheckQuote", () => {
  const check = new CheckQuote(new InMemoryFileSystem({ "src/total.ts": CODE }));

  test("ok, moved or stale, with the line the quote is on", async () => {
    const at = (line: number, quote: string) => check.execute({ file: "src/total.ts", line, quote });
    expect((await at(2, "if  (a < 0)\tthrow"))._unsafeUnwrap()).toEqual({
      file: "src/total.ts",
      status: "ok",
      line: 2,
    });
    expect((await at(3, "return a;"))._unsafeUnwrap()).toEqual({
      file: "src/total.ts",
      status: "ok",
      line: 3,
    });
    expect((await at(1, "return a;"))._unsafeUnwrap().status).toBe("moved");
    expect((await at(1, "nowhere"))._unsafeUnwrap().status).toBe("stale");
  });

  test("a missing file is an error value", async () => {
    expect((await check.execute({ file: "x.ts", line: 1, quote: "q" }))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
  });
});

// Built at run time, so this file never carries a real marker itself.
const TAG = `[DEBUG-${"a1b2"}]`;

describe("debug tags", () => {
  test("findDebugTags: every marker with its line; words that only look alike are not markers", () => {
    const text = `ok\nconsole.log("${TAG} x", "${TAG.toUpperCase()}")\n[DEBUG-xxxx] [DEBUG-12] [DEBUG-${"beef"}`;
    expect(findDebugTags("a.ts", text)).toEqual([
      { file: "a.ts", line: 2, tag: TAG },
      { file: "a.ts", line: 2, tag: TAG.toUpperCase() },
    ]);
  });

  test("CheckDebugTags scans changed files against a base, or every file; ignored and deleted files are skipped", async () => {
    const fs = new InMemoryFileSystem({
      "src/a.ts": `log("${TAG}")`,
      "src/b.ts": "clean",
      "dist/out.js": `log("${TAG}")`,
    });
    const vcs = new FakeVcs(["src/a.ts", "src/b.ts", "dist/out.js"], ["src/b.ts", "src/deleted.ts"]);
    const checker = new CheckDebugTags(vcs, fs, ["dist/**"]);
    expect((await checker.execute({}))._unsafeUnwrap()).toEqual({
      scanned: 2,
      tags: [{ file: "src/a.ts", line: 1, tag: TAG }],
    });
    expect((await checker.execute({ base: "main" }))._unsafeUnwrap()).toEqual({ scanned: 1, tags: [] });
    const notRepo = new CheckDebugTags(new FakeVcs("not-a-repo"), fs, []);
    expect((await notRepo.execute({}))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});
