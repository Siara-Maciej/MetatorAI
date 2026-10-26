import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { MergeFindingSets, ValidateFindings } from "../src/application/findings.ts";
import { type Finding, FindingSetDocument, mergeFindings, policyProblems } from "../src/domain/finding.ts";

const CODE =
  "export function pay(amount: number) {\n  if (amount < 0) return 0;\n  return amount * rate;\n}\n";

const finding = (extra: Partial<Finding> = {}): Finding => ({
  id: "LOGIC-001",
  lens: "logic",
  severity: "major",
  confidence: 0.8,
  location: { file: "src/pay.ts", line: 3, symbol: "pay" },
  quote: "return amount * rate;",
  claim: "rate is never defined in this module, so pay throws a ReferenceError",
  ...extra,
});

const BLOCKING: Partial<Finding> = {
  severity: "blocking",
  trigger: "any positive amount",
  reachability: "checkout → invoice → pay",
  evidence: { type: "test", ref: "src/pay.test.ts: pay(10) throws" },
};

const setFile = (lens: Finding["lens"], findings: Finding[]) =>
  JSON.stringify(FindingSetDocument.stamp({ lens, findings }));

function world(files: Record<string, string>) {
  const fs = new InMemoryFileSystem({ "src/pay.ts": CODE, ...files });
  const validate = new ValidateFindings(fs);
  return { fs, validate, merge: new MergeFindingSets(fs, validate) };
}

describe("policyProblems", () => {
  test("blocking needs trigger, reachability and evidence; refuted cannot block; doc evidence cannot confirm a blocker", () => {
    expect(policyProblems(finding({ severity: "blocking" }))).toEqual([
      "blocking needs trigger",
      "blocking needs reachability",
      "blocking needs evidence",
    ]);
    expect(policyProblems(finding(BLOCKING))).toEqual([]);
    expect(
      policyProblems(
        finding({
          ...BLOCKING,
          verification: { status: "refuted", by: "mt-verifier", evidence: "guard above" },
        }),
      ),
    ).toEqual(["a refuted finding cannot block"]);
    expect(
      policyProblems(
        finding({
          ...BLOCKING,
          evidence: { type: "doc", ref: "spec" },
          verification: { status: "confirmed", by: "v", evidence: "x" },
        }),
      ),
    ).toEqual(["blocking needs executable evidence (test, trace or rule), not doc"]);
  });
});

describe("ValidateFindings", () => {
  test("a true quote is valid; an invented one, a missing file and a bare blocker are invalid", async () => {
    const w = world({
      "f/logic.json": setFile("logic", [
        finding(),
        finding({ id: "LOGIC-002", quote: "return amount * taxRate;" }),
        finding({ id: "LOGIC-003", location: { file: "src/gone.ts", line: 1 } }),
        finding({ id: "LOGIC-004", severity: "blocking" }),
      ]),
    });
    const report = (await w.validate.execute({ dir: "f", fix: false }))._unsafeUnwrap();
    expect(report.findings.map((v) => [v.id, v.status, v.reasons])).toEqual([
      ["LOGIC-001", "valid", []],
      ["LOGIC-002", "invalid", ["quote not found in src/pay.ts"]],
      ["LOGIC-003", "invalid", ["file not found: src/gone.ts"]],
      [
        "LOGIC-004",
        "invalid",
        ["blocking needs trigger", "blocking needs reachability", "blocking needs evidence"],
      ],
    ]);
  });

  test("a moved quote is reported, and --fix rewrites the line in the findings file", async () => {
    const w = world({
      "f/logic.json": setFile("logic", [finding({ location: { file: "src/pay.ts", line: 1 } })]),
    });
    expect((await w.validate.execute({ dir: "f", fix: false }))._unsafeUnwrap().findings[0]).toMatchObject({
      status: "moved",
      line: 3,
    });
    expect((await w.validate.execute({ dir: "f", fix: true }))._unsafeUnwrap().counts.fixed).toBe(1);
    expect((await w.validate.execute({ dir: "f", fix: false }))._unsafeUnwrap().counts.valid).toBe(1);
  });

  test("files that are not FindingSet documents are listed with the field, not thrown", async () => {
    const w = world({
      "f/x.json": JSON.stringify({
        kind: "FindingSet",
        schemaVersion: 1,
        lens: "logic",
        findings: [{ id: "bad" }],
      }),
    });
    const report = (await w.validate.execute({ dir: "f", fix: false }))._unsafeUnwrap();
    expect(report.unreadable[0]?.message).toContain("(at findings.0.");
  });
});

describe("mergeFindings / MergeFindingSets", () => {
  test("the same root cause from two lenses becomes one finding with the higher severity", () => {
    const { merged, duplicates } = mergeFindings([
      finding({ id: "LOGIC-001" }),
      finding({
        id: "CONTRACTS-003",
        lens: "contracts",
        ...BLOCKING,
        claim: "pay throws a ReferenceError because rate is never defined",
      }),
      finding({
        id: "TESTS-001",
        lens: "tests",
        location: { file: "src/pay.ts", line: 2, symbol: "check" },
        claim: "negative amounts have no test",
      }),
    ]);
    expect(duplicates).toBe(1);
    expect(merged.map((f) => [f.id, f.severity, f.alsoFrom])).toEqual([
      ["CONTRACTS-003", "blocking", ["logic"]],
      ["TESTS-001", "major", undefined],
    ]);
  });

  test("merge drops invalid findings and writes merged.json, which validate then ignores", async () => {
    const w = world({
      "f/logic.json": setFile("logic", [finding(), finding({ id: "LOGIC-009", quote: "nope" })]),
      "f/contracts.json": setFile("contracts", [finding({ id: "CONTRACTS-001", lens: "contracts" })]),
    });
    const report = (await w.merge.execute({ dir: "f" }))._unsafeUnwrap();
    expect(report).toEqual({
      input: 3,
      dropped: ["LOGIC-009"],
      duplicates: 1,
      merged: 1,
      output: "f/merged.json",
    });
    const merged = JSON.parse((await w.fs.read("f/merged.json"))._unsafeUnwrap());
    expect([merged.kind, merged.lens, merged.findings.length]).toEqual(["FindingSet", "merged", 1]);
    expect((await w.validate.execute({ dir: "f", fix: false }))._unsafeUnwrap().files).toBe(2);
  });
});
