import { describe, expect, test } from "bun:test";
import { selectThreads } from "../src/domain/review-thread.ts";
import {
  allFixed,
  deltaDiff,
  findingCounts,
  holdsHunk,
  hunkAt,
  mineCard,
  newsOf,
  newsPrompt,
  prePass,
  publishPrompt,
  reviewStatus,
  type WatchedReview,
  WatchedReviewDocument,
  watchedCard,
} from "../src/domain/watched-review.ts";

const DIFF = [
  "diff --git a/src/cap.ts b/src/cap.ts",
  "--- a/src/cap.ts",
  "+++ b/src/cap.ts",
  "@@ -1,2 +1,3 @@",
  " export const cap = 1;",
  "+export const max = 100;",
  " export const min = 0;",
  "diff --git a/src/tax.ts b/src/tax.ts",
  "--- a/src/tax.ts",
  "+++ b/src/tax.ts",
  "@@ -5,1 +5,1 @@",
  "-export const tax = 0.2;",
  "+export const tax = 0.23;",
  "",
].join("\n");
const AFTER = DIFF.replace("max = 100", "max = 1000");

const AT = "2026-11-22T10:00:00.000Z";
const review = (extra: Partial<WatchedReview> = {}): WatchedReview => ({
  id: "github-acme-shop-45",
  url: "https://github.com/acme/shop/pull/45",
  codehost: "github",
  host: "github.com",
  repo: "acme/shop",
  number: 45,
  title: "Cap",
  author: "ola",
  base: "main",
  head: "feat",
  headSha: "h1",
  state: "open",
  why: "reviewed",
  runs: ["r1"],
  reviewedSha: "h1",
  comments: [
    { hostId: "101", threadId: "T1", findingId: "f1", file: "src/cap.ts", line: 2, replies: 0, at: AT },
  ],
  findings: [
    {
      id: "f1",
      file: "src/cap.ts",
      line: 2,
      text: "max has no unit",
      severity: "blocking",
      state: "open",
      hunk: "export const cap = 1;\nexport const max = 100;\nexport const min = 0;",
      at: AT,
    },
    { id: "f2", file: "src/tax.ts", line: 5, text: "rate", severity: "minor", state: "open", at: AT },
  ],
  dismissed: [],
  watch: { active: true },
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});
const detail = (extra: object = {}) => ({
  author: "ola",
  headSha: "h1",
  diff: DIFF,
  threads: [{ id: "T1", author: "me", body: "max has no unit", resolved: false }],
  ...extra,
});

describe("WatchedReview v1", () => {
  test("stamps and parses; a finding has a state the agent sets", () => {
    const doc = WatchedReviewDocument.stamp(review());
    expect(WatchedReviewDocument.parse(doc, "x")._unsafeUnwrap().findings[0]?.state).toBe("open");
    expect(
      WatchedReviewDocument.parse(
        { ...doc, findings: [{ ...review().findings[0], state: "done" }] },
        "x",
      ).isErr(),
    ).toBe(true);
  });

  test("v2 records the published runs; a v1 file reads as v2 with none, and v1 never takes the field", () => {
    const doc = WatchedReviewDocument.stamp({ ...review(), publishedRuns: ["run-1"] });
    expect(doc.schemaVersion).toBe(2);
    expect(WatchedReviewDocument.parse(doc, "x")._unsafeUnwrap().publishedRuns).toEqual(["run-1"]);
    const v1 = { ...WatchedReviewDocument.stamp(review()), schemaVersion: 1 };
    expect(WatchedReviewDocument.parse(v1, "x")._unsafeUnwrap()).toEqual(review());
    expect(WatchedReviewDocument.parse({ ...doc, schemaVersion: 1 }, "x").isErr()).toBe(true);
  });
});

describe("hunks and the delta", () => {
  test("the hunk of a line, and whether a diff still holds it", () => {
    expect(hunkAt(DIFF, "src/cap.ts", 2)).toBe(
      "export const cap = 1;\nexport const max = 100;\nexport const min = 0;",
    );
    expect(hunkAt(DIFF, "src/cap.ts", 9)).toBeUndefined();
    expect(hunkAt(DIFF, "src/none.ts", 1)).toBeUndefined();
    const hunk = hunkAt(DIFF, "src/cap.ts", 2) as string;
    expect(holdsHunk(DIFF, "src/cap.ts", hunk)).toBe(true);
    expect(holdsHunk(AFTER, "src/cap.ts", hunk)).toBe(false);
  });

  test("the delta is the hunks the earlier diff did not have", () => {
    const delta = deltaDiff(DIFF, AFTER);
    expect(delta).toContain("+export const max = 1000;");
    expect(delta).not.toContain("src/tax.ts");
    expect(deltaDiff(DIFF, DIFF)).toBe("");
    expect(deltaDiff("", DIFF)).toContain("src/tax.ts");
  });
});

describe("the pre-pass and what is new", () => {
  test("a changed hunk, a resolved thread, an author's reply: candidates only, never a state", () => {
    expect(prePass(review(), detail()).map((f) => f.candidates)).toEqual([undefined, undefined]);
    const after = prePass(
      review(),
      detail({
        diff: AFTER,
        threads: [
          { id: "T1", author: "me", body: "x", resolved: true, replies: [{ author: "ola", body: "done" }] },
        ],
      }),
    );
    expect(after[0]).toMatchObject({ state: "open", candidates: ["changed", "resolved", "replied"] });
    // Someone else's reply is no answer of the author's.
    const other = prePass(
      review(),
      detail({
        threads: [
          { id: "T1", author: "me", body: "x", resolved: false, replies: [{ author: "ann", body: "+1" }] },
        ],
      }),
    );
    expect(other[0]?.candidates).toBeUndefined();
    // Old candidates are not kept once nothing points to them.
    expect(prePass(review({ findings: after }), detail())[0]?.candidates).toBeUndefined();
  });

  test("new commits after the reviewed head and the author's new replies", () => {
    expect(newsOf(review(), detail())).toEqual({ commits: 0, replies: 0 });
    expect(newsOf(review(), detail({ headSha: "h3", commits: ["h0", "h1", "h2", "h3"] }))).toEqual({
      commits: 2,
      replies: 0,
    });
    // The host did not list the reviewed head (a force push): one new commit at least.
    expect(newsOf(review(), detail({ headSha: "h9", commits: ["h9"] })).commits).toBe(1);
    expect(newsOf(review(), detail({ headSha: "h9" })).commits).toBe(1);
    const replied = detail({
      threads: [
        {
          id: "T1",
          author: "me",
          body: "x",
          resolved: false,
          replies: [
            { author: "ola", body: "a" },
            { author: "ann", body: "b" },
          ],
        },
      ],
    });
    expect(newsOf(review(), replied).replies).toBe(1);
    expect(
      newsOf(
        review({ comments: [{ ...review().comments[0], replies: 1 } as WatchedReview["comments"][0]] }),
        replied,
      ).replies,
    ).toBe(0);
  });
});

describe("words and cards", () => {
  test("the card texts", () => {
    expect(newsPrompt(45, { commits: 2, replies: 1 })).toBe("MR #45: 2 new commits, 1 reply");
    expect(newsPrompt(45, { commits: 1, replies: 0 })).toBe("MR #45: 1 new commit");
    expect(newsPrompt(45, { commits: 0, replies: 3 })).toBe("MR #45: 3 replies");
    expect(publishPrompt(45, 3, 1)).toBe("Publish the review of MR #45? (3 inline comments, 1 general)");
    expect(publishPrompt(undefined, 1, 0)).toBe("Publish the review? (1 inline comment, 0 general)");
  });

  test("all fixed: every finding fixed or outdated, at least one fixed", () => {
    expect(allFixed([{ state: "fixed" }, { state: "outdated" }])).toBe(true);
    expect(allFixed([{ state: "outdated" }])).toBe(false);
    expect(allFixed([])).toBe(false);
    expect(allFixed([{ state: "fixed" }, { state: "disputed" }])).toBe(false);
    expect(findingCounts([{ state: "fixed" }, { state: "not-fixed" }, { state: "open" }])).toEqual({
      open: 1,
      fixed: 1,
      notFixed: 1,
      disputed: 0,
      outdated: 0,
    });
  });

  test("one card per watched MR: asked to review, what is new, or approve; none while a run goes on or once waved away", () => {
    const asked = review({ runs: [], why: "requested", findings: [], comments: [] });
    expect(watchedCard(asked, false)).toEqual({
      id: "requested:github-acme-shop-45",
      kind: "requested",
      review: "github-acme-shop-45",
      number: 45,
      title: "Cap",
      url: "https://github.com/acme/shop/pull/45",
      prompt: "You were asked to review MR #45: Cap",
      actions: [
        {
          label: "Review",
          method: "POST",
          path: "/reviews",
          body: { url: "https://github.com/acme/shop/pull/45" },
        },
        {
          label: "No",
          method: "POST",
          path: "/reviews/github-acme-shop-45/dismiss",
          body: { card: "requested" },
        },
      ],
    });
    expect(watchedCard({ ...asked, why: "watched" }, false)).toBeUndefined();
    const news = review({ news: { commits: 2, replies: 1, headSha: "h3", at: AT } });
    expect(watchedCard(news, false)).toMatchObject({
      kind: "changed",
      prompt: "MR #45: 2 new commits, 1 reply",
    });
    expect(watchedCard(news, true)).toBeUndefined();
    const fixed = review({ findings: review().findings.map((f) => ({ ...f, state: "fixed" as const })) });
    expect(watchedCard(fixed, false)).toMatchObject({
      kind: "approve",
      prompt: "All 2 findings are fixed: approve MR #45?",
      actions: [{ label: "Yes", path: "/reviews/github-acme-shop-45/approve" }, { label: "No" }],
    });
    expect(
      watchedCard({ ...fixed, dismissed: [{ card: "approve", headSha: "h1", by: "ann", at: AT }] }, false),
    ).toBeUndefined();
    // Waved away at an older head: the card is back.
    expect(
      watchedCard({ ...fixed, dismissed: [{ card: "approve", headSha: "h0", by: "ann", at: AT }] }, false)
        ?.kind,
    ).toBe("approve");
    for (const ended of [
      { state: "merged" as const },
      { approved: { by: "a", at: AT } },
      { watch: { active: false } },
    ])
      expect(watchedCard({ ...fixed, ...ended }, false)).toBeUndefined();
    expect(watchedCard(review(), false)).toBeUndefined();
  });

  test("my MR's card: only threads nobody analysed, and no run answering", () => {
    const mine = { id: "github-acme-shop-45", number: 45, title: "Cap", fresh: 2, answering: false };
    expect(mineCard(mine)?.prompt).toBe("New review in MR #45 (2 threads)");
    expect(mineCard({ ...mine, fresh: 1 })?.prompt).toBe("New review in MR #45 (1 thread)");
    expect(mineCard({ ...mine, fresh: 0 })).toBeUndefined();
    expect(mineCard({ ...mine, answering: true })).toBeUndefined();
  });

  test("one state word for the list", () => {
    expect(reviewStatus(review(), { status: "active", stage: "find" })).toBe("reviewing");
    expect(reviewStatus(review(), { status: "active", stage: "approval" })).toBe("ready");
    expect(reviewStatus(review())).toBe("published");
    expect(reviewStatus(review({ news: { commits: 1, replies: 0, headSha: "h2", at: AT } }))).toBe("changed");
    expect(reviewStatus(review({ runs: [], why: "requested", comments: [] }))).toBe("requested");
    expect(reviewStatus(review({ state: "merged" }))).toBe("merged");
    expect(reviewStatus(review({ approved: { by: "a", at: AT } }))).toBe("approved");
    expect(reviewStatus(review({ watch: { active: false, ended: { why: "unwatched", at: AT } } }))).toBe(
      "unwatched",
    );
    expect(
      reviewStatus(review({ findings: review().findings.map((f) => ({ ...f, state: "fixed" as const })) })),
    ).toBe("fixed");
  });

  test("which threads a send covers", () => {
    expect(selectThreads(["t1", "t2", "t3"], {})).toEqual({ chosen: ["t1", "t2", "t3"] });
    expect(selectThreads(["t1", "t2", "t3"], { only: ["t3", "t1"] })).toEqual({ chosen: ["t1", "t3"] });
    expect(selectThreads(["t1", "t2", "t3"], { skip: ["t2"] })).toEqual({ chosen: ["t1", "t3"] });
    expect(selectThreads(["t1"], { only: ["t1"], skip: ["t1"] })).toEqual({
      problem: "say either --only or --skip, not both",
    });
    expect(selectThreads(["t1"], { skip: ["t7"] })).toEqual({ problem: "no thread t7 in this request" });
  });
});
