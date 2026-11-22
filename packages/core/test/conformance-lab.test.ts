import { describe, expect, test } from "bun:test";
import {
  firstRunTrust,
  type JudgeContext,
  judgeConformance,
  type LabView,
  optionMatching,
  refusalOf,
  screenAfter,
  screenLine,
} from "../src/domain/conformance-lab.ts";

const SINCE = "2026-11-22T10:00:00.000Z";
const view = (over: Partial<LabView> = {}): LabView => ({
  pane: { id: "w1:p1", alive: true, state: "idle", sessionId: "0b6c3f5e-1111-4a2b-9c3d-123456789abc" },
  screen: "",
  questions: [],
  guard: [],
  consents: { kinds: [] },
  git: { commits: 2, subject: "setup" },
  files: {},
  ...over,
});
const ctx = (over: Partial<JudgeContext> = {}): JudgeContext => ({
  since: SINCE,
  commitsBefore: 2,
  prompts: [],
  ...over,
});

describe("where a check looks on the screen", () => {
  test("after the last showing of the words given, wrapped lines and all", () => {
    const screen =
      "❯ Reply with only the uppercase\n  form of this word: kavo\n● KAVO\n❯ Reply with only the uppercase form of this word: lumi\n● LUMI\n❯";
    expect(screenAfter(screen, "Reply with only the uppercase form of this word: lumi")).toBe("●LUMI❯");
    expect(screenAfter(screen, "words never given")).toContain("KAVO");
    expect(screenLine(screen, "LUMI")).toBe("● LUMI");
  });
});

describe("judgeConformance: each expectation through what MetatorAI observes", () => {
  test("screen: the uppercase answer after the words; not before them", () => {
    const words = "Reply with only the uppercase form of this word: kavo";
    const seen = view({ screen: `● KAVO\n❯ ${words}\n● Done.\n❯` });
    expect(judgeConformance({ screen: "KAVO" }, seen, ctx({ lastWords: words }))).toEqual({
      ok: false,
      evidence: expect.stringContaining('"KAVO" is not on the screen'),
    });
    const answered = view({ screen: `❯ ${words}\n● KAVO\n❯` });
    expect(judgeConformance({ screen: "KAVO" }, answered, ctx({ lastWords: words }))).toEqual({
      ok: true,
      evidence: "screen: ● KAVO",
    });
  });

  test("absent: after the first words of the check only", () => {
    const seen = view({ screen: "LIST-END\n❯ Write the numbers\n1\n2\n❯ Stop now\n● KAVO" });
    expect(judgeConformance({ absent: "LIST-END" }, seen, ctx({ firstWords: "Write the numbers" })).ok).toBe(
      true,
    );
    const went = view({ screen: "❯ Write the numbers\n1\n2\nLIST-END\n❯ Stop now\n● KAVO" });
    expect(judgeConformance({ absent: "LIST-END" }, went, ctx({ firstWords: "Write the numbers" })).ok).toBe(
      false,
    );
  });

  test("sessionId: the host's own id; the placeholder of a host that names none is no id", () => {
    expect(judgeConformance({ sessionId: "known" }, view(), ctx()).ok).toBe(true);
    const placeholder = view({ pane: { id: "w1:p1", alive: true, sessionId: "continue" } });
    expect(judgeConformance({ sessionId: "known" }, placeholder, ctx())).toEqual({
      ok: false,
      evidence: expect.stringContaining('the pane holds "continue"'),
    });
    expect(
      judgeConformance({ sessionId: "known" }, view({ pane: { id: "w1:p1", alive: true } }), ctx()).ok,
    ).toBe(false);
  });

  test("guard: a record of that decision since the check began, its reason naming the command", () => {
    const deny = {
      at: "2026-11-22T10:00:05.000Z",
      decision: "deny" as const,
      reason: "`git reset --hard` never runs here",
    };
    const want = { guard: { decision: "deny" as const, reason: "git reset --hard" } };
    expect(judgeConformance(want, view({ guard: [deny] }), ctx()).ok).toBe(true);
    // Before the check began: another check's record.
    expect(
      judgeConformance(want, view({ guard: [{ ...deny, at: "2026-11-22T09:59:00.000Z" }] }), ctx()).ok,
    ).toBe(false);
    expect(judgeConformance(want, view({ guard: [{ ...deny, decision: "ask" }] }), ctx())).toEqual({
      ok: false,
      evidence: expect.stringContaining("no deny about git reset --hard"),
    });
    expect(judgeConformance(want, view(), ctx()).evidence).toContain("its hook did not run");
  });

  test("file: still there with its words", () => {
    const want = { file: { path: "README.md", contains: "kavo" } };
    expect(judgeConformance(want, view({ files: { "README.md": "kept: kavo\n" } }), ctx()).ok).toBe(true);
    expect(judgeConformance(want, view({ files: { "README.md": "# repo\n" } }), ctx()).ok).toBe(false);
    expect(judgeConformance(want, view({ files: {} }), ctx()).evidence).toBe("README.md is gone");
  });

  test("commits: exactly as many since the check began, the last one's subject holding the words", () => {
    expect(judgeConformance({ commits: 0 }, view(), ctx()).ok).toBe(true);
    expect(judgeConformance({ commits: 0 }, view({ git: { commits: 3, subject: "x" } }), ctx()).ok).toBe(
      false,
    );
    const one = view({ git: { commits: 3, subject: "conformance consent kavo" } });
    expect(judgeConformance({ commits: 1, subject: "kavo" }, one, ctx())).toEqual({
      ok: true,
      evidence: "commits: 2 → 3 (last: conformance consent kavo)",
    });
    expect(judgeConformance({ commits: 1, subject: "lumi" }, one, ctx()).ok).toBe(false);
  });

  test("consent: kept by the user-prompt hook since the check began, and used by the command", () => {
    const used = view({ consents: { writtenAt: "2026-11-22T10:00:03.000Z", kinds: [] } });
    expect(judgeConformance({ consent: "commit" }, used, ctx()).ok).toBe(true);
    const unused = view({ consents: { writtenAt: "2026-11-22T10:00:03.000Z", kinds: ["commit"] } });
    expect(judgeConformance({ consent: "commit" }, unused, ctx()).evidence).toContain("no command used it");
    const old = view({ consents: { writtenAt: "2026-11-22T09:00:00.000Z", kinds: [] } });
    expect(judgeConformance({ consent: "commit" }, old, ctx()).ok).toBe(false);
    expect(judgeConformance({ consent: "commit" }, view(), ctx()).ok).toBe(false);
  });

  test("noPrompt and hookCalled", () => {
    expect(judgeConformance({ noPrompt: true }, view(), ctx()).ok).toBe(true);
    expect(judgeConformance({ noPrompt: true }, view(), ctx({ prompts: ["git status"] }))).toEqual({
      ok: false,
      evidence: "the host asked: git status",
    });
    const called = view({ pane: { id: "w1:p1", alive: true, lastHookAt: "2026-11-22T10:00:02.000Z" } });
    expect(judgeConformance({ hookCalled: true }, called, ctx()).ok).toBe(true);
    const before = view({ pane: { id: "w1:p1", alive: true, lastHookAt: "2026-11-22T09:00:02.000Z" } });
    expect(judgeConformance({ hookCalled: true }, before, ctx()).ok).toBe(false);
    expect(judgeConformance({ hookCalled: true }, view(), ctx()).ok).toBe(false);
  });
});

describe("the host's first-run question and its approvals", () => {
  const trust = [
    " Do you trust the files in this folder?",
    " /tmp/metator-conformance-claude-x1/conformance-ab12",
    " ❯ 1. Yes, proceed",
    "   2. No, exit",
  ].join("\n");

  test("the suite's own repository is trusted: by the question's Yes, else by its key on the screen", () => {
    const q = {
      id: "p001",
      source: "permission" as const,
      prompt: "trust",
      options: ["Yes, proceed", "No, exit", "Leave it"],
    };
    expect(firstRunTrust(view({ screen: trust, questions: [q] }), "conformance-ab12")).toEqual({
      question: q,
      choice: "Yes, proceed",
    });
    expect(firstRunTrust(view({ screen: trust }), "conformance-ab12")).toEqual({ key: "1" });
  });

  test("never another folder, never a screen that asks something else, never a Yes that remembers", () => {
    expect(firstRunTrust(view({ screen: trust }), "conformance-zz99")).toBeUndefined();
    expect(
      firstRunTrust(view({ screen: "❯ 1. Yes\n  2. No\nconformance-ab12" }), "conformance-ab12"),
    ).toBeUndefined();
    const remember =
      "Do you trust the files in this folder? conformance-ab12\n❯ 1. Yes, and remember this folder\n  2. No";
    expect(firstRunTrust(view({ screen: remember }), "conformance-ab12")).toBeUndefined();
  });

  test("an approval no check waits for is answered No; options are matched case aside", () => {
    const q = {
      id: "p002",
      source: "permission" as const,
      prompt: "Bash",
      options: ["Yes", "No, and tell Claude what to do differently (esc)"],
    };
    expect(refusalOf(q)).toBe("No, and tell Claude what to do differently (esc)");
    expect(optionMatching(q, "^yes$")).toBe("Yes");
    expect(refusalOf({ ...q, options: ["Allow", "Leave it"] })).toBeUndefined();
  });
});
