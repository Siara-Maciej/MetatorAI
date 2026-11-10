import { describe, expect, test } from "bun:test";
import {
  blameLines,
  DEFAULT_PATHS,
  EvalCaseDocument,
  firstChangedLine,
  parseYamlDocument,
  removedRanges,
  SeedGoldenSet,
  unifiedDiff,
} from "@metator/core";
import { InMemoryFileSystem } from "@metator/testing";

const SRC = "export function round2(n: number) {\n  return Math.round(n * 100) / 100;\n}\n";
const FIX = "a".repeat(40);
const BUG = "b".repeat(40);
const PARENT = "c".repeat(40);
const CLEAN = "d".repeat(40);
const CLEAN_PARENT = "e".repeat(40);
const HEAD = "f".repeat(40);

/** A git that answers from a table: the command's first words pick the answer. */
function fakeGit(answers: Record<string, string | { code: number }>) {
  const calls: string[] = [];
  return {
    calls,
    run: async ({ argv }: { argv: readonly string[] }) => {
      const key = argv.slice(1).join(" ");
      calls.push(key);
      const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
      if (!hit) return { exitCode: 128, stdout: "", stderr: `fatal: ${key}`, durationMs: 1 };
      const [, v] = hit;
      return typeof v === "string"
        ? { exitCode: 0, stdout: `${v}\n`, stderr: "", durationMs: 1 }
        : { exitCode: v.code, stdout: "", stderr: "no", durationMs: 1 };
    },
  };
}

describe("unified diff", () => {
  test("one hunk around the changed lines, in git's form; the first changed line is known", () => {
    const after = SRC.replace("Math.round(n * 100) / 100", "Math.round(n * 100)");
    const patch = unifiedDiff("src/invoice.ts", SRC, after);
    expect(patch.split("\n").slice(0, 4)).toEqual([
      "diff --git a/src/invoice.ts b/src/invoice.ts",
      "--- a/src/invoice.ts",
      "+++ b/src/invoice.ts",
      "@@ -1,4 +1,4 @@",
    ]);
    expect(patch).toContain("-  return Math.round(n * 100) / 100;\n+  return Math.round(n * 100);\n");
    expect(firstChangedLine(SRC, after)).toBe(2);
    expect(unifiedDiff("x", SRC, SRC)).toBe("");
    expect(firstChangedLine("a\nb\nc\n", "a\nb\n")).toBe(3);
  });

  test("removed ranges and blame lines read git's own output", () => {
    const diff =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,1 @@\n-x\n-y\n+z\n@@ -10 +9,0 @@\n-w\ndiff --git a/README.md b/README.md\n@@ -1,0 +1,2 @@\n+a\n+b\n";
    expect(removedRanges(diff)).toEqual([
      { file: "src/a.ts", start: 3, end: 4 },
      { file: "src/a.ts", start: 10, end: 10 },
    ]);
    const porcelain = `${BUG} 7 3 2\nauthor x\n\tline\n${BUG} 8 4\n\tline\n${FIX} 1 5 1\n\tline\n`;
    expect(blameLines(porcelain)).toEqual([
      [BUG, 7],
      [BUG, 8],
      [FIX, 1],
    ]);
  });
});

describe("SeedGoldenSet", () => {
  test("seeded cases plant mutants as patches; a fix's blamed commit is a bug case; ordinary commits are clean; the unfit are skipped", async () => {
    const fs = new InMemoryFileSystem({});
    const git = fakeGit({
      "rev-parse HEAD": HEAD,
      [`show ${HEAD}:src/invoice.ts`]: SRC,
      "log -n500 --format=%H%x00%s -i -E --grep": `${FIX}\0Fix rounding of negatives\n${"9".repeat(40)}\0Revert the cap`,
      [`show --format= --unified=0 --no-renames ${FIX}`]:
        "diff --git a/src/invoice.ts b/src/invoice.ts\n@@ -2,1 +2,2 @@\n-  return Math.round(n * 100) / 100;\n+  const s = n < 0 ? -1 : 1;\n+  return s * Math.round(Math.abs(n) * 100) / 100;\n",
      [`show --format= --unified=0 --no-renames ${"9".repeat(40)}`]:
        "diff --git a/README.md b/README.md\n@@ -1,1 +1,1 @@\n-a\n+b\n",
      [`blame --porcelain -L 2,2 ${FIX}^ -- src/invoice.ts`]: `${BUG} 2 2 1\nauthor x\n\t  return Math.round(n * 100) / 100;`,
      [`rev-parse ${BUG}^`]: PARENT,
      [`log -1 --format=%s ${BUG}`]: "Round to cents",
      "log -n500 --format=%H%x00%s --no-merges": `${FIX}\0Fix rounding of negatives\n${CLEAN}\0Add the discount\n${"7".repeat(40)}\0Docs only`,
      [`show --format= --name-only ${CLEAN}`]: "src/discount.ts\nsrc/discount.test.ts",
      [`show --format= --name-only ${"7".repeat(40)}`]: "README.md",
      [`rev-parse ${CLEAN}^`]: CLEAN_PARENT,
    });
    const seeder = new SeedGoldenSet({ fs, paths: DEFAULT_PATHS, runner: git, root: "/repo" });
    const report = (
      await seeder.execute({
        mutants: [
          { file: "src/invoice.ts", from: "/ 100", to: "/ 10", why: "cents, not tenths" },
          { file: "src/invoice.ts", from: "Math.round", to: "Math.floor", why: "rounds half up" },
          { file: "src/invoice.ts", from: "n", to: "m", why: "ambiguous: n occurs many times" },
          { file: "src/missing.ts", from: "a", to: "b", why: "no such file" },
        ],
        seeded: 5,
        bugs: 3,
        clean: 3,
      })
    )._unsafeUnwrap();
    expect(report.written.map((w) => [w.id, w.type])).toEqual([
      ["seeded-src-invoice-1", "seeded"],
      ["seeded-src-invoice-2", "seeded"],
      [`bug-${BUG.slice(0, 10)}`, "bug"],
      [`clean-${CLEAN.slice(0, 10)}`, "clean"],
    ]);
    expect(report.skipped).toEqual([
      'src/invoice.ts: "n" found 8 times, not once',
      `src/missing.ts: not in ${HEAD.slice(0, 12)}`,
      `${"9".repeat(12)} Revert the cap: removes no code line`,
      `${"7".repeat(12)} Docs only: no code for a clean case`,
    ]);
    const seeded = parseYamlDocument(
      (await fs.read(`${DEFAULT_PATHS.evals}/seeded-src-invoice-1.yml`))._unsafeUnwrap(),
      "x",
    )
      .andThen((raw) => EvalCaseDocument.parse(raw, "x"))
      ._unsafeUnwrap();
    expect(seeded).toMatchObject({
      type: "seeded",
      base: HEAD,
      head: "golden/seeded-src-invoice-1",
      patch: `${DEFAULT_PATHS.evals}/patches/seeded-src-invoice-1.patch`,
      expected: [{ file: "src/invoice.ts", line: 2, severity: "blocking", note: "cents, not tenths" }],
    });
    expect(
      (await fs.read(`${DEFAULT_PATHS.evals}/patches/seeded-src-invoice-1.patch`))._unsafeUnwrap(),
    ).toContain("+  return Math.round(n * 100) / 10;");
    const bug = parseYamlDocument(
      (await fs.read(`${DEFAULT_PATHS.evals}/bug-${BUG.slice(0, 10)}.yml`))._unsafeUnwrap(),
      "x",
    )
      .andThen((raw) => EvalCaseDocument.parse(raw, "x"))
      ._unsafeUnwrap();
    expect(bug).toMatchObject({
      type: "bug",
      base: PARENT,
      head: BUG,
      expected: [{ file: "src/invoice.ts", line: 2 }],
    });
    expect(bug.description).toContain("Round to cents");
    const clean = parseYamlDocument(
      (await fs.read(`${DEFAULT_PATHS.evals}/clean-${CLEAN.slice(0, 10)}.yml`))._unsafeUnwrap(),
      "x",
    )
      .andThen((raw) => EvalCaseDocument.parse(raw, "x"))
      ._unsafeUnwrap();
    expect(clean).toMatchObject({ type: "clean", base: CLEAN_PARENT, head: CLEAN, expected: [] });
    // A v1 case still parses.
    expect(
      EvalCaseDocument.parse(
        { kind: "EvalCase", schemaVersion: 1, id: "old", type: "clean", base: "a", head: "b" },
        "old",
      ).isOk(),
    ).toBe(true);
  });
});
