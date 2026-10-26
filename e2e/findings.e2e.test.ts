/** Review findings end to end: the real `metator` process checks findings against real code. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const details = (r: { json: Record<string, unknown> }) => (r.json.error as { details: Data }).details;

const CODE =
  "export function pay(amount: number) {\n  if (amount < 0) return 0;\n  return amount * rate;\n}\n";
const finding = (id: string, lens: string, extra: Data = {}) => ({
  id,
  lens,
  severity: "major",
  confidence: 0.7,
  location: { file: "src/pay.ts", line: 3, symbol: "pay" },
  quote: "return amount * rate;",
  claim: "rate is never defined, so pay throws a ReferenceError",
  ...extra,
});
const set = (lens: string, findings: Data[]) =>
  JSON.stringify({ kind: "FindingSet", schemaVersion: 1, lens, findings });
const DIR = ".metator/runs/r1/findings";

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("src/pay.ts", CODE);
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator findings", () => {
  test("a hallucinated quote and a bare blocker are invalid; real ones pass", async () => {
    await repo.write(
      `${DIR}/logic.json`,
      set("logic", [
        finding("LOGIC-001", "logic"),
        finding("LOGIC-002", "logic", { quote: "return amount * taxRate;" }),
      ]),
    );
    await repo.write(
      `${DIR}/security.json`,
      set("security", [
        finding("SECURITY-001", "security", {
          severity: "blocking",
          claim: "unchecked input reaches the rate lookup",
        }),
      ]),
    );
    const r = await metator(["findings", "validate", DIR], repo.root);
    expect(r.code).toBe(1);
    expect((details(r).findings as Data[]).map((f) => [f.id, f.status])).toEqual([
      ["LOGIC-001", "valid"],
      ["LOGIC-002", "invalid"],
      ["SECURITY-001", "invalid"],
    ]);
  });

  test("code moves under a finding: validate reports it, --fix rewrites the line", async () => {
    await repo.write(`${DIR}/logic.json`, set("logic", [finding("LOGIC-001", "logic")]));
    await Bun.file(repo.path(`${DIR}/security.json`)).delete();
    await repo.write("src/pay.ts", `// header\n${CODE}`);
    try {
      expect((details(await metator(["findings", "validate", DIR], repo.root)).counts as Data).moved).toBe(1);
      expect(
        (data(await metator(["findings", "validate", DIR, "--fix"], repo.root)).counts as Data).fixed,
      ).toBe(1);
      expect(JSON.parse(await repo.read(`${DIR}/logic.json`)).findings[0].location.line).toBe(4);
    } finally {
      await repo.write("src/pay.ts", CODE);
    }
  });

  test("merge keeps one finding per root cause across lenses and drops invalid ones", async () => {
    await repo.write(
      `${DIR}/logic.json`,
      set("logic", [finding("LOGIC-001", "logic"), finding("LOGIC-002", "logic", { quote: "nope" })]),
    );
    await repo.write(
      `${DIR}/contracts.json`,
      set("contracts", [
        finding("CONTRACTS-001", "contracts", {
          severity: "minor",
          claim: "pay throws a ReferenceError: rate is never defined",
        }),
      ]),
    );
    const r = await metator(["findings", "merge", DIR], repo.root);
    expect(data(r)).toEqual({
      input: 3,
      dropped: ["LOGIC-002"],
      duplicates: 1,
      merged: 1,
      output: `${DIR}/merged.json`,
    });
    const merged = JSON.parse(await repo.read(`${DIR}/merged.json`));
    expect(merged.findings.map((f: Data) => [f.id, f.alsoFrom])).toEqual([["LOGIC-001", ["contracts"]]]);
    expect((await findUnversioned(repo.root, [".metator"])).unversioned).toEqual([]);
  });

  test("schema prints the FindingSet JSON Schema; a missing dir argument is a usage error", async () => {
    expect(
      ((data(await metator(["findings", "schema"], repo.root)).properties as Data).kind as Data).const,
    ).toBe("FindingSet");
    expect((await metator(["findings", "validate"], repo.root)).code).toBe(64);
  });
});
