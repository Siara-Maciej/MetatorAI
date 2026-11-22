import { describe, expect, test } from "bun:test";
import type { ReviewCardView, ReviewStatus } from "../src/api.ts";
import {
  actionBody,
  countsText,
  FINDING_STATES,
  findingBadge,
  findingPlace,
  initialChecked,
  isNo,
  isPublishGate,
  isReviewCard,
  type MineLike,
  mineLine,
  mineWord,
  newsText,
  reviewCardKey,
  reviewGlyph,
  reviewNeeds,
  reviewTone,
  sendLabel,
  sendSelection,
  startedRoute,
  watchEnded,
  watchedLine,
  watchedWord,
} from "../src/reviews.ts";

const NONE = { open: 0, fixed: 0, notFixed: 0, disputed: 0, outdated: 0 };
const mine = (extra: Partial<MineLike> = {}): MineLike => ({ threads: [], ...extra });
const card = (extra: Partial<ReviewCardView> = {}): ReviewCardView => ({
  id: "requested:github-acme-shop-45",
  kind: "requested",
  review: "github-acme-shop-45",
  number: 45,
  title: "Cap the discount",
  url: "https://github.com/acme/shop/pull/45",
  prompt: "You were asked to review MR #45: Cap the discount",
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
  ...extra,
});

describe("a finding's badge", () => {
  test("each state has its words and its own tone; not-fixed reads with a space", () => {
    expect(FINDING_STATES.map((s) => findingBadge(s))).toEqual([
      { text: "open", tone: "amber" },
      { text: "fixed", tone: "green" },
      { text: "not fixed", tone: "red" },
      { text: "disputed", tone: "violet" },
      { text: "outdated", tone: "faint" },
    ]);
  });

  test("its place is the file and line, the file alone, or nothing for a general finding", () => {
    expect(findingPlace({ file: "src/a.ts", line: 12 })).toBe("src/a.ts:12");
    expect(findingPlace({ file: "src/a.ts" })).toBe("src/a.ts");
    expect(findingPlace({})).toBeUndefined();
  });

  test("the counts read the states that have findings, in the states' order", () => {
    expect(countsText({ ...NONE, open: 1, notFixed: 2, outdated: 1 })).toBe(
      "1 open · 2 not fixed · 1 outdated",
    );
    expect(countsText({ ...NONE, fixed: 3, disputed: 1 })).toBe("3 fixed · 1 disputed");
    expect(countsText(NONE)).toBeUndefined();
  });
});

describe("a watched MR's row", () => {
  test("what is new reads commits first, then replies, each counted", () => {
    expect(newsText({ commits: 2, replies: 1 })).toBe("2 new commits, 1 reply");
    expect(newsText({ commits: 1, replies: 0 })).toBe("1 new commit");
    expect(newsText({ commits: 0, replies: 3 })).toBe("3 replies");
    expect(newsText({ commits: 0, replies: 0 })).toBeUndefined();
    expect(newsText(undefined)).toBeUndefined();
  });

  test("one word per status, the daemon's", () => {
    const all: ReviewStatus[] = [
      "requested",
      "reviewing",
      "ready",
      "published",
      "changed",
      "fixed",
      "approved",
      "merged",
      "closed",
      "unwatched",
    ];
    expect(all.map(watchedWord)).toEqual([
      "asked",
      "reviewing",
      "to publish",
      "watching",
      "changed",
      "all fixed",
      "approved",
      "merged",
      "closed",
      "stopped",
    ]);
  });

  test("watching ended once approved, merged, closed or stopped; not while it changes or waits", () => {
    const ended: ReviewStatus[] = ["approved", "merged", "closed", "unwatched"];
    const going: ReviewStatus[] = ["requested", "reviewing", "ready", "published", "changed", "fixed"];
    expect(ended.every(watchEnded)).toBe(true);
    expect(going.some(watchEnded)).toBe(false);
  });

  test("its line is what is new, else its findings by state, never an id or a host", () => {
    expect(
      watchedLine({ status: "changed", news: { commits: 2, replies: 1 }, counts: { ...NONE, open: 1 } }),
    ).toBe("2 new commits, 1 reply");
    expect(watchedLine({ status: "published", counts: { ...NONE, open: 1, notFixed: 2 } })).toBe(
      "1 open · 2 not fixed",
    );
    // An ended MR says how its findings stood, not what came after.
    expect(
      watchedLine({ status: "merged", news: { commits: 1, replies: 0 }, counts: { ...NONE, fixed: 2 } }),
    ).toBe("2 fixed");
    expect(watchedLine({ status: "requested", counts: NONE })).toBe("not reviewed yet");
    expect(watchedLine({ status: "published", counts: NONE })).toBe("no findings");
  });

  test("a word that waits for the person is amber, work violet, an approval green, the rest faint", () => {
    for (const w of ["asked", "to publish", "changed", "all fixed", "new review", "replies ready"] as const)
      expect(reviewTone(w)).toBe("amber");
    expect(reviewTone("reviewing")).toBe("violet");
    expect(reviewTone("approved")).toBe("green");
    expect(reviewTone("done")).toBe("green");
    for (const w of ["watching", "merged", "closed", "stopped", "open"] as const)
      expect(reviewTone(w)).toBe("faint");
  });

  test("a row's glyph is the first level's: waiting needs you, work works, an approval is done", () => {
    expect(reviewGlyph("changed")).toBe("needs you");
    expect(reviewGlyph("reviewing")).toBe("working");
    expect(reviewGlyph("approved")).toBe("done");
    expect(reviewGlyph("watching")).toBeUndefined();
  });
});

describe("my MR's row", () => {
  const proposed = { id: "T1", state: "open", reply: "Cents." };
  test("one word: new review, replies ready, open, done", () => {
    expect(mineWord(mine({ fresh: 2, threads: [proposed] }))).toBe("new review");
    expect(mineWord(mine({ fresh: 0, threads: [proposed] }))).toBe("replies ready");
    expect(mineWord(mine({ threads: [{ id: "T1", state: "open" }] }))).toBe("open");
    expect(mineWord(mine({ threads: [{ id: "T1", state: "resolved" }] }))).toBe("done");
    // A reply already sent is not one to send.
    expect(
      mineWord(mine({ threads: [{ ...proposed, state: "answered", repliedAt: "2026-11-22T10:00:00Z" }] })),
    ).toBe("done");
  });

  test("its line counts the open threads and the replies to send", () => {
    expect(mineLine(mine({ threads: [proposed, { id: "T2", state: "open" }] }))).toBe(
      "2 open · 1 reply to send",
    );
    expect(mineLine(mine({ threads: [{ id: "T2", state: "resolved" }] }))).toBe("0 open");
  });
});

describe("Send selected", () => {
  const threads = [
    { id: "T1", state: "open", reply: "Cents." },
    { id: "T2", state: "open", reply: "Renamed." },
    { id: "T3", state: "open" },
    { id: "T4", state: "answered", reply: "Done.", repliedAt: "2026-11-22T10:00:00Z" },
    { id: "T5", state: "open", reply: "" },
  ];

  test("every reply that waits is checked at first; a sent one, an empty one or none is not", () => {
    expect([...initialChecked(threads)]).toEqual(["T1", "T2"]);
  });

  test("sends only the checked replies, named one by one", () => {
    expect(sendSelection(threads, new Set(["T1", "T2"]))).toEqual({ only: ["T1", "T2"] });
    expect(sendSelection(threads, new Set(["T2"]))).toEqual({ only: ["T2"] });
    expect(sendLabel(sendSelection(threads, new Set(["T2"])))).toBe("Send selected (1)");
  });

  test("a checked thread with nothing to send is not sent; nothing checked sends nothing", () => {
    expect(sendSelection(threads, new Set(["T3", "T4", "T5"]))).toBeUndefined();
    expect(sendSelection(threads, new Set())).toBeUndefined();
    expect(sendLabel(undefined)).toBe("Send selected (0)");
  });
});

describe("the cards on Home", () => {
  test("each daemon card is a row of the queue with its own address, its prompt as the title", () => {
    const rows = reviewNeeds([
      card(),
      card({ id: "approve:github-acme-shop-46", kind: "approve", repo: "shop" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual([
      "review/requested:github-acme-shop-45",
      "review/shop/approve:github-acme-shop-46",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "review",
      title: "You were asked to review MR #45: Cap the discount",
      sub: "Cap the discount",
      runId: "",
      hint: "Review · No",
    });
    expect(rows[0] && isReviewCard(rows[0])).toBe(true);
    expect(isReviewCard({ kind: "question" })).toBe(false);
    expect(reviewCardKey({ id: "mine:x" })).toBe("review/mine:x");
  });

  test("a button sends the daemon's body with the person's name; No is the card's decline", () => {
    const [review, no] = card().actions;
    expect(review && actionBody(review, "ana")).toEqual({
      url: "https://github.com/acme/shop/pull/45",
      by: "ana",
    });
    expect(actionBody({}, "ana")).toEqual({ by: "ana" });
    expect(no && isNo(no)).toBe(true);
    expect(review && isNo(review)).toBe(false);
  });

  test("the publish card is the review run's approval gate, known by its words", () => {
    const prompt = "Publish the review of MR #45? (3 inline comments, 1 general)";
    expect(isPublishGate({ source: "gate", prompt })).toBe(true);
    expect(isPublishGate({ source: "agent", prompt })).toBe(false);
    expect(isPublishGate({ source: "gate", prompt: "Approve the plan?" })).toBe(false);
    expect(isPublishGate({ source: "gate", prompt: `Note: ${prompt}` })).toBe(false);
  });

  test("a started agent's terminal: its run's pane, its pane alone, or nothing to show", () => {
    expect(startedRoute({ runId: "r1", session: { paneId: "w1:p2" } })).toEqual({
      screen: "run",
      runId: "r1",
      tab: "terminal",
      pane: "w1:p2",
    });
    expect(startedRoute({ pane: { id: "w1:p3" } })).toEqual({ screen: "grid", pane: "w1:p3" });
    expect(startedRoute({ pane: { id: "w1:p3", runId: "r2" } })).toEqual({
      screen: "run",
      runId: "r2",
      tab: "terminal",
      pane: "w1:p3",
    });
    expect(startedRoute({ runId: "r3" })).toEqual({ screen: "run", runId: "r3", tab: "terminal" });
    expect(startedRoute(undefined)).toBeUndefined();
  });
});
