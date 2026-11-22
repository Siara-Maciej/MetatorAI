import { describe, expect, test } from "bun:test";
import type { ReviewerHost, ReviewHost, ReviewSource } from "@metator/core";

/** What the adapter under test must be able to reach for the suite. */
export interface ReviewHostFixture {
  /** A source with at least one open request that has the thread below. */
  readonly source: ReviewSource;
  readonly request: number;
  readonly thread: { readonly id: string; readonly body: string };
  /** A source whose server or repository does not exist. */
  readonly missing: ReviewSource;
  /** What the host received after a reply and a resolution, for the suite to look at. */
  readonly received: () => Promise<readonly string[]>;
  /** The request's link, a line its diff adds, and its head. */
  readonly link: { readonly url: string; readonly adds: string; readonly headSha: string };
}

/** Every ReviewHost adapter must pass this suite (T3, ADR-0083). */
export function reviewHostContract(name: string, make: () => ReviewHost, fixture: ReviewHostFixture): void {
  describe(`ReviewHost contract: ${name}`, () => {
    test("lists the open requests and a request's threads with an id, an author and the reviewer's words", async () => {
      const requests = (await make().listPullRequests(fixture.source))._unsafeUnwrap();
      const request = requests.find((r) => r.number === fixture.request);
      expect(request?.title.length).toBeGreaterThan(0);
      const threads = (await make().listThreads(fixture.source, fixture.request))._unsafeUnwrap();
      const thread = threads.find((t) => t.id === fixture.thread.id);
      expect(thread).toMatchObject({ body: fixture.thread.body, resolved: false });
      for (const t of threads)
        expect([t.id.length > 0, typeof t.author, typeof t.resolved]).toEqual([true, "string", "boolean"]);
    });

    test("a reply and a resolution reach the host; the thread then lists as resolved", async () => {
      const host = make();
      const threads = (await host.listThreads(fixture.source, fixture.request))._unsafeUnwrap();
      const thread = threads.find((t) => t.id === fixture.thread.id);
      (
        await host.reply(fixture.source, fixture.request, thread?.commentId ?? fixture.thread.id, "a reply")
      )._unsafeUnwrap();
      (await host.resolve(fixture.source, fixture.request, fixture.thread.id))._unsafeUnwrap();
      expect((await fixture.received()).join("\n")).toContain("a reply");
      const after = (await host.listThreads(fixture.source, fixture.request))._unsafeUnwrap();
      expect(after.find((t) => t.id === fixture.thread.id)?.resolved).toBe(true);
    });

    test("a request read from its link: what it is, its head, its diff and its threads", async () => {
      const detail = (await make().openFromUrl(fixture.link.url, fixture.source))._unsafeUnwrap();
      expect(detail).toMatchObject({ number: fixture.request, headSha: fixture.link.headSha, state: "open" });
      expect(detail.title.length).toBeGreaterThan(0);
      expect(detail.author.length).toBeGreaterThan(0);
      expect(detail.diff).toContain("diff --git ");
      expect(detail.diff).toContain(`+${fixture.link.adds}`);
      expect(detail.threads.some((t) => t.id === fixture.thread.id)).toBe(true);
    });

    test("a source that cannot be reached is an error value, never a throw", async () => {
      for (const r of [
        await make().listPullRequests(fixture.missing),
        await make().listThreads(fixture.missing, 1),
        await make().reply(fixture.missing, 1, "t", "x"),
        await make().resolve(fixture.missing, 1, "t"),
        await make().openFromUrl(fixture.link.url, fixture.missing),
      ])
        expect(r.isErr()).toBe(true);
    });
  });
}

/** What the reviewer side of an adapter must reach for the suite. */
export interface ReviewerHostFixture {
  /** A source with a request where I am a requested reviewer. */
  readonly source: ReviewSource;
  readonly requested: number;
  /** A request to review: a file and a line its diff adds. */
  readonly request: number;
  readonly line: { readonly file: string; readonly line: number };
  readonly headSha: string;
  readonly missing: ReviewSource;
  /** What the host received, one entry per call, for the suite to look at. */
  readonly received: () => Promise<readonly string[]>;
}

/** Every ReviewerHost adapter must pass this suite (ADR-0097). */
export function reviewerHostContract(
  name: string,
  make: () => ReviewerHost,
  fixture: ReviewerHostFixture,
): void {
  describe(`ReviewerHost contract: ${name}`, () => {
    test("lists the requests I am asked to review", async () => {
      const listed = (await make().requested(fixture.source))._unsafeUnwrap();
      expect(listed.some((r) => r.number === fixture.requested && r.title.length > 0)).toBe(true);
    });

    test("a review is posted in one go: its inline comments and its body reach the host", async () => {
      const posted = (
        await make().publish(fixture.source, fixture.request, {
          body: "the general part",
          headSha: fixture.headSha,
          comments: [{ ...fixture.line, body: "an inline part" }],
        })
      )._unsafeUnwrap();
      expect(posted.comments).toHaveLength(1);
      expect(posted.comments[0]?.hostId.length).toBeGreaterThan(0);
      const seen = (await fixture.received()).join("\n");
      expect(seen).toContain("the general part");
      expect(seen).toContain("an inline part");
    });

    test("an approval reaches the host", async () => {
      (await make().approve(fixture.source, fixture.request))._unsafeUnwrap();
      expect((await fixture.received()).join("\n")).toMatch(/approve/i);
    });

    test("a source that cannot be reached is an error value, never a throw", async () => {
      for (const r of [
        await make().requested(fixture.missing),
        await make().publish(fixture.missing, 1, { body: "x", headSha: "0", comments: [] }),
        await make().approve(fixture.missing, 1),
      ])
        expect(r.isErr()).toBe(true);
    });
  });
}
