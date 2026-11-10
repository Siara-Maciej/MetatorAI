import { describe, expect, test } from "bun:test";
import type { ReviewHost, ReviewSource } from "@metator/core";

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

    test("a source that cannot be reached is an error value, never a throw", async () => {
      for (const r of [
        await make().listPullRequests(fixture.missing),
        await make().listThreads(fixture.missing, 1),
        await make().reply(fixture.missing, 1, "t", "x"),
        await make().resolve(fixture.missing, 1, "t"),
      ])
        expect(r.isErr()).toBe(true);
    });
  });
}
