import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { Notifier } from "../src/application/notifier.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { MyReviews } from "../src/application/review-watch.ts";
import { MetatorConfigDocument } from "../src/domain/config.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import {
  type HostThread,
  mergeThreads,
  ReviewsConfigSchema,
  reviewId,
  reviewTask,
} from "../src/domain/review-thread.ts";

const thread = (id: string, extra: Partial<HostThread> = {}): HostThread => ({
  id,
  author: "anna",
  file: "src/discount.ts",
  line: 2,
  body: `Is ${id} in cents?`,
  resolved: false,
  ...extra,
});

function world(threads: () => HostThread[] | MetatorError, notifyExit = 0) {
  const fs = new InMemoryFileSystem();
  const started: { workflow: string; task: string; base?: string }[] = [];
  const sent: string[] = [];
  const notified: Record<string, string>[] = [];
  const done = new Set<string>();
  const reviews = new MyReviews({
    notifier: new Notifier({
      journal: { record: async () => ok(undefined), activity: async () => ok([]) },
      process: {
        run: async (spec) => {
          notified.push({ argv: spec.argv.join(" "), ...spec.env });
          return { exitCode: notifyExit, stdout: "", stderr: "no display", timedOut: false, durationMs: 1 };
        },
      },
      root: "/repo",
      command: "notify-send hi",
    }),
    config: ReviewsConfigSchema.parse({ sources: [{ kind: "github", repo: "acme/shop", author: "maciej" }] }),
    fs,
    paths: DEFAULT_PATHS,
    clock: new FixedClock(new Date("2026-11-10T12:00:00.000Z")),
    host: {
      listPullRequests: async () =>
        ok([
          {
            number: 45,
            title: "Cap the discount",
            branch: "feat/cap",
            url: "https://x/45",
            author: "maciej",
          },
          { number: 46, title: "Someone else's", author: "ola" },
        ]),
      listThreads: async (_s, n) => {
        // The other author's request is reviewed too: only the author filter keeps it out.
        const t = n === 45 ? threads() : [thread("other")];
        return t instanceof MetatorError ? err(t) : ok(t);
      },
      reply: async (_s, n, id, text) => {
        sent.push(`reply #${n} ${id}: ${text}`);
        return ok(undefined);
      },
      resolve: async (_s, n, id) => {
        sent.push(`resolve #${n} ${id}`);
        return ok(undefined);
      },
    },
    initRun: {
      execute: async (input) => {
        started.push({
          workflow: input.workflow,
          task: input.task,
          ...(input.worktree?.base ? { base: input.worktree.base } : {}),
        });
        return ok({ runId: `run-${started.length}` } as never);
      },
    },
    runActive: async (runId) => runId === "run-1" && !done.has(runId),
    runDone: async (runId) => done.has(runId),
  });
  return { fs, reviews, started, sent, notified, done };
}

describe("reviews of my requests (T3, design/14 §4)", () => {
  test("the sources live in MetatorConfig v11 with defaults; ids and merging are pure", () => {
    const v10 = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 10 },
      "x",
    )._unsafeUnwrap();
    expect(v10.reviews).toEqual({ everyMs: 120_000, sources: [], workflow: "mt-review-response" });
    expect(reviewId({ kind: "github", repo: "acme/shop" }, 45)).toBe("github-acme-shop-45");
    const first = mergeThreads(
      [],
      [thread("t1"), thread("t2", { resolved: true })],
      "2026-11-10T12:00:00.000Z",
    );
    expect(first.fresh).toEqual(["t1"]);
    expect(first.threads.map((t) => [t.id, t.kind, t.state])).toEqual([
      ["t1", "unsorted", "open"],
      ["t2", "unsorted", "resolved"],
    ]);
    // A known thread keeps what was made of it; one the host resolved is resolved; a vanished one is dropped.
    const kept = [
      { ...(first.threads[0] as (typeof first.threads)[0]), kind: "question" as const, reply: "Cents." },
    ];
    const next = mergeThreads(
      kept,
      [thread("t1", { resolved: true }), thread("t3")],
      "2026-11-11T00:00:00.000Z",
    );
    expect(next.fresh).toEqual(["t3"]);
    expect(next.threads.map((t) => [t.id, t.kind, t.state, t.reply])).toEqual([
      ["t1", "question", "resolved", "Cents."],
      ["t3", "unsorted", "open", undefined],
    ]);
    const task = reviewTask("github-acme-shop-45", { number: 45, title: "Cap", threads: first.threads });
    expect(task).toContain("> Is t1 in cents?");
    expect(task).toContain("the review's id is github-acme-shop-45");
  });

  test("a scan keeps my requests' threads and starts one run per request with new open threads, on its branch", async () => {
    let listed = [thread("t1"), thread("t2")];
    const w = world(() => listed);
    const first = (await w.reviews.scan())._unsafeUnwrap();
    expect(first.requests).toEqual([
      { id: "github-acme-shop-45", number: 45, open: 2, fresh: ["t1", "t2"], started: "run-1" },
    ]);
    expect(w.started).toEqual([
      {
        workflow: "mt-review-response",
        task: expect.stringContaining("thread t1 by anna on src/discount.ts:2"),
        base: "feat/cap",
      },
    ]);
    // Another reviewer's thread while the run goes on: kept, no second run.
    listed = [...listed, thread("t3")];
    const second = (await w.reviews.scan())._unsafeUnwrap();
    expect(second.requests[0]).toMatchObject({ open: 3, fresh: ["t3"] });
    expect(second.requests[0]?.started).toBeUndefined();
    expect(w.started).toHaveLength(1);
    const kept = (await w.reviews.show("github-acme-shop-45"))._unsafeUnwrap();
    expect(kept).toMatchObject({ number: 45, title: "Cap the discount", branch: "feat/cap", runId: "run-1" });
    expect(kept.threads.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect((await w.reviews.list())._unsafeUnwrap().map((r) => r.number)).toEqual([45]);
  });

  test("triage records what the agent made of a thread; send posts the proposed replies and resolve closes, only with a person's name", async () => {
    const w = world(() => [thread("t1"), thread("t2")]);
    await w.reviews.scan();
    const id = "github-acme-shop-45";
    (await w.reviews.triage(id, "t1", { kind: "question", reply: "Cents, as in Money." }))._unsafeUnwrap();
    (await w.reviews.triage(id, "t2", { kind: "change", state: "planned" }))._unsafeUnwrap();
    expect((await w.reviews.triage(id, "nope", { kind: "nit" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await w.reviews.send(id, { by: "" }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect(w.sent).toEqual([]);
    const sentReport = (await w.reviews.send(id, { by: "maciej" }))._unsafeUnwrap();
    expect(sentReport.sent).toEqual(["t1"]);
    expect(w.sent).toEqual(["reply #45 t1: Cents, as in Money."]);
    // Sent once: a second send has nothing to post.
    expect((await w.reviews.send(id, { by: "maciej" }))._unsafeUnwrap().sent).toEqual([]);
    (await w.reviews.resolve(id, "t1", { by: "maciej" }))._unsafeUnwrap();
    expect(w.sent.at(-1)).toBe("resolve #45 t1");
    const kept = (await w.reviews.show(id))._unsafeUnwrap();
    expect(kept.threads.map((t) => [t.id, t.kind, t.state])).toEqual([
      ["t1", "question", "resolved"],
      ["t2", "change", "planned"],
    ]);
  });

  test("a host that cannot be read is reported for its source; nothing is lost", async () => {
    const w = world(() => MetatorError.usage("no MCP"));
    const r = (await w.reviews.scan())._unsafeUnwrap();
    expect(r.errors).toEqual(["github:acme/shop#45: no MCP"]);
    expect(w.started).toEqual([]);
  });

  test("a review with new threads is announced once through notify.command; a failing command is reported, not fatal", async () => {
    let listed = [thread("t1"), thread("t2")];
    const w = world(() => listed);
    await w.reviews.scan();
    expect(w.notified).toEqual([
      {
        argv: "sh -c notify-send hi",
        METATOR_EVENT: "review",
        METATOR_NOTIFY_TEXT: "Review on #45 Cap the discount: 2 new threads",
        METATOR_QUESTION_PROMPT: "Review on #45 Cap the discount: 2 new threads",
        METATOR_REVIEW_ID: "github-acme-shop-45",
        METATOR_REVIEW_NUMBER: "45",
        METATOR_REVIEW_TITLE: "Cap the discount",
        METATOR_REVIEW_URL: "https://x/45",
      },
    ]);
    // Nothing new: nothing said. One more thread while the run goes on: said, though no run starts.
    await w.reviews.scan();
    expect(w.notified).toHaveLength(1);
    listed = [...listed, thread("t3")];
    await w.reviews.scan();
    expect(w.notified[1]?.METATOR_NOTIFY_TEXT).toBe("Review on #45 Cap the discount: 1 new thread");
    const broken = world(() => [thread("t1")], 3);
    const report = (await broken.reviews.scan())._unsafeUnwrap();
    expect(report.requests).toHaveLength(1);
    expect(report.errors).toEqual(["notify.command failed for github-acme-shop-45 (exit 3): no display"]);
  });

  test("planned threads are fixed once the answering run is done, not before; other threads keep their state", async () => {
    const w = world(() => [thread("t1"), thread("t2"), thread("t3")]);
    await w.reviews.scan();
    const id = "github-acme-shop-45";
    await w.reviews.triage(id, "t1", { kind: "change", state: "planned" });
    await w.reviews.triage(id, "t2", { kind: "nit", state: "planned" });
    await w.reviews.triage(id, "t3", { kind: "question", reply: "Cents." });
    const during = (await w.reviews.scan())._unsafeUnwrap();
    expect(during.requests[0]?.fixed).toBeUndefined();
    expect((await w.reviews.show(id))._unsafeUnwrap().threads.map((t) => t.state)).toEqual([
      "planned",
      "planned",
      "open",
    ]);
    w.done.add("run-1");
    const after = (await w.reviews.scan())._unsafeUnwrap();
    expect(after.requests[0]).toMatchObject({ open: 1, fresh: [], fixed: ["t1", "t2"] });
    expect((await w.reviews.show(id))._unsafeUnwrap().threads.map((t) => [t.id, t.state])).toEqual([
      ["t1", "fixed"],
      ["t2", "fixed"],
      ["t3", "open"],
    ]);
    // Said once: the next scan has nothing left to mark.
    expect((await w.reviews.scan())._unsafeUnwrap().requests[0]?.fixed).toBeUndefined();
  });
});
