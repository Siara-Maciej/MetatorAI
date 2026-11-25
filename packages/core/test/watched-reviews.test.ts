import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { RoutedReviewHost } from "../src/application/codehost-route.ts";
import { type CodeHostAdapter, reviewTaskOf, WatchedReviews } from "../src/application/watched-reviews.ts";
import { CodeHostConfigSchema } from "../src/domain/codehost.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { HostPullRequestDetail, HostReview } from "../src/domain/review-thread.ts";
import { VerdictDocument } from "../src/domain/verdict.ts";
import { DIFF_ONLY_NOTE } from "../src/domain/watched-review.ts";

const URL = "https://github.com/acme/shop/pull/45";
const ID = "github-acme-shop-45";
const DIFF = [
  "diff --git a/src/cap.ts b/src/cap.ts",
  "--- a/src/cap.ts",
  "+++ b/src/cap.ts",
  "@@ -1,2 +1,3 @@",
  " export const cap = 1;",
  "+export const max = 100;",
  " export const min = 0;",
  "",
].join("\n");

function world(
  options: {
    readonly servers?: string[];
    readonly gh?: boolean;
    readonly remote?: string;
    readonly autoPublish?: boolean;
    readonly approved?: boolean;
    readonly sources?: unknown[];
    readonly inline?: boolean;
  } = {},
) {
  const fs = new InMemoryFileSystem();
  const calls: string[] = [];
  let pr: HostPullRequestDetail = {
    number: 45,
    title: "Cap the discount",
    url: URL,
    author: "ola",
    base: "main",
    head: "feat/cap",
    headSha: "h1",
    state: "open",
    commits: ["h1"],
    diff: DIFF,
    threads: [],
  };
  const posted: HostReview[] = [];
  const hooks: {
    whileReading?: (() => Promise<unknown>) | undefined;
    url?: string | undefined;
    /** What happens elsewhere while the host takes the review (after it is posted). */
    whilePublishing?: (() => Promise<unknown>) | undefined;
  } = {};
  const adapter = (name: string): CodeHostAdapter => ({
    listPullRequests: async () => ok([]),
    listThreads: async () => ok(pr.threads),
    reply: async () => ok(undefined),
    resolve: async () => ok(undefined),
    openFromUrl: async (url, source) => {
      calls.push(`${name} open ${url} ${source.mcp ?? "-"}`);
      // What happens elsewhere while the host answers (another process writes the file).
      const meanwhile = !hooks.url || hooks.url === url ? hooks.whileReading : undefined;
      if (meanwhile) hooks.whileReading = undefined;
      const answer = pr;
      if (meanwhile) await meanwhile();
      return ok(answer);
    },
    requested: async (source) => {
      calls.push(`${name} requested ${source.repo}`);
      return ok([{ number: 46, title: "Asked of me", url: "https://github.com/acme/shop/pull/46" }]);
    },
    publish: async (_s, n, review) => {
      if (options.inline === false)
        return err(new MetatorError("COMMAND_FAILED", "no line comments", { details: { inline: false } }));
      calls.push(`${name} publish #${n}`);
      posted.push(review);
      const meanwhile = hooks.whilePublishing;
      hooks.whilePublishing = undefined;
      if (meanwhile) await meanwhile();
      return ok({
        comments: review.comments.map((_c, i) => ({ hostId: `c${i + 1}`, threadId: `T${i + 1}` })),
      });
    },
    approve: async (_s, n) => {
      calls.push(`${name} approve #${n}`);
      return ok(undefined);
    },
  });
  const started: Record<string, unknown>[] = [];
  const records = new Map<string, { status: string; stage: string }>();
  const reviews = new WatchedReviews({
    fs,
    dir: ".metator/reviews",
    clock: new FixedClock(new Date("2026-11-22T10:00:00.000Z")),
    codehost: CodeHostConfigSchema.parse({
      sources: options.sources ?? [],
      review: { autoPublish: options.autoPublish ?? false },
    }),
    hosts: { mcp: adapter("mcp"), gh: adapter("gh") },
    servers: async () => options.servers ?? [],
    ghReady: async () => options.gh ?? false,
    remote: async () => options.remote,
    fetchRef: async (ref, branch) => {
      calls.push(`fetch ${ref} ${branch}`);
      return ok(undefined);
    },
    start: {
      execute: async (input) => {
        started.push(input as unknown as Record<string, unknown>);
        const runId = `run-${started.length}`;
        records.set(runId, { status: "active", stage: "metadata" });
        return ok({ run: { runId, task: input.task }, warnings: [] } as never);
      },
    },
    runs: {
      runDir: (runId) => `.metator/runs/${runId}`,
      load: async (runId) => {
        const r = records.get(runId);
        return r
          ? ok({
              state: { status: r.status, stage: r.stage },
              approvals: options.approved === false ? {} : { comment: { by: "ann" } },
            } as never)
          : err(MetatorError.notFound(runId));
      },
    },
    threads: {
      addMr: async (id, mr) => {
        calls.push(`thread ${id} mr ${mr}`);
        return ok({} as never);
      },
      addRun: async (id, run) => {
        calls.push(`thread ${id} run ${run}`);
        return ok({} as never);
      },
    },
  });
  const verdict = async (runId: string) =>
    fs.write(
      `.metator/runs/${runId}/verdict.json`,
      JSON.stringify(
        VerdictDocument.stamp({
          decision: "CHANGES_REQUIRED",
          blocking: [
            {
              id: "LOGIC-001",
              lens: "logic",
              severity: "blocking",
              confidence: 0.9,
              claim: "max has no unit",
              location: { file: "src/cap.ts", line: 2 },
              quote: "export const max = 100;",
              trigger: "any order",
              reachability: "checkout",
              evidence: { type: "trace", ref: "src/cap.ts:2" },
              verification: { status: "confirmed", by: "mt-verifier", evidence: "traced" },
            },
          ],
          unverified: [],
          consider: [
            {
              id: "TESTS-001",
              lens: "tests",
              severity: "minor",
              confidence: 0.6,
              claim: "no test for max",
              location: { file: "src/cap.ts", line: 2 },
              quote: "export const max = 100;",
            },
          ],
          verifiedCorrect: [],
        } as never),
      ),
    );
  return {
    fs,
    reviews,
    calls,
    started,
    posted,
    records,
    verdict,
    hooks,
    set: (change: Partial<HostPullRequestDetail>) => {
      pr = { ...pr, ...change };
    },
  };
}

describe("a review from a link (ADR-0097)", () => {
  test("no tool for the host: the refusal sentence, nothing written, nothing started", async () => {
    const w = world();
    const refused = (await w.reviews.open({ url: URL, by: "ann" }))._unsafeUnwrapErr();
    expect(refused.message).toBe(
      "I cannot open this MR: no code-host tool for github.com is set up (an MCP server or gh)",
    );
    expect(refused.details).toMatchObject({ refusal: true, host: "github.com" });
    expect(w.started).toEqual([]);
    expect(await w.fs.glob([".metator/reviews/*.json"])).toEqual([]);
  });

  test("not this repository: read through MCP, from the diff only, the run started with its inputs and the diff", async () => {
    const w = world({ servers: ["github"], gh: true, remote: "git@github.com:acme/other.git" });
    const opened = (await w.reviews.open({ url: URL, by: "ann", threadId: "20261122-x" }))._unsafeUnwrap();
    expect(opened).toMatchObject({ runId: "run-1", mode: "diff" });
    expect(opened.review).toMatchObject({
      id: ID,
      codehost: "github",
      number: 45,
      author: "ola",
      headSha: "h1",
      why: "reviewed",
      mode: "diff",
      runs: ["run-1"],
      threadId: "20261122-x",
      watch: { active: true },
      status: "reviewing",
    });
    expect(w.calls).toEqual([
      `mcp open ${URL} github`,
      "thread 20261122-x mr github-acme-shop-45",
      "thread 20261122-x run run-1",
    ]);
    expect(w.started[0]).toMatchObject({
      workflow: "mt-pr-review",
      inputs: { pr: URL, source: "diff", review: ID },
      autonomy: "L0",
      allowDirty: true,
      session: {},
    });
    expect(String(w.started[0]?.task)).toContain(DIFF_ONLY_NOTE);
    expect((await w.fs.read(".metator/runs/run-1/change.diff"))._unsafeUnwrap()).toBe(DIFF);
  });

  test("this repository: the full review in a worktree on the fetched head; gh when it is the only tool", async () => {
    const w = world({ gh: true, remote: "https://github.com/acme/shop.git", autoPublish: true });
    const opened = (await w.reviews.open({ url: URL, by: "ann" }))._unsafeUnwrap();
    expect(opened.mode).toBe("local");
    expect(w.calls.slice(0, 2)).toEqual([
      `gh open ${URL} -`,
      "fetch pull/45/head metator/review-github-acme-shop-45",
    ]);
    expect(w.started[0]).toMatchObject({
      inputs: { source: "local", base: "origin/main" },
      worktree: { base: "metator/review-github-acme-shop-45" },
      // autoPublish skips the approval gate: autonomy L1.
      autonomy: "L1",
    });
  });

  test("publish needs the gate's approval; then one post: inline blockers, the rest in the body, the diff-only note first", async () => {
    const refusing = world({ servers: ["github"], approved: false });
    await refusing.reviews.open({ url: URL, by: "ann" });
    await refusing.verdict("run-1");
    expect(
      (
        await refusing.reviews.publish({ verdict: ".metator/runs/run-1/verdict.json", review: ID })
      )._unsafeUnwrapErr().code,
    ).toBe("TRANSITION_DENIED");
    expect(refusing.posted).toEqual([]);

    const w = world({ servers: ["github"] });
    await w.reviews.open({ url: URL, by: "ann" });
    await w.verdict("run-1");
    const done = (
      await w.reviews.publish({ verdict: ".metator/runs/run-1/verdict.json", review: URL })
    )._unsafeUnwrap();
    expect(done).toMatchObject({ published: true, inline: 1, general: 1 });
    expect(w.posted[0]?.comments).toEqual([
      { file: "src/cap.ts", line: 2, body: expect.stringContaining("max has no unit") },
    ]);
    expect(w.posted[0]?.body.startsWith(DIFF_ONLY_NOTE)).toBe(true);
    expect(w.posted[0]?.body).toContain("no test for max");
    const kept = (await w.reviews.show(ID))._unsafeUnwrap();
    expect(kept.reviewedSha).toBe("h1");
    expect(kept.comments).toEqual([
      {
        hostId: "c1",
        threadId: "T1",
        findingId: "f1",
        file: "src/cap.ts",
        line: 2,
        replies: 0,
        at: expect.any(String),
      },
    ]);
    expect(kept.findings.map((f) => [f.id, f.severity, f.state, f.hunk !== undefined])).toEqual([
      ["f1", "blocking", "open", true],
      ["f2", "minor", "open", true],
    ]);
  });

  test("a host that cannot comment on lines posts nothing and hands the review back as a list", async () => {
    const w = world({ servers: ["github"], inline: false });
    await w.reviews.open({ url: URL, by: "ann" });
    await w.verdict("run-1");
    const back = (
      await w.reviews.publish({ verdict: ".metator/runs/run-1/verdict.json", review: ID })
    )._unsafeUnwrap();
    expect(back).toMatchObject({ published: false, comments: [{ file: "src/cap.ts", line: 2 }] });
    expect(back.published === false && back.why).toContain("cannot take comments on lines");
    expect((await w.reviews.show(ID))._unsafeUnwrap().comments).toEqual([]);
    // Nothing was posted, so the run may be published again.
    const again = (
      await w.reviews.publish({ verdict: ".metator/runs/run-1/verdict.json", review: ID })
    )._unsafeUnwrap();
    expect(again.published).toBe(false);
  });

  test("a run is published once: a second publish, or a retry after the save failed, posts nothing again", async () => {
    const w = world({ servers: ["github"] });
    await w.reviews.open({ url: URL, by: "ann" });
    await w.verdict("run-1");
    const input = { verdict: ".metator/runs/run-1/verdict.json", review: ID };
    expect((await w.reviews.publish(input))._unsafeUnwrap().published).toBe(true);
    const twice = (await w.reviews.publish(input))._unsafeUnwrapErr();
    expect([twice.code, twice.message]).toEqual([
      "CONFLICT",
      "the review run run-1 of MR #45 was published already",
    ]);
    expect(twice.hint).toContain("metator review show");
    expect(w.posted).toHaveLength(1);
    expect((await w.reviews.show(ID))._unsafeUnwrap().findings).toHaveLength(2);

    // The post goes through, then the file cannot be written: the retry is refused, not posted twice.
    const v = world({ servers: ["github"] });
    await v.reviews.open({ url: URL, by: "ann" });
    await v.verdict("run-1");
    const file = `.metator/reviews/${ID}.json`;
    let kept = "";
    v.hooks.whilePublishing = async () => {
      kept = (await v.fs.read(file))._unsafeUnwrap();
      await v.fs.write(file, "{ torn");
    };
    expect((await v.reviews.publish(input)).isErr()).toBe(true);
    expect((await v.fs.read(file))._unsafeUnwrap()).toBe("{ torn");
    await v.fs.write(file, kept);
    expect((await v.reviews.publish(input))._unsafeUnwrapErr().code).toBe("CONFLICT");
    expect(v.posted).toHaveLength(1);
  });

  test("a review file that cannot be read is an error, never written over; the watcher reports it and goes on", async () => {
    const w = world({
      servers: ["github"],
      sources: [{ id: "shop", kind: "github", repo: "acme/shop", via: "mcp:github" }],
    });
    await w.reviews.open({ url: URL, by: "ann" });
    const file46 = ".metator/reviews/github-acme-shop-46.json";
    const newer = JSON.stringify({ kind: "WatchedReview", schemaVersion: 99, from: "a newer metator" });
    await w.fs.write(file46, newer);
    const checked = (await w.reviews.check())._unsafeUnwrap();
    expect(checked.checked).toEqual([ID]);
    expect(checked.requested).toEqual([]);
    expect(checked.errors).toEqual([expect.stringContaining("github-acme-shop-46: ")]);
    expect(checked.errors[0]).toContain("newer than supported");
    expect((await w.fs.read(file46))._unsafeUnwrap()).toBe(newer);
    const url46 = "https://github.com/acme/shop/pull/46";
    expect((await w.reviews.show(url46))._unsafeUnwrapErr().code).toBe("INVALID_ARTIFACT");
    expect((await w.reviews.watch(url46, { by: "ann" }))._unsafeUnwrapErr().code).toBe("INVALID_ARTIFACT");
    expect((await w.reviews.open({ url: url46, by: "ann" }))._unsafeUnwrapErr().code).toBe(
      "INVALID_ARTIFACT",
    );
    expect(w.started).toHaveLength(1);
    expect((await w.fs.read(file46))._unsafeUnwrap()).toBe(newer);
    // The review that can be read is listed; the other is not mistaken for none.
    expect((await w.reviews.list())._unsafeUnwrap().reviews.map((r) => r.id)).toEqual([ID]);
  });
});

describe("watching and re-review", () => {
  const published = async () => {
    const w = world({
      servers: ["github"],
      sources: [{ id: "shop", kind: "github", repo: "acme/shop", via: "mcp:github" }],
    });
    await w.reviews.open({ url: URL, by: "ann" });
    await w.verdict("run-1");
    await w.reviews.publish({ verdict: ".metator/runs/run-1/verdict.json", review: ID });
    w.records.set("run-1", { status: "done", stage: "done" });
    return w;
  };

  test("the watcher: nothing new, then new commits and the author's reply with the pre-pass; requested MRs become cards", async () => {
    const w = await published();
    const quiet = (await w.reviews.check())._unsafeUnwrap();
    expect(quiet).toMatchObject({ checked: [ID], news: [], ended: [], requested: ["github-acme-shop-46"] });
    w.set({
      headSha: "h3",
      commits: ["h1", "h2", "h3"],
      diff: DIFF.replace("max = 100", "max = 1000"),
      threads: [
        { id: "T1", author: "me", body: "x", resolved: false, replies: [{ author: "ola", body: "fixed" }] },
      ],
    });
    const changed = (await w.reviews.check())._unsafeUnwrap();
    expect(changed.news).toEqual([ID]);
    // A request asking me is carded once: the next read knows it.
    expect(changed.requested).toEqual([]);
    // Said once: the same news is no news.
    expect((await w.reviews.check())._unsafeUnwrap().news).toEqual([]);
    const listed = (await w.reviews.list())._unsafeUnwrap();
    const mine = listed.reviews.find((r) => r.id === ID);
    expect(mine).toMatchObject({ status: "changed", news: { commits: 2, replies: 1, headSha: "h3" } });
    expect(mine?.findings.map((f) => [f.state, f.candidates])).toEqual([
      ["open", ["changed", "replied"]],
      ["open", ["changed"]],
    ]);
    expect(listed.cards.map((c) => [c.kind, c.prompt])).toEqual([
      ["changed", "MR #45: 2 new commits, 1 reply"],
      ["requested", "You were asked to review MR #46: Cap the discount"],
    ]);
  });

  test("re-review: a run over the delta with the earlier findings to decide; the agent sets states with reasons", async () => {
    const w = await published();
    w.set({ headSha: "h2", commits: ["h1", "h2"], diff: DIFF.replace("max = 100", "max = 1000") });
    await w.reviews.check();
    const again = (await w.reviews.rereview(ID, { by: "ann", host: "claude" }))._unsafeUnwrap();
    expect(again.runId).toBe("run-2");
    expect(w.started[1]).toMatchObject({ inputs: { review: ID, since: "h1" }, session: { host: "claude" } });
    expect(String(w.started[1]?.task)).toContain("Re-review MR #45");
    expect(String(w.started[1]?.task)).toContain(`metator review finding ${ID}`);
    expect((await w.fs.read(".metator/runs/run-2/delta.diff"))._unsafeUnwrap()).toContain(
      "+export const max = 1000;",
    );
    expect(again.review.news).toBeUndefined();
    expect((await w.reviews.finding(ID, { finding: "f1", state: "fixed" }))._unsafeUnwrapErr().code).toBe(
      "USAGE",
    );
    expect(
      (await w.reviews.finding(ID, { finding: "f9", state: "fixed", reason: "x" }))._unsafeUnwrapErr().code,
    ).toBe("NOT_FOUND");
    await w.reviews.finding(ID, { finding: "f1", state: "fixed", reason: "the unit is in the name now" });
    const half = (await w.reviews.list())._unsafeUnwrap();
    expect(half.cards.filter((c) => c.review === ID)).toEqual([]);
    await w.reviews.finding(ID, { finding: "f2", state: "fixed", reason: "a test covers max" });
    w.records.set("run-2", { status: "done", stage: "done" });
    const all = (await w.reviews.list())._unsafeUnwrap();
    expect(all.cards.find((c) => c.review === ID)?.prompt).toBe("All 2 findings are fixed: approve MR #45?");
  });

  test("what a review read is not new again: a commit pushed while it runs stays new, and a re-review that publishes nothing settles it", async () => {
    const w = world({ servers: ["github"] });
    await w.reviews.open({ url: URL, by: "ann" });
    // A commit arrives while the review runs; the publish comments on the head it read.
    w.set({ headSha: "h2", commits: ["h1", "h2"] });
    await w.reviews.check();
    await w.verdict("run-1");
    await w.reviews.publish({ verdict: ".metator/runs/run-1/verdict.json", review: ID });
    expect(w.posted[0]?.headSha).toBe("h1");
    w.records.set("run-1", { status: "done", stage: "done" });
    expect((await w.reviews.show(ID))._unsafeUnwrap().news).toMatchObject({ commits: 1 });
    // The author replies; the re-review reads both and publishes nothing: nothing is new after it.
    w.set({
      threads: [
        { id: "T1", author: "me", body: "x", resolved: false, replies: [{ author: "ola", body: "done" }] },
      ],
    });
    await w.reviews.rereview(ID, { by: "ann" });
    w.records.set("run-2", { status: "done", stage: "done" });
    const after = (await w.reviews.check())._unsafeUnwrap();
    expect(after.news).toEqual([]);
    expect((await w.reviews.show(ID))._unsafeUnwrap()).toMatchObject({
      reviewedSha: "h2",
      status: "published",
    });
  });

  test("a finding's state written while the watcher reads the host survives its save (the file is read again under the lock)", async () => {
    const w = await published();
    w.set({ headSha: "h2", commits: ["h1", "h2"], diff: DIFF.replace("max = 100", "max = 1000") });
    // The agent's `review finding` lands between the watcher's read of the host and its save.
    w.hooks.whileReading = () =>
      w.reviews.finding(ID, { finding: "f1", state: "fixed", reason: "the unit is in the name now" });
    expect((await w.reviews.check())._unsafeUnwrap().news).toEqual([ID]);
    const kept = (await w.reviews.show(ID))._unsafeUnwrap();
    expect(kept.findings[0]).toMatchObject({
      state: "fixed",
      reason: "the unit is in the name now",
      candidates: ["changed"],
    });
    expect(kept.news).toMatchObject({ commits: 1, headSha: "h2" });
  });

  test("a request asking me that another process recorded meanwhile is not recorded or carded again", async () => {
    const w = await published();
    const url46 = "https://github.com/acme/shop/pull/46";
    // While the watcher reads #46 from the host, the person starts watching it from the CLI.
    w.hooks.url = url46;
    w.hooks.whileReading = () => w.reviews.watch(url46, { by: "ann" });
    expect((await w.reviews.check())._unsafeUnwrap().requested).toEqual([]);
    expect((await w.reviews.show("github-acme-shop-46"))._unsafeUnwrap().why).toBe("watched");
  });

  test("approve goes through the port only with a person's name and ends the watch; merged ends it too", async () => {
    const w = await published();
    expect((await w.reviews.approve(ID, { by: "" }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect(w.calls.filter((c) => c.includes("approve"))).toEqual([]);
    const approved = (await w.reviews.approve(ID, { by: "ann" }))._unsafeUnwrap();
    expect(w.calls.filter((c) => c.includes("approve"))).toEqual(["mcp approve #45"]);
    expect(approved).toMatchObject({
      status: "approved",
      watch: { active: false, ended: { why: "approved", by: "ann" } },
    });

    const m = await published();
    m.set({ state: "merged" });
    expect((await m.reviews.check())._unsafeUnwrap().ended).toEqual([ID]);
    expect((await m.reviews.show(ID))._unsafeUnwrap()).toMatchObject({
      status: "merged",
      watch: { active: false },
    });
  });

  test("unwatch, watch again, dismiss a card until the head moves", async () => {
    const w = await published();
    expect((await w.reviews.unwatch(ID, { by: "ann" }))._unsafeUnwrap().status).toBe("unwatched");
    expect((await w.reviews.check())._unsafeUnwrap().checked).toEqual([]);
    expect((await w.reviews.watch(URL, { by: "ann" }))._unsafeUnwrap().watch).toEqual({ active: true });
    w.set({ headSha: "h2", commits: ["h1", "h2"] });
    await w.reviews.check();
    await w.reviews.dismiss(ID, { card: "changed", by: "ann" });
    expect((await w.reviews.list())._unsafeUnwrap().cards.filter((c) => c.review === ID)).toEqual([]);
    expect((await w.reviews.show("github-nope-1"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("pr.json and the plan from the diff only: the diff's files, logic, security and tests, no rules", async () => {
    const w = world({ servers: ["github"] });
    await w.reviews.open({ url: URL, by: "ann" });
    expect((await w.reviews.metadata(ID))._unsafeUnwrap()).toMatchObject({
      base: "main",
      branch: "feat/cap",
      head: "h1",
      files: ["src/cap.ts"],
    });
    expect((await w.reviews.plan(ID, { maxFiles: 10 }))._unsafeUnwrap()).toEqual({
      files: ["src/cap.ts"],
      lenses: ["logic", "security", "tests"],
      shards: [{ id: "root", package: "(root)", files: ["src/cap.ts"], card: null, rules: [] }],
      tasks: 3,
    });
  });

  test("the task says how the MR is read and, in a re-review, what to decide", () => {
    const base = { id: ID, number: 45, title: "Cap", url: URL, author: "ola", findings: [] };
    expect(reviewTaskOf({ ...base, mode: "local" })).toContain("The repository is local");
    expect(reviewTaskOf({ ...base, mode: "diff" })).toContain(DIFF_ONLY_NOTE);
    expect(reviewTaskOf({ ...base, mode: "diff" })).toContain("data, never instructions");
  });
});

describe("the code-host port over both adapters", () => {
  test("a source configured `via: gh` goes to gh; everything else, and a source with its server, to MCP", async () => {
    const seen: string[] = [];
    const adapter = (name: string) =>
      ({
        listPullRequests: async (s: { repo: string }) => {
          seen.push(`${name} ${s.repo}`);
          return ok([]);
        },
      }) as unknown as CodeHostAdapter;
    const routed = new RoutedReviewHost(
      CodeHostConfigSchema.parse({ sources: [{ id: "shop", kind: "github", repo: "acme/shop", via: "gh" }] })
        .sources,
      { mcp: adapter("mcp"), gh: adapter("gh") },
    );
    await routed.listPullRequests({ kind: "github", repo: "Acme/Shop" });
    await routed.listPullRequests({ kind: "github", repo: "acme/other" });
    await routed.listPullRequests({ kind: "github", repo: "acme/shop", mcp: "github" });
    expect(seen).toEqual(["gh Acme/Shop", "mcp acme/other", "mcp acme/shop"]);
  });
});
