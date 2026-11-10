import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, ReviewSourceSchema } from "@metator/core";
import { reviewHostContract } from "@metator/testing";
import {
  McpReviewHost,
  pullRequestsFromResult,
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

// The contract over a real MCP server process (stdio).
const dir = mkdtempSync(join(tmpdir(), "metator-reviewhost-"));
const pulls = join(dir, "pulls.json");
const log = join(dir, "mcp.log");
writeFileSync(log, "");
writeFileSync(
  pulls,
  JSON.stringify({
    pulls: [{ number: 45, title: "Cap the discount", head: { ref: "feat/cap" }, user: { login: "maciej" } }],
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
reviewHostContract(
  "McpReviewHost",
  () =>
    new McpReviewHost(
      async () =>
        ok({ github: { command: "bun", args: [FAKE], env: { FAKE_MCP_PULLS: pulls, FAKE_MCP_LOG: log } } }),
      new SdkToolCaller(dir),
    ),
  {
    source: source({ kind: "github", repo: "acme/shop" }),
    request: 45,
    thread: { id: "T1", body: "Is the cap in cents?" },
    missing: source({ kind: "gitlab", repo: "acme/shop" }),
    received: async () => readFileSync(log, "utf8").trim().split("\n"),
  },
);
