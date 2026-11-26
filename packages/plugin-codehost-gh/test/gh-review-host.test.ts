import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessRunner, ReviewSourceSchema } from "@metator/core";
import { reviewerHostContract, reviewHostContract, ScriptedProcessRunner } from "@metator/testing";
import { GhReviewHost, ghCalls, requestFromGh, requestsFromGh, threadsFromGh } from "../src/index.ts";

const source = (s: unknown) => ReviewSourceSchema.parse(s);
const shop = source({ kind: "github", repo: "acme/shop" });

describe("ghCalls", () => {
  test("lists, the requests asking me, a request's view and diff, by the repository", () => {
    const c = ghCalls(shop);
    expect(c.list()).toEqual([
      "pr",
      "list",
      "-R",
      "acme/shop",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,headRefName,url,author",
    ]);
    expect(c.requested()).toContain("review-requested:@me");
    expect(c.view("https://github.com/acme/shop/pull/45").slice(0, 3)).toEqual([
      "pr",
      "view",
      "https://github.com/acme/shop/pull/45",
    ]);
    expect(c.threads(45)).toContain("number=45");
    expect(c.approve(45)).toEqual(["pr", "review", "45", "-R", "acme/shop", "--approve"]);
  });

  test("the threads query sends the owner and name as strings (-f), so `2048/true` stays text; the number as a number", () => {
    const args = ghCalls(source({ kind: "github", repo: "2048/true" })).threads(7);
    const flagOf = (value: string) => args[args.indexOf(value) - 1];
    expect(flagOf("owner=2048")).toBe("-f");
    expect(flagOf("name=true")).toBe("-f");
    expect(flagOf("number=7")).toBe("-F");
  });

  test("a review is one call: its body, COMMENT, the head, and each comment on a line in gh's array form", () => {
    const args = ghCalls(shop).publish(45, {
      body: "General",
      headSha: "h1",
      comments: [{ file: "a.ts", line: 3, body: "Inline" }],
    });
    expect(args.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/acme/shop/pulls/45/reviews"]);
    expect(args).toContain("body=General");
    expect(args).toContain("event=COMMENT");
    expect(args).toContain("commit_id=h1");
    expect(args.slice(10)).toEqual([
      "-f",
      "comments[][path]=a.ts",
      "-F",
      "comments[][line]=3",
      "-f",
      "comments[][side]=RIGHT",
      "-f",
      "comments[][body]=Inline",
    ]);
  });
});

describe("gh's answers", () => {
  test("requests: what has no number or title is left out", () => {
    expect(
      requestsFromGh(
        JSON.stringify([
          { number: 45, title: "Cap", headRefName: "feat", url: "u", author: { login: "ola" } },
          { title: "no number" },
        ]),
      )._unsafeUnwrap(),
    ).toEqual([{ number: 45, title: "Cap", branch: "feat", url: "u", author: "ola" }]);
    expect(requestsFromGh("{}")._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  });

  test("threads: the first comment, its replies, resolved", () => {
    const payload = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "T1",
                  isResolved: true,
                  comments: {
                    nodes: [
                      { databaseId: 101, body: "Cents?", path: "a.ts", line: 2, author: { login: "anna" } },
                      { databaseId: 102, body: "Yes", author: { login: "ola" } },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    expect(threadsFromGh(JSON.stringify(payload))._unsafeUnwrap()).toEqual([
      {
        id: "T1",
        commentId: "101",
        author: "anna",
        file: "a.ts",
        line: 2,
        body: "Cents?",
        resolved: true,
        replies: [{ author: "ola", body: "Yes" }],
      },
    ]);
    expect(threadsFromGh("{}")._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  });

  test("a request's view: its state in lower case, merged and closed apart, its commits", () => {
    const view = (state: string) =>
      requestFromGh(
        JSON.stringify({
          number: 45,
          title: "Cap",
          url: "u",
          author: { login: "ola" },
          baseRefName: "main",
          headRefName: "feat",
          headRefOid: "h2",
          state,
          commits: [{ oid: "h1" }, { oid: "h2" }],
        }),
      )._unsafeUnwrap();
    expect(view("OPEN")).toEqual({
      number: 45,
      title: "Cap",
      url: "u",
      author: "ola",
      base: "main",
      head: "feat",
      headSha: "h2",
      state: "open",
      commits: ["h1", "h2"],
    });
    expect([view("MERGED").state, view("CLOSED").state]).toEqual(["merged", "closed"]);
  });
});

describe("GhReviewHost", () => {
  test("a failing gh is an error naming its first line; a missing one is BIN_NOT_FOUND; GitLab is refused", async () => {
    const runner = new ScriptedProcessRunner([
      { argvPrefix: ["gh", "pr", "list"], result: { exitCode: 1, stderr: "HTTP 404: Not Found\nmore" } },
      { argvPrefix: ["gh", "pr", "review"], result: { exitCode: 127, stderr: "gh: not found" } },
    ]);
    const host = new GhReviewHost(runner, { command: "gh", cwd: "." });
    const failed = (await host.listPullRequests(shop))._unsafeUnwrapErr();
    expect([failed.code, failed.message]).toEqual(["COMMAND_FAILED", "gh pr list: HTTP 404: Not Found"]);
    expect((await host.approve(shop, 1))._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
    expect(
      (await host.listPullRequests(source({ kind: "gitlab", repo: "a/b" })))._unsafeUnwrapErr().code,
    ).toBe("USAGE");
  });

  test("status: ready when gh runs and is logged in, with its version line", async () => {
    const version = {
      argvPrefix: ["gh", "--version"],
      result: { exitCode: 0, stdout: "gh version 2.0\nmore" },
    };
    const gh = (auth: number, v = version) =>
      new GhReviewHost(
        new ScriptedProcessRunner([v, { argvPrefix: ["gh", "auth", "status"], result: { exitCode: auth } }]),
        { command: "gh", cwd: "." },
      ).status();
    expect(await gh(0)).toEqual({ ready: true, version: "gh version 2.0" });
    expect((await gh(1)).ready).toBe(false);
    // While real hosts are refused, a real gh is never asked about its login.
    const runner = new ScriptedProcessRunner([version]);
    expect(await new GhReviewHost(runner, { command: "gh", cwd: "." }).status({ standIn: true })).toEqual({
      ready: false,
      version: "gh version 2.0",
    });
    expect(runner.calls.map((c) => c.argv.join(" "))).toEqual(["gh --version"]);
    expect(await gh(0, { argvPrefix: ["gh", "--version"], result: { exitCode: 127, stdout: "" } })).toEqual({
      ready: false,
    });
  });
});

// The contracts over a real process: the stand-in `gh` (e2e/helpers/fake-gh.ts), never GitHub.
const spawned: ProcessRunner = {
  async run(command) {
    const proc = Bun.spawn([...command.argv], {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, durationMs: 0 };
  },
};
const dir = mkdtempSync(join(tmpdir(), "metator-gh-"));
const stateFile = join(dir, "state.json");
const log = join(dir, "gh.log");
writeFileSync(log, "");
writeFileSync(
  stateFile,
  JSON.stringify({
    pulls: [
      {
        number: 45,
        title: "Cap the discount",
        html_url: "https://github.com/acme/shop/pull/45",
        user: { login: "maciej" },
        head: { ref: "feat/cap", sha: "abc45" },
        base: { ref: "main" },
      },
      { number: 46, title: "Asked of me", user: { login: "ola" }, head: { ref: "x", sha: "abc46" } },
    ],
    requested: [46],
    threads: {
      "45": [{ id: "T1", comments: [{ id: 101, body: "Is the cap in cents?", author: { login: "anna" } }] }],
    },
    diffs: {
      "45": "diff --git a/src/cap.ts b/src/cap.ts\n--- a/src/cap.ts\n+++ b/src/cap.ts\n@@ -1,1 +1,2 @@\n export const cap = 1;\n+export const max = 100;\n",
    },
  }),
);
process.env.FAKE_GH_STATE = stateFile;
process.env.FAKE_GH_LOG = log;
// An executable `gh` that runs the stand-in (its path only: the plugin's tests import no e2e code).
const shim = join(dir, "gh");
writeFileSync(
  shim,
  `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "../../../e2e/helpers/fake-gh.ts")}" "$@"\n`,
);
chmodSync(shim, 0o755);
const make = () => new GhReviewHost(spawned, { command: shim, cwd: dir });
const received = async () => readFileSync(log, "utf8").trim().split("\n");
const missing = source({ kind: "github", repo: "acme/missing" });

reviewHostContract("GhReviewHost", make, {
  source: shop,
  request: 45,
  thread: { id: "T1", body: "Is the cap in cents?" },
  missing,
  received,
  link: { url: "https://github.com/acme/shop/pull/45", adds: "export const max = 100;", headSha: "abc45" },
});
reviewerHostContract("GhReviewHost", make, {
  source: shop,
  requested: 46,
  request: 45,
  line: { file: "src/cap.ts", line: 2 },
  headSha: "abc45",
  missing,
  received,
});
