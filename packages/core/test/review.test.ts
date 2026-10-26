import { describe, expect, test } from "bun:test";
import { FakeVcs, InMemoryFileSystem } from "@metator/testing";
import { stringify } from "yaml";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { FormatReviewComments, JudgeFindings, PlanReview } from "../src/application/review.ts";
import { RuleCatalog } from "../src/application/rules.ts";
import { type Finding, FindingSetDocument } from "../src/domain/finding.ts";
import { ok } from "../src/domain/result.ts";
import { shardFiles } from "../src/domain/review-plan.ts";
import { judge, toComments } from "../src/domain/verdict.ts";

const f = (id: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  lens: "logic",
  severity: "major",
  confidence: 0.8,
  location: { file: "src/pay.ts", line: 3 },
  quote: "return amount * rate;",
  claim: `claim of ${id} that is long enough`,
  ...extra,
});
const confirmed = { status: "confirmed" as const, by: "mt-verifier", evidence: "failing test" };
const BLOCKER = {
  severity: "blocking" as const,
  trigger: "t",
  reachability: "r",
  evidence: { type: "test" as const, ref: "x" },
};

describe("judge", () => {
  test("only confirmed blockers block", () => {
    const v = judge([f("LOGIC-001", { ...BLOCKER, verification: confirmed }), f("LOGIC-002")]);
    expect([v.decision, v.blocking.map((x) => x.id), v.consider.map((x) => x.id)]).toEqual([
      "CHANGES_REQUIRED",
      ["LOGIC-001"],
      ["LOGIC-002"],
    ]);
  });

  test("an unverified blocker means not decided; refuted findings disappear; unproven never blocks", () => {
    expect(judge([f("LOGIC-001", BLOCKER)]).decision).toBe("NEEDS_VERIFICATION");
    const v = judge([
      f("LOGIC-001", { ...BLOCKER, verification: { ...confirmed, status: "refuted" } }),
      f("LOGIC-002", { ...BLOCKER, verification: { ...confirmed, status: "unproven" } }),
    ]);
    expect([v.decision, v.consider.map((x) => x.id)]).toEqual(["APPROVED", ["LOGIC-002"]]);
  });
});

describe("toComments", () => {
  const verdict = judge(
    [
      f("LOGIC-001", { ...BLOCKER, verification: confirmed, fixHint: "define rate", ruleId: "MT-CODE-001" }),
      f("TESTS-001", { lens: "tests" }),
    ],
    ["rounding"],
  );

  test("inline comments only for confirmed blockers; the rest is in the summary", () => {
    const labeled = toComments(verdict, "labeled");
    expect(labeled.comments).toEqual([
      {
        path: "src/pay.ts",
        line: 3,
        body: "**[blocking] LOGIC-001** (MT-CODE-001): claim of LOGIC-001 that is long enough\n\nTrigger: t. Reached via r.\n\nSuggested fix: define rate",
      },
    ]);
    expect(labeled.summary).toContain("**CHANGES REQUIRED**");
    expect(labeled.summary).toContain("- [major] TESTS-001: src/pay.ts:3 claim of TESTS-001");
    expect(labeled.summary).toContain("Verified correct:\n- rounding");
  });

  test("author flow: no comments on one's own PR, the blockers as a fix list instead", () => {
    const author = toComments(verdict, "labeled", "author");
    expect(author.comments).toEqual([]);
    expect(author.summary).toContain(
      "Blocking (1), to fix with the mt-self-review workflow:\n- [blocking] LOGIC-001: src/pay.ts:3 claim of LOGIC-001",
    );
    expect(author.summary).not.toContain("commented inline");
    expect(toComments(verdict, "labeled", "reviewer").summary).toContain("Blocking (1), commented inline.");
  });

  test("natural comments read like prose", () => {
    expect(toComments(verdict, "natural").comments[0]?.body).toBe(
      "claim of LOGIC-001 that is long enough (MT-CODE-001). Trigger: t. Reached via r.\n\nSuggested fix: define rate",
    );
  });
});

describe("shardFiles", () => {
  test("one shard per package, chunked; files outside packages go to the root shard", () => {
    const shards = shardFiles(
      ["packages/a/src/1.ts", "packages/a/src/2.ts", "packages/a/src/3.ts", "README.md"],
      [{ name: "@acme/a", dir: "packages/a" }],
      2,
    );
    expect(shards).toEqual([
      { id: "root", package: "(root)", files: ["README.md"] },
      { id: "acme-a-1", package: "@acme/a", files: ["packages/a/src/1.ts", "packages/a/src/2.ts"] },
      { id: "acme-a-2", package: "@acme/a", files: ["packages/a/src/3.ts"] },
    ]);
  });
});

describe("PlanReview", () => {
  test("changed files without deleted or ignored ones; card and rules per shard; tasks = shards × lenses", async () => {
    const rules = stringify({
      kind: "RuleSet",
      schemaVersion: 1,
      area: "TS",
      rules: [
        {
          id: "MT-TS-001",
          title: "A rule for package a",
          applyTo: ["packages/a/**"],
          enforcement: "E3",
          summary: "Something reviewers check in package a.",
          rationale: "README.md",
          source: { ref: "README.md", verified: "2026-10-26" },
        },
      ],
    });
    const fs = new InMemoryFileSystem({
      "README.md": "",
      "docs/metator/rules/ts.yml": rules,
      "docs/metator/modules/acme-a.card.md": "card",
      "packages/a/src/x.ts": "",
      "packages/a/dist/x.js": "",
    });
    const vcs = new FakeVcs([], ["packages/a/src/x.ts", "packages/a/src/deleted.ts", "packages/a/dist/x.js"]);
    const workspace = { packages: async () => ok([{ name: "@acme/a", dir: "packages/a" }]) };
    const plan = (
      await new PlanReview(vcs, workspace, new RuleCatalog(fs, DEFAULT_PATHS), fs, DEFAULT_PATHS, [
        "**/dist/**",
      ]).execute({
        base: "main",
        lenses: ["logic", "tests"],
        maxFiles: 15,
        out: ".metator/review-plan.json",
      })
    )._unsafeUnwrap();
    expect(plan).toEqual({
      files: ["packages/a/src/x.ts"],
      lenses: ["logic", "tests"],
      shards: [
        {
          id: "acme-a",
          package: "@acme/a",
          files: ["packages/a/src/x.ts"],
          card: "docs/metator/modules/acme-a.card.md",
          rules: ["MT-TS-001"],
        },
      ],
      tasks: 2,
    });
    expect(JSON.parse((await fs.read(".metator/review-plan.json"))._unsafeUnwrap()).kind).toBe("ReviewPlan");
  });
});

describe("JudgeFindings / FormatReviewComments", () => {
  test("verdict next to the findings dir; comments refuse an undecided verdict", async () => {
    const fs = new InMemoryFileSystem({
      "run/findings/merged.json": JSON.stringify(
        FindingSetDocument.stamp({ lens: "merged", findings: [f("LOGIC-001", BLOCKER)] }),
      ),
    });
    const v = (
      await new JudgeFindings(fs).execute({ dir: "run/findings", verifiedCorrect: [] })
    )._unsafeUnwrap();
    expect([v.decision, v.output]).toEqual(["NEEDS_VERIFICATION", "run/verdict.json"]);
    expect(
      (
        await new FormatReviewComments(fs).execute({ verdict: "run/verdict.json", format: "labeled" })
      )._unsafeUnwrapErr().code,
    ).toBe("USAGE");
    expect(
      (
        await new JudgeFindings(new InMemoryFileSystem({})).execute({ dir: "x", verifiedCorrect: [] })
      )._unsafeUnwrapErr().hint,
    ).toContain("findings merge");
  });
});
