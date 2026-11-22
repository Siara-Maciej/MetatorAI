import { describe, expect, test } from "bun:test";
import {
  CodeHostConfigSchema,
  chooseVia,
  codehostFromV14,
  isSameRepo,
  noToolSentence,
  parseMrUrl,
  remoteRepo,
  reviewSourcesOf,
  sourceProblem,
} from "../src/domain/codehost.ts";
import { MetatorConfigDocument } from "../src/domain/config.ts";
import { DEFAULT_GUARD_CONFIG, guardCommand } from "../src/domain/guard-commands.ts";

const sources = CodeHostConfigSchema.parse({
  sources: [
    { id: "shop", kind: "github", repo: "acme/shop", via: "gh", author: "maciej" },
    { id: "lab", kind: "gitlab", repo: "grp/sub/app", via: "mcp:gitlab-work" },
    { id: "bugs", kind: "jira", project: "SHOP", via: "mcp:jira" },
  ],
}).sources;

describe("a link to an MR (ADR-0097)", () => {
  test("GitHub's pull and GitLab's merge request, with the host and the repository; trailing parts dropped", () => {
    expect(parseMrUrl("https://github.com/acme/shop/pull/45/files")._unsafeUnwrap()).toEqual({
      kind: "github",
      host: "github.com",
      repo: "acme/shop",
      number: 45,
      url: "https://github.com/acme/shop/pull/45",
    });
    expect(
      parseMrUrl("https://gitlab.example.com/grp/sub/app/-/merge_requests/7/diffs")._unsafeUnwrap(),
    ).toEqual({
      kind: "gitlab",
      host: "gitlab.example.com",
      repo: "grp/sub/app",
      number: 7,
      url: "https://gitlab.example.com/grp/sub/app/-/merge_requests/7",
    });
    for (const bad of ["nope", "https://github.com/acme/shop/issues/3", "ftp://github.com/a/b/pull/1"])
      expect(parseMrUrl(bad)._unsafeUnwrapErr().code).toBe("USAGE");
  });

  test("which tool reads it: the configured source, else an MCP server of the kind, else gh (GitHub), else the refusal", () => {
    const hub = { kind: "github" as const, host: "github.com", repo: "Acme/Shop" };
    expect(chooseVia(hub, { sources, servers: ["github"], gh: false })).toEqual({
      via: "gh",
      source: { kind: "github", repo: "acme/shop" },
    });
    const other = { ...hub, repo: "acme/other" };
    expect(chooseVia(other, { sources, servers: ["github"], gh: true })).toEqual({
      via: "mcp:github",
      source: { kind: "github", repo: "acme/other", mcp: "github" },
    });
    expect(chooseVia(other, { sources, servers: [], gh: true })).toEqual({
      via: "gh",
      source: { kind: "github", repo: "acme/other" },
    });
    expect(chooseVia(other, { sources, servers: [], gh: false })).toEqual({
      refusal: noToolSentence("github.com"),
    });
    // GitLab is read through MCP only: gh never.
    const lab = { kind: "gitlab" as const, host: "gitlab.com", repo: "x/y" };
    expect(chooseVia(lab, { sources, servers: [], gh: true })).toEqual({
      refusal: "I cannot open this MR: no code-host tool for gitlab.com is set up (an MCP server or gh)",
    });
    expect(chooseVia({ ...lab, repo: "grp/sub/app" }, { sources, servers: [], gh: false })).toMatchObject({
      via: "mcp:gitlab-work",
      source: { mcp: "gitlab-work" },
    });
  });

  test("an MCP server reads an MR only when it is named after the MR's kind: a gitlab server never reads GitHub", () => {
    const hub = { kind: "github" as const, host: "github.com", repo: "acme/other" };
    expect(chooseVia(hub, { sources, servers: ["gitlab", "jira"], gh: true })).toEqual({
      via: "gh",
      source: { kind: "github", repo: "acme/other" },
    });
    expect(chooseVia(hub, { sources, servers: ["gitlab"], gh: false })).toEqual({
      refusal: noToolSentence("github.com"),
    });
    const lab = { kind: "gitlab" as const, host: "gitlab.com", repo: "x/y" };
    expect(chooseVia(lab, { sources, servers: ["github"], gh: true })).toEqual({
      refusal: noToolSentence("gitlab.com"),
    });
  });

  test("a git remote is the MR's repository when host and path match (https or scp form, .git aside)", () => {
    expect(remoteRepo("git@github.com:acme/shop.git")).toEqual({ host: "github.com", repo: "acme/shop" });
    expect(remoteRepo("https://github.com/acme/shop.git")).toEqual({ host: "github.com", repo: "acme/shop" });
    const ref = { host: "github.com", repo: "Acme/Shop" };
    expect(isSameRepo("git@github.com:acme/shop.git", ref)).toBe(true);
    expect(isSameRepo("https://github.com/acme/shop", ref)).toBe(true);
    expect(isSameRepo("https://gitlab.com/acme/shop", ref)).toBe(false);
    expect(isSameRepo("/srv/repos/shop", ref)).toBe(false);
  });
});

describe("codehost in MetatorConfig v15", () => {
  test("a source names what it needs: a repo (github, gitlab), a project and MCP (jira); gh only for GitHub", () => {
    expect(sourceProblem({ id: "a", kind: "gitlab", repo: "x", via: "gh" })).toContain(
      "gh reads GitHub only",
    );
    expect(sourceProblem({ id: "a", kind: "github", via: "gh" })).toContain("names its repo");
    expect(sourceProblem({ id: "a", kind: "jira", project: "P", via: "gh" })).toContain("MCP server");
    expect(sourceProblem({ id: "a", kind: "jira", via: "mcp:jira" })).toContain("names its project");
    expect(sourceProblem({ id: "a", kind: "github", repo: "x/y", via: "gh" })).toBeUndefined();
    expect(CodeHostConfigSchema.safeParse({ sources: [sources[0], sources[0]] }).success).toBe(false);
    expect(CodeHostConfigSchema.safeParse({ sources: [{ ...sources[0], via: "ssh" }] }).success).toBe(false);
  });

  test("the review sources are GitHub's and GitLab's, with their MCP server; gh's have none", () => {
    expect(reviewSourcesOf({ sources })).toEqual([
      { kind: "github", repo: "acme/shop", author: "maciej" },
      { kind: "gitlab", repo: "grp/sub/app", mcp: "gitlab-work" },
    ]);
  });

  test("v14 → v15: reviews.sources and intake sources move to codehost.sources, shared when equal; rules name them", () => {
    const v14 = {
      kind: "MetatorConfig",
      schemaVersion: 14,
      reviews: {
        everyMs: 60_000,
        sources: [
          { kind: "github", repo: "acme/shop", author: "maciej" },
          { kind: "gitlab", repo: "grp/app", mcp: "lab" },
        ],
      },
      intake: {
        rules: [
          {
            id: "bugs",
            source: { kind: "github", repo: "acme/shop", labels: ["bug"] },
            workflow: "mt-bugfix",
          },
          { id: "other", source: { kind: "github", repo: "acme/shop", mcp: "gh2" }, workflow: "mt-feature" },
        ],
      },
      guard: { commands: { ask: ["git push"] } },
    };
    const v15 = MetatorConfigDocument.parse(v14, "x")._unsafeUnwrap();
    expect(v15.codehost.sources).toEqual([
      { id: "github-acme-shop", kind: "github", repo: "acme/shop", via: "mcp:github", author: "maciej" },
      { id: "gitlab-grp-app", kind: "gitlab", repo: "grp/app", via: "mcp:lab" },
      { id: "github-acme-shop-2", kind: "github", repo: "acme/shop", via: "mcp:gh2" },
    ]);
    expect(v15.reviews).toEqual({ everyMs: 60_000, workflow: "mt-review-response" });
    expect(v15.intake.rules.map((r) => [r.id, r.source, r.labels])).toEqual([
      ["bugs", "github-acme-shop", ["bug"]],
      ["other", "github-acme-shop-2", []],
    ]);
    // A list the person wrote keeps its patterns and gains approving at the host.
    expect(v15.guard.commands.ask).toEqual(["git push", "metator review approve"]);
    // A v15 rule must name a source that exists.
    expect(
      MetatorConfigDocument.parse(
        {
          kind: "MetatorConfig",
          schemaVersion: 15,
          intake: { rules: [{ id: "r", source: "nope", workflow: "w" }] },
        },
        "x",
      )._unsafeUnwrapErr().message,
    ).toContain("names the source nope");
    expect(codehostFromV14({ kind: "MetatorConfig" })).toEqual({ kind: "MetatorConfig" });
  });

  test("approving at the host asks the person (kind approve); the v14 default never had it", () => {
    expect(
      guardCommand(["metator", "review", "approve", "github-acme-shop-45"], DEFAULT_GUARD_CONFIG.commands),
    ).toEqual({
      level: "ask",
      pattern: "metator review approve",
      kind: "approve",
    });
    expect(guardCommand(["metator", "review", "show", "x"], DEFAULT_GUARD_CONFIG.commands).level).toBe(
      "allow",
    );
    const v14 = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 13 },
      "x",
    )._unsafeUnwrap();
    expect(v14.guard.commands.ask).toContain("metator review approve");
  });
});
