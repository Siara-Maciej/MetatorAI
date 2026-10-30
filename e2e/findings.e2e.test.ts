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

  test("review plan shards the branch; verdict and comments follow verification", async () => {
    await repo.git("checkout", "-q", "-b", "review");
    await repo.write("src/pay.ts", `${CODE}export const fee = 1;\n`);
    try {
      const plan = await metator(
        [
          "review",
          "plan",
          "--base",
          "main",
          "--lenses",
          "logic",
          "tests",
          "--out",
          ".metator/runs/r1/review-plan.json",
        ],
        repo.root,
      );
      expect(data(plan)).toMatchObject({ files: ["src/pay.ts"], lenses: ["logic", "tests"], tasks: 2 });
      // pr.json from git: the branch, its commits and authors, uncommitted work.
      await repo.git("add", "src/pay.ts");
      await repo.git("-c", "user.name=Ann", "-c", "user.email=ann@x", "commit", "-q", "-m", "Add a fee");
      await repo.write("src/pay.ts", `${CODE}export const fee = 2;\n`);
      const meta = await metator(
        ["review", "metadata", "--base", "main", "--out", ".metator/runs/r1/pr.json"],
        repo.root,
      );
      expect(data(meta)).toMatchObject({
        branch: "review",
        commits: [{ author: "Ann", email: "ann@x", subject: "Add a fee" }],
        authors: [{ name: "Ann", commits: 1 }],
        files: ["src/pay.ts"],
        uncommitted: true,
      });
      expect(JSON.parse(await repo.read(".metator/runs/r1/pr.json")).kind).toBe("ReviewMetadata");
      expect((await metator(["review", "plan", "--lenses", "style"], repo.root)).code).toBe(64);

      const blocker = finding("LOGIC-001", "logic", {
        severity: "blocking",
        trigger: "any positive amount",
        reachability: "checkout → pay",
        evidence: { type: "test", ref: "pay(10) throws" },
      });
      await repo.write(`${DIR}/logic.json`, set("logic", [blocker]));
      await Bun.file(repo.path(`${DIR}/contracts.json`)).delete();
      await metator(["findings", "merge", DIR], repo.root);
      const undecided = await metator(["findings", "verdict", DIR], repo.root);
      expect([data(undecided).decision, data(undecided).output]).toEqual([
        "NEEDS_VERIFICATION",
        ".metator/runs/r1/verdict.json",
      ]);
      expect(
        (await metator(["findings", "to-github", ".metator/runs/r1/verdict.json"], repo.root)).code,
      ).toBe(64);

      const merged = JSON.parse(await repo.read(`${DIR}/merged.json`));
      merged.findings[0].verification = {
        status: "confirmed",
        by: "mt-verifier",
        evidence: "pay(10) throws in a temporary test",
      };
      await repo.write(`${DIR}/merged.json`, JSON.stringify(merged));
      const decided = await metator(
        ["findings", "verdict", DIR, "--verified-correct", "negative amounts"],
        repo.root,
      );
      expect(data(decided).decision).toBe("CHANGES_REQUIRED");
      const comments = await metator(
        ["findings", "to-github", ".metator/runs/r1/verdict.json", "--format", "natural"],
        repo.root,
      );
      expect((data(comments).comments as Data[]).map((c) => [c.path, c.line])).toEqual([["src/pay.ts", 3]]);
      expect(data(comments).summary).toContain("Verified correct:\n- negative amounts");
      // Author flow: the same verdict on one's own PR is a fix list, never comments.
      const own = await metator(
        ["findings", "to-github", ".metator/runs/r1/verdict.json", "--role", "author"],
        repo.root,
      );
      expect([data(own).comments, String(data(own).summary).includes("mt-self-review")]).toEqual([[], true]);
    } finally {
      await repo.git("checkout", "-q", "--", "src/pay.ts");
      await repo.git("checkout", "-q", "main");
    }
  }, 30_000); // several real processes

  test("schema prints the FindingSet JSON Schema; a missing dir argument is a usage error", async () => {
    expect(
      ((data(await metator(["findings", "schema"], repo.root)).properties as Data).kind as Data).const,
    ).toBe("FindingSet");
    expect((await metator(["findings", "validate"], repo.root)).code).toBe(64);
  });
});
