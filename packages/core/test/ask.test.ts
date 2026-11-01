import { describe, expect, test } from "bun:test";
import { FakeAgentHost, FixedClock, InMemoryFileSystem } from "@metator/testing";
import { AskQuestion, ConversationRepository } from "../src/application/ask.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { conversationId, findCitations, guidePrompt } from "../src/domain/conversation.ts";
import type { AgentTask } from "../src/domain/drive.ts";

describe("conversation domain", () => {
  test("ids: the day and the question's first words; taken ones get a number", () => {
    const at = new Date("2026-10-28T10:00:00.000Z");
    expect(conversationId("How is the VAT computed?", at, () => false)).toBe(
      "20261028-how-is-the-vat-computed",
    );
    expect(conversationId("Jak działa rabat łączony?", at, () => false)).toBe(
      "20261028-jak-dziala-rabat-laczony",
    );
    expect(conversationId("???", at, () => false)).toBe("20261028-question");
    const taken = new Set(["20261028-why", "20261028-why-2"]);
    expect(conversationId("Why", at, (id) => taken.has(id))).toBe("20261028-why-3");
    expect(conversationId("x".repeat(100), at, () => false)).toHaveLength(9 + 40);
  });

  test("citations: path:line and ranges, once each, not URLs or times", () => {
    const answer = [
      "It starts in packages/billing/src/discount.ts:12 and caps at src/cap.ts:40-48.",
      "See (packages/billing/src/discount.ts:12) again, and ./README.md:3.",
      "Not https://example.com:443/x, not 10:30, not file.ts:0.",
    ].join("\n");
    expect(findCitations(answer)).toEqual([
      { path: "packages/billing/src/discount.ts", line: 12 },
      { path: "src/cap.ts", line: 40 },
      { path: "README.md", line: 3 },
    ]);
  });

  test("citations: Next.js segments, and a bare file name after its full path is that file", () => {
    const answer = [
      "Mounted in apps/web/app/[locale]/(protected)/layout.tsx:52.",
      "The registry is packages/a/src/registry.ts:72; registration at `registry.ts:36`.",
      "Two providers: packages/x/providers.tsx:12 and apps/web/providers.tsx:45; see providers.tsx:70.",
      "An unknown one: lonely.ts:3.",
    ].join("\n");
    expect(findCitations(answer)).toEqual([
      { path: "apps/web/app/[locale]/(protected)/layout.tsx", line: 52 },
      { path: "packages/a/src/registry.ts", line: 72 },
      { path: "packages/a/src/registry.ts", line: 36 },
      { path: "packages/x/providers.tsx", line: 12 },
      { path: "apps/web/providers.tsx", line: 45 },
      { path: "apps/web/providers.tsx", line: 70 },
      { path: "lonely.ts", line: 3 },
    ]);
  });

  test("the prompt carries the rules and earlier turns, unless the host continues its session", () => {
    const turns = [1, 2, 3, 4].map((n) => ({
      at: "2026-10-28T10:00:00.000Z",
      by: "m",
      question: `q${n}`,
      answer: `a${n}`,
      ok: true,
      citations: [],
    }));
    const fresh = guidePrompt("Why?", "this repository", turns, false);
    expect(fresh).toContain("Cite every claim as path:line");
    expect(fresh).toContain("Q: q2\nA: a2");
    expect(fresh).not.toContain("q1");
    expect(fresh.endsWith("Question: Why?")).toBe(true);
    expect(guidePrompt("Why?", "this repository", turns, true)).not.toContain("q4");
  });
});

function world(turns: ConstructorParameters<typeof FakeAgentHost>[0]) {
  const fs = new InMemoryFileSystem({ "src/discount.ts": "export const d = 1;\n" });
  const host = new FakeAgentHost(turns);
  const repo = new ConversationRepository(fs, DEFAULT_PATHS);
  const clock = new FixedClock(new Date("2026-10-28T10:00:00.000Z"));
  const ask = new AskQuestion(new Map([["fake", host]]), repo, clock, async (_cwd, path) => fs.exists(path));
  const input = {
    defaultHost: "fake",
    by: "maciej",
    cwd: "/repo",
    projectRoot: "/repo",
    where: "this repository",
  };
  return { fs, host, repo, ask, input, clock };
}

describe("AskQuestion", () => {
  test("a question gets mt-guide's answer with checked citations and starts a conversation", async () => {
    const w = world({ "mt-guide": [{ text: "It is 1, see src/discount.ts:1 and src/gone.ts:9." }] });
    const events: string[] = [];
    const r = (
      await w.ask.execute({
        ...w.input,
        question: "  How is the discount computed? ",
        onEvent: (e) => events.push(e.type),
      })
    )._unsafeUnwrap();
    expect(r.answer).toBe("It is 1, see src/discount.ts:1 and src/gone.ts:9.");
    expect(r.citations).toEqual([
      { path: "src/discount.ts", line: 1, exists: true },
      { path: "src/gone.ts", line: 9, exists: false },
    ]);
    expect(r.conversation).toMatchObject({
      id: "20261028-how-is-the-discount-computed",
      title: "How is the discount computed?",
      host: "fake",
      hostSession: "mt-guide-1",
    });
    expect(events).toEqual(["session", "text", "result"]);
    const task = w.host.tasks[0] as AgentTask;
    expect([task.agent, task.cwd, task.resume, task.runDir]).toEqual([
      "mt-guide",
      "/repo",
      undefined,
      "/repo/.metator/conversations",
    ]);
    expect(task.prompt).toContain("Question: How is the discount computed?");
    expect((await w.repo.list())._unsafeUnwrap().map((c) => c.turns.length)).toEqual([1]);
  });

  test("a short path is the file next to one cited in full before it", async () => {
    const w = world({
      "mt-guide": [
        {
          text: "The list is in api/src/module/offers/controllers/admin.ts:41; its items are dto/item.dto.ts:59, built in offer.service.ts:150, and nowhere/else.ts:3.",
        },
      ],
    });
    for (const f of [
      "api/src/module/offers/controllers/admin.ts",
      "api/src/module/offers/dto/item.dto.ts",
      "api/src/module/offers/controllers/offer.service.ts",
    ])
      await w.fs.write(f, "x\n");
    const r = (await w.ask.execute({ ...w.input, question: "Where?" }))._unsafeUnwrap();
    expect(r.citations.map((c) => [c.path, c.exists])).toEqual([
      ["api/src/module/offers/controllers/admin.ts", true],
      ["api/src/module/offers/dto/item.dto.ts", true],
      ["api/src/module/offers/controllers/offer.service.ts", true],
      ["nowhere/else.ts", false],
    ]);
  });

  test("a follow-up continues the host's session and the same conversation", async () => {
    const w = world({ "mt-guide": [{ text: "first" }, { text: "second" }] });
    const first = (await w.ask.execute({ ...w.input, question: "Where is VAT?" }))._unsafeUnwrap();
    w.clock.advance(60_000);
    const next = (
      await w.ask.execute({ ...w.input, question: "And the rate?", conversation: first.conversation.id })
    )._unsafeUnwrap();
    expect([next.conversation.id, next.conversation.turns.map((t) => t.answer)]).toEqual([
      first.conversation.id,
      ["first", "second"],
    ]);
    expect(w.host.tasks[1]?.resume).toBe("mt-guide-1");
    expect(w.host.tasks[1]?.prompt.startsWith("And the rate?")).toBe(true);
    expect(next.conversation.updatedAt).toBe("2026-10-28T10:01:00.000Z");
  });

  test("switching hosts mid-conversation starts a fresh host session with the history", async () => {
    const w = world({ "mt-guide": [{ text: "first" }] });
    const other = new FakeAgentHost({ "mt-guide": [{ text: "from the other host" }] });
    const ask = new AskQuestion(
      new Map([
        ["fake", w.host],
        ["other", other],
      ]),
      w.repo,
      w.clock,
      async () => true,
    );
    const first = (await ask.execute({ ...w.input, question: "Where is VAT?" }))._unsafeUnwrap();
    const next = (
      await ask.execute({
        ...w.input,
        question: "And the rate?",
        conversation: first.conversation.id,
        host: "other",
      })
    )._unsafeUnwrap();
    expect(other.tasks[0]?.resume).toBeUndefined();
    expect(other.tasks[0]?.prompt).toContain("Q: Where is VAT?\nA: first");
    expect([next.conversation.host, next.conversation.hostSession]).toEqual(["other", "mt-guide-1"]);
  });

  test("errors are values: empty question, unknown host or conversation, a failed answer is kept", async () => {
    const w = world({ "mt-guide": [{ text: "partial", ok: false }] });
    expect((await w.ask.execute({ ...w.input, question: "  " }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect(
      (await w.ask.execute({ ...w.input, question: "x", host: "nope" }))._unsafeUnwrapErr().message,
    ).toBe("unknown host nope");
    expect(
      (await w.ask.execute({ ...w.input, question: "x", conversation: "20261028-none" }))._unsafeUnwrapErr()
        .code,
    ).toBe("NOT_FOUND");
    const failed = (await w.ask.execute({ ...w.input, question: "Why?" }))._unsafeUnwrapErr();
    expect([failed.code, failed.hint]).toEqual([
      "COMMAND_FAILED",
      "The question is kept in 20261028-why; ask again with `metator ask --conversation 20261028-why …`.",
    ]);
    const kept = (await w.repo.load("20261028-why"))._unsafeUnwrap();
    expect(kept.turns.map((t) => [t.question, t.ok])).toEqual([["Why?", false]]);
  });

  test("two conversations started with the same words get their own ids", async () => {
    const w = world({ "mt-guide": [{ text: "a" }] });
    const a = (await w.ask.execute({ ...w.input, question: "Why?" }))._unsafeUnwrap();
    const b = (await w.ask.execute({ ...w.input, question: "Why?" }))._unsafeUnwrap();
    expect([a.conversation.id, b.conversation.id]).toEqual(["20261028-why", "20261028-why-2"]);
  });
});
