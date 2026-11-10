/**
 * Review evals end to end: the real `metator` process runs a stand-in headless reviewer per
 * golden case and repeat, scores the outputs and gates a regression.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

const finding = (line: number) => ({
  id: `LOGIC-${String(line).padStart(3, "0")}`,
  lens: "logic",
  severity: "blocking",
  confidence: 0.9,
  location: { file: "src/pay.ts", line },
  quote: "return amount * rate;",
  claim: "rate is never defined, so pay throws",
  trigger: "any amount",
  reachability: "checkout → pay",
  evidence: { type: "test", ref: "pay(1) throws" },
  verification: { status: "confirmed", by: "mt-verifier", evidence: "pay(1) throws" },
});

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(
    "docs/metator/evals/golden/rate-undefined.yml",
    "kind: EvalCase\nschemaVersion: 1\nid: rate-undefined\ntype: bug\nbase: main~1\nhead: main\nexpected:\n  - { file: src/pay.ts, line: 3, lens: logic }\n",
  );
  await repo.write(
    "docs/metator/evals/golden/clean-docs.yml",
    "kind: EvalCase\nschemaVersion: 1\nid: clean-docs\ntype: clean\nbase: main~1\nhead: main\n",
  );
  // A stand-in for `copilot -p … --agent mt-pr-review`: finds the bug in every case (a false block on the clean one).
  await repo.write(
    "fake-review.sh",
    `#!/bin/sh\nmkdir -p "$2/findings"\necho '${JSON.stringify({ kind: "FindingSet", schemaVersion: 1, lens: "merged", findings: [finding(3)] })}' > "$2/findings/merged.json"\n` +
      `echo '{"kind":"Verdict","schemaVersion":1,"decision":"CHANGES_REQUIRED","blocking":[],"unverified":[],"consider":[],"verifiedCorrect":[]}' > "$2/verdict.json"\n`,
  );
  await chmod(repo.path("fake-review.sh"), 0o755);
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator eval", () => {
  test("run executes the reviewer per case and repeat, then scores precision, recall and false blocks", async () => {
    const r = await metator(
      [
        "eval",
        "run",
        "--command",
        "./fake-review.sh {case} {out}",
        "--repeat",
        "2",
        "--runs-dir",
        ".metator/evals/after",
      ],
      repo.root,
    );
    expect(r.code).toBe(0);
    expect(data(r)).toMatchObject({ cases: 2, runs: 4, missing: [] });
    expect(data(r).totals).toEqual({
      precision: 0.5,
      recall: 1,
      blockingPrecision: 0.5,
      falseBlocks: 2,
      decisionVariance: 0,
    });
    expect((data(r).executions as Data[]).map((e) => `${e.case}/${e.run}:${e.exitCode}`)).toEqual([
      "clean-docs/1:0",
      "clean-docs/2:0",
      "rate-undefined/1:0",
      "rate-undefined/2:0",
    ]);
    expect((await findUnversioned(repo.root, [".metator/evals"])).unversioned).toEqual([]);
  });

  test("compare gates a regression; score works on its own", async () => {
    await metator(
      [
        "eval",
        "run",
        "--command",
        "./fake-review.sh {case} {out}",
        "--repeat",
        "1",
        "--runs-dir",
        ".metator/evals/after",
      ],
      repo.root,
    );
    const before = JSON.parse(await repo.read(".metator/evals/after/report.json"));
    before.totals = { ...before.totals, precision: 0.9, falseBlocks: 0 };
    await repo.write(".metator/evals/before.json", JSON.stringify(before));
    const gate = await metator(
      ["eval", "compare", ".metator/evals/before.json", ".metator/evals/after/report.json"],
      repo.root,
    );
    expect(gate.code).toBe(1);
    expect((gate.json.error as Data).message).toContain("precision 0.9 → 0.5");
    expect(
      (
        await metator(
          ["eval", "compare", ".metator/evals/after/report.json", ".metator/evals/after/report.json"],
          repo.root,
        )
      ).code,
    ).toBe(0);
    expect(data(await metator(["eval", "score", ".metator/evals/after"], repo.root)).cases).toBe(2);
  });

  test("a shell pipeline in the command is a usage error; --command is required", async () => {
    expect(
      (await metator(["eval", "run", "--command", "./fake-review.sh {case} | tee x"], repo.root)).code,
    ).toBe(64);
    expect((await metator(["eval", "run"], repo.root)).code).toBe(64);
  });
});

describe("metator eval seed (real git history)", () => {
  test("mutants become seeded cases with patches, a fix's culprit a bug case, an ordinary commit a clean case; run materializes the patch", async () => {
    const r = await ScratchRepo.create();
    try {
      await r.write("README.md", "# shop\n");
      await r.commit("init");
      await r.write(
        "src/invoice.ts",
        "export function round2(n: number) {\n  return Math.round(n * 100) / 100;\n}\n",
      );
      await r.commit("Round to cents");
      await r.write(
        "src/invoice.ts",
        "export function round2(n: number) {\n  const s = n < 0 ? -1 : 1;\n  return (s * Math.round(Math.abs(n) * 100)) / 100;\n}\n",
      );
      await r.commit("Fix rounding of negatives");
      await r.write("src/discount.ts", "export const discount = 0.1;\n");
      await r.commit("Add the discount");
      await r.write(
        "mutants.json",
        JSON.stringify([
          { file: "src/invoice.ts", from: "/ 100", to: "/ 10", why: "cents, not tenths" },
          { file: "src/invoice.ts", from: "n < 0", to: "n <= 0", why: "zero is positive" },
        ]),
      );
      await r.write(
        "fake-review.sh",
        `#!/bin/sh\nmkdir -p "$3/findings"\n` +
          `git -C "$(pwd)" show --format= "$2" > "$3/head.diff"\n` +
          `echo '{"kind":"FindingSet","schemaVersion":1,"lens":"merged","findings":[]}' > "$3/findings/merged.json"\n` +
          `echo '{"kind":"Verdict","schemaVersion":1,"decision":"APPROVE","blocking":[],"unverified":[],"consider":[],"verifiedCorrect":[]}' > "$3/verdict.json"\n`,
      );
      await chmod(r.path("fake-review.sh"), 0o755);
      const seeded = await metator(
        ["eval", "seed", "--mutants", "mutants.json", "--seeded", "5", "--bugs", "3", "--clean", "3"],
        r.root,
      );
      expect(seeded.code).toBe(0);
      const written = (data(seeded).written as { id: string; type: string }[]).map(
        (w) => `${w.type}:${w.id.replace(/-[0-9a-f]{10}$/, "")}`,
      );
      expect(written).toEqual([
        "seeded:seeded-src-invoice-1",
        "seeded:seeded-src-invoice-2",
        "bug:bug",
        "clean:clean",
      ]);
      const list = data(await metator(["eval", "list"], r.root)) as {
        byType: Record<string, number>;
        cases: { patch?: string }[];
      };
      expect(list.byType).toEqual({ seeded: 2, bug: 1, clean: 1 });
      expect(list.cases.filter((c) => c.patch)).toHaveLength(2);
      // The seeded case's patch is committed on the base in a worktree: the review sees a real diff.
      const run = await metator(
        [
          "eval",
          "run",
          "--command",
          "./fake-review.sh {case} {head} {out}",
          "--repeat",
          "1",
          "--runs-dir",
          ".metator/evals/seeded",
        ],
        r.root,
      );
      expect(run.code).toBe(0);
      expect(data(run)).toMatchObject({ cases: 4, runs: 4, missing: [] });
      expect(await r.read(".metator/evals/seeded/seeded-src-invoice-1/1/head.diff")).toContain(") / 10;");
      expect((await r.git("worktree", "list")).split("\n").filter((l) => l !== "")).toHaveLength(1);
    } finally {
      await r.dispose();
    }
  }, 60_000);
});
