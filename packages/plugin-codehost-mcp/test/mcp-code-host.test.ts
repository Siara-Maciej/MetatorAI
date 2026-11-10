import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, IntakeSourceSchema, type McpServers, MetatorError, ok } from "@metator/core";
import { codeHostContract } from "@metator/testing";
import { itemsFromResult, listCall, McpCodeHost, resolveEnv, SdkToolCaller } from "../src/index.ts";

const source = (s: unknown) => IntakeSourceSchema.parse(s);
const GITHUB = JSON.stringify([
  {
    number: 12,
    title: "Total is negative",
    body: "Steps…",
    html_url: "https://github.com/acme/shop/issues/12",
    labels: [{ name: "bug" }],
  },
  { number: 13, title: "A pull request", pull_request: {}, labels: [] },
  { number: 14, title: "Docs typo", body: null, labels: ["docs"] },
]);

describe("listCall", () => {
  test("GitHub: owner and repo, the state, the labels; another tool when the rule names one", () => {
    expect(listCall(source({ kind: "github", repo: "acme/shop", labels: ["bug"] }))).toEqual({
      tool: "list_issues",
      args: { owner: "acme", repo: "shop", state: "open", labels: ["bug"] },
    });
    expect(listCall(source({ kind: "github", repo: "acme/shop", tool: "search_issues" })).tool).toBe(
      "search_issues",
    );
  });

  test("GitLab says opened; Jira gets one JQL from the project, the type, the labels and the state", () => {
    expect(listCall(source({ kind: "gitlab", repo: "acme/shop" }))).toEqual({
      tool: "list_issues",
      args: { project_id: "acme/shop", state: "opened" },
    });
    expect(listCall(source({ kind: "jira", project: "SHOP", type: "Bug", labels: ["auto"] }))).toEqual({
      tool: "jira_search",
      args: { jql: 'project = "SHOP" AND issuetype = "Bug" AND labels = "auto" AND statusCategory != Done' },
    });
  });
});

describe("itemsFromResult", () => {
  test("GitHub's array: pull requests are left out; a missing body is empty; labels by name or as text", () => {
    expect(itemsFromResult(GITHUB)._unsafeUnwrap()).toEqual([
      {
        ref: "12",
        title: "Total is negative",
        body: "Steps…",
        url: "https://github.com/acme/shop/issues/12",
        labels: ["bug"],
      },
      { ref: "14", title: "Docs typo", body: "", labels: ["docs"] },
    ]);
  });

  test("GitLab's iid and web_url; Jira's key and fields under `issues`; no list or no JSON is PARSE_FAILED", () => {
    expect(
      itemsFromResult(
        JSON.stringify([{ iid: 3, title: "T", description: "D", web_url: "u", labels: ["x"] }]),
      )._unsafeUnwrap()[0],
    ).toEqual({ ref: "3", title: "T", body: "D", url: "u", labels: ["x"] });
    expect(
      itemsFromResult(
        JSON.stringify({
          issues: [{ key: "SHOP-7", fields: { summary: "Export", description: "CSV", labels: ["auto"] } }],
        }),
      )._unsafeUnwrap(),
    ).toEqual([{ ref: "SHOP-7", title: "Export", body: "CSV", labels: ["auto"] }]);
    expect(itemsFromResult("not json")._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
    expect(itemsFromResult('{"total":0}')._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  });
});

describe("McpCodeHost", () => {
  const servers: McpServers = {
    github: { command: "gh-mcp", args: [], env: {} },
    tracker: { url: "https://t", args: [], env: {} },
  };

  test("the server is the source's `mcp` name or its kind; the tool gets the list call; a caller's error is passed on", async () => {
    const calls: unknown[] = [];
    const host = new McpCodeHost(async () => ok(servers), {
      call: async (server, tool, args) => {
        calls.push([server.command ?? server.url, tool, args]);
        return tool === "boom" ? err(new MetatorError("COMMAND_FAILED", "down")) : ok(GITHUB);
      },
    });
    expect(
      (await host.listItems(source({ kind: "github", repo: "acme/shop" })))._unsafeUnwrap(),
    ).toHaveLength(2);
    await host.listItems(source({ kind: "jira", project: "SHOP", mcp: "tracker" }));
    expect(calls).toEqual([
      ["gh-mcp", "list_issues", { owner: "acme", repo: "shop", state: "open" }],
      ["https://t", "jira_search", { jql: 'project = "SHOP" AND statusCategory != Done' }],
    ]);
    expect((await host.listItems(source({ kind: "gitlab", repo: "a/b" })))._unsafeUnwrapErr().code).toBe(
      "NOT_FOUND",
    );
    expect(
      (await host.listItems(source({ kind: "github", repo: "a/b", tool: "boom" })))._unsafeUnwrapErr()
        .message,
    ).toBe("down");
  });

  test("a variable reference in a server's env comes from the environment; an unset one is empty", () => {
    const ref = (n: string) => `\${${n}}`;
    expect(
      resolveEnv({ TOKEN: ref("GH"), PLAIN: "x", BOTH: `a-${ref("NOPE")}-b` }, { GH: "secret" }),
    ).toEqual({
      TOKEN: "secret",
      PLAIN: "x",
      BOTH: "a--b",
    });
  });
});

// The contract over a real MCP server process (stdio), so the SDK path is the one under test.
const dir = mkdtempSync(join(tmpdir(), "metator-codehost-"));
const issues = join(dir, "issues.json");
writeFileSync(issues, GITHUB);
const FAKE = join(import.meta.dir, "../../../e2e/helpers/fake-mcp-server.ts");
codeHostContract(
  "McpCodeHost",
  () =>
    new McpCodeHost(
      async () => ok({ github: { command: "bun", args: [FAKE], env: { FAKE_MCP_ISSUES: issues } } }),
      new SdkToolCaller(dir),
    ),
  {
    source: source({ kind: "github", repo: "acme/shop" }),
    item: { ref: "12", title: "Total is negative" },
    missing: source({ kind: "jira", project: "SHOP" }),
  },
);
