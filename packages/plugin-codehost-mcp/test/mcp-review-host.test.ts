import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, ReviewSourceSchema } from "@metator/core";
import { reviewerHostContract, reviewHostContract } from "@metator/testing";
import {
  diffFromResult,
  McpReviewHost,
  postedFrom,
  pullRequestsFromResult,
  requestFromResult,
  reviewCalls,
  SdkToolCaller,
  threadsFromResult,
} from "../src/index.ts";

const source = (s: unknown) => ReviewSourceSchema.parse(s);

describe("reviewCalls", () => {
  test("GitHub: the usual server's tools with owner and repo; a reply answers the comment by its number", () => {
    const c = reviewCalls(source({ kind: "github", repo: "acme/shop" }));
    expect(c.list()).toEqual({
      tool: "list_pull_requests",
      args: { owner: "acme", repo: "shop", state: "open" },
    });
    expect(c.threads(45)).toEqual({
      tool: "pull_request_read",
      args: { method: "get_review_comments", owner: "acme", repo: "shop", pullNumber: 45 },
    });
    expect(c.reply(45, "101", "Cents.").args).toEqual({
      owner: "acme",
      repo: "shop",
      pullNumber: 45,
      commentId: 101,
      body: "Cents.",
    });
    expect(c.resolve(45, "T1")).toEqual({ tool: "resolve_review_thread", args: { threadId: "T1" } });
  });

  test("GitLab: merge requests and discussions by project", () => {
    const c = reviewCalls(source({ kind: "gitlab", repo: "acme/shop" }));
    expect(c.list()).toEqual({
      tool: "list_merge_requests",
      args: { project_id: "acme/shop", state: "opened" },
    });
    expect(c.threads(7).args).toEqual({ project_id: "acme/shop", merge_request_iid: 7 });
    expect(c.resolve(7, "d1").args).toEqual({
      project_id: "acme/shop",
      merge_request_iid: 7,
      discussion_id: "d1",
      resolved: true,
    });
  });
});

describe("results", () => {
  test("requests: GitHub's pulls and GitLab's merge requests; what has no number or title is left out", () => {
    expect(
      pullRequestsFromResult(
        JSON.stringify([
          { number: 45, title: "Cap", head: { ref: "feat/cap" }, html_url: "u", user: { login: "maciej" } },
          { title: "no number" },
        ]),
      )._unsafeUnwrap(),
    ).toEqual([{ number: 45, title: "Cap", branch: "feat/cap", url: "u", author: "maciej" }]);
    expect(
      pullRequestsFromResult(
        JSON.stringify([
          { iid: 7, title: "MR", source_branch: "b", web_url: "w", author: { username: "ola" } },
        ]),
      )._unsafeUnwrap(),
    ).toEqual([{ number: 7, title: "MR", branch: "b", url: "w", author: "ola" }]);
    expect(pullRequestsFromResult("{}")._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  });

  test("threads: GitHub's review threads with the first comment; GitLab's discussions without system notes", () => {
    expect(
      threadsFromResult(
        JSON.stringify({
          threads: [
            {
              id: "T1",
              isResolved: true,
              comments: {
                nodes: [{ id: 101, body: "Cents?", author: { login: "anna" }, path: "a.ts", line: 2 }],
              },
            },
          ],
        }),
      )._unsafeUnwrap(),
    ).toEqual([
      { id: "T1", commentId: "101", author: "anna", file: "a.ts", line: 2, body: "Cents?", resolved: true },
    ]);
    expect(
      threadsFromResult(
        JSON.stringify([
          {
            id: "d1",
            notes: [
              {
                id: 5,
                body: "Why?",
                author: { username: "ola" },
                position: { new_path: "b.ts", new_line: 9 },
              },
            ],
          },
          { id: "d2", notes: [{ id: 6, body: "merged main", system: true }] },
        ]),
      )._unsafeUnwrap(),
    ).toEqual([
      { id: "d1", commentId: "5", author: "ola", file: "b.ts", line: 9, body: "Why?", resolved: false },
    ]);
    expect(threadsFromResult("nope")._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  });
});

describe("a request from its link (ADR-0097)", () => {
  test("GitHub's pull and GitLab's merge request: head, base, state; merged wins over closed", () => {
    expect(
      requestFromResult(
        JSON.stringify({
          number: 45,
          title: "Cap",
          html_url: "u",
          user: { login: "ola" },
          base: { ref: "main", sha: "b0" },
          head: { ref: "feat", sha: "h1" },
          state: "closed",
          merged: true,
        }),
      )._unsafeUnwrap(),
    ).toEqual({
      number: 45,
      title: "Cap",
      url: "u",
      author: "ola",
      base: "main",
      head: "feat",
      headSha: "h1",
      state: "merged",
      baseSha: "b0",
    });
    expect(
      requestFromResult(
        JSON.stringify({
          iid: 7,
          title: "MR",
          web_url: "w",
          author: { username: "ann" },
          source_branch: "s",
          target_branch: "t",
          sha: "h7",
          state: "opened",
          diff_refs: { base_sha: "b7", head_sha: "h7" },
        }),
      )._unsafeUnwrap(),
    ).toMatchObject({ number: 7, head: "s", base: "t", headSha: "h7", state: "open", baseSha: "b7" });
    expect(requestFromResult(JSON.stringify({ number: 1, title: "no head" }))._unsafeUnwrapErr().code).toBe(
      "PARSE_FAILED",
    );
  });

  test("a diff: GitHub's text as it is; GitLab's file list in `diff --git` form", () => {
    const text = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n";
    expect(diffFromResult(text)).toBe(text);
    expect(
      diffFromResult(
        JSON.stringify([
          { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-x\n+y\n" },
          { old_path: "n.ts", new_path: "n.ts", new_file: true, diff: "@@ -0,0 +1 @@\n+z\n" },
        ]),
      ),
    ).toBe(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+z\n",
    );
  });

  test("publish calls: GitHub a pending review, its line comments, the submit; GitLab threads with a position, then a note", () => {
    const review = { body: "B", headSha: "h", comments: [{ file: "a.ts", line: 3, body: "C" }] };
    expect(
      reviewCalls(source({ kind: "github", repo: "acme/shop" }))
        .publish(45, review)
        .map((c) => c.tool),
    ).toEqual(["pull_request_review_write", "add_comment_to_pending_review", "pull_request_review_write"]);
    const lab = reviewCalls(source({ kind: "gitlab", repo: "acme/shop" })).publish(7, review, "b");
    expect(lab.map((c) => c.tool)).toEqual(["create_merge_request_thread", "create_merge_request_note"]);
    expect(lab[0]?.args.position).toMatchObject({
      base_sha: "b",
      head_sha: "h",
      new_path: "a.ts",
      new_line: 3,
    });
    expect(reviewCalls(source({ kind: "github", repo: "acme/shop" })).approve(45).args).toMatchObject({
      event: "APPROVE",
    });
    // GitLab knows no "me": without the source's author nothing can be asked.
    expect(reviewCalls(source({ kind: "gitlab", repo: "acme/shop" })).requested()).toBeUndefined();
  });

  test("posted comments get their ids from the request's threads, matched by file, line and body", () => {
    const review = {
      body: "B",
      headSha: "h",
      comments: [
        { file: "a.ts", line: 3, body: "C" },
        { file: "b.ts", line: 1, body: "D" },
      ],
    };
    const threads = ok([
      { id: "T9", commentId: "99", author: "me", file: "a.ts", line: 3, body: "C", resolved: false },
    ]);
    expect(postedFrom(review, threads)._unsafeUnwrap().comments).toEqual([
      { hostId: "99", threadId: "T9" },
      { hostId: "posted-2" },
    ]);
  });
});

// The contract over a real MCP server process (stdio).
const dir = mkdtempSync(join(tmpdir(), "metator-reviewhost-"));
const pulls = join(dir, "pulls.json");
const log = join(dir, "mcp.log");
writeFileSync(log, "");
writeFileSync(
  pulls,
  JSON.stringify({
    pulls: [
      {
        number: 45,
        title: "Cap the discount",
        head: { ref: "feat/cap", sha: "abc45" },
        base: { ref: "main", sha: "base0" },
        state: "open",
        html_url: "https://github.com/acme/shop/pull/45",
        user: { login: "maciej" },
      },
      { number: 46, title: "Asked of me", head: { ref: "feat/x", sha: "abc46" }, user: { login: "ola" } },
    ],
    requested: [46],
    diffs: {
      "45": "diff --git a/src/cap.ts b/src/cap.ts\n--- a/src/cap.ts\n+++ b/src/cap.ts\n@@ -1,1 +1,2 @@\n export const cap = 1;\n+export const max = 100;\n",
    },
    threads: {
      "45": [
        {
          id: "T1",
          isResolved: false,
          comments: [{ id: 101, body: "Is the cap in cents?", author: { login: "anna" } }],
        },
      ],
    },
  }),
);
const FAKE = join(import.meta.dir, "../../../e2e/helpers/fake-mcp-server.ts");
const host = () =>
  new McpReviewHost(
    async () =>
      ok({ github: { command: "bun", args: [FAKE], env: { FAKE_MCP_PULLS: pulls, FAKE_MCP_LOG: log } } }),
    new SdkToolCaller(dir),
  );
reviewerHostContract("McpReviewHost", host, {
  source: source({ kind: "github", repo: "acme/shop" }),
  requested: 46,
  request: 45,
  line: { file: "src/cap.ts", line: 2 },
  headSha: "abc45",
  missing: source({ kind: "gitlab", repo: "acme/shop" }),
  received: async () => readFileSync(log, "utf8").trim().split("\n"),
});
reviewHostContract("McpReviewHost", host, {
  link: { url: "https://github.com/acme/shop/pull/45", adds: "export const max = 100;", headSha: "abc45" },
  source: source({ kind: "github", repo: "acme/shop" }),
  request: 45,
  thread: { id: "T1", body: "Is the cap in cents?" },
  missing: source({ kind: "gitlab", repo: "acme/shop" }),
  received: async () => readFileSync(log, "utf8").trim().split("\n"),
});
