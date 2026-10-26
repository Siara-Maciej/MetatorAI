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
