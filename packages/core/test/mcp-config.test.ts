import { describe, expect, test } from "bun:test";
import { MetatorConfigDocument } from "../src/domain/config.ts";
import { mcpJson, mergeMcpServers } from "../src/domain/mcp.ts";
import { UserOptionsDocument } from "../src/domain/options.ts";

/** `${NAME}`: a reference the host resolves at start (never a token in a test or a file). */
const envRef = (name: string) => `\${${name}}`;

describe("mcp configuration (T1, design/14 §2)", () => {
  test("MetatorConfig v9 carries the repository's MCP servers; a v8 file upgrades with none", () => {
    const v8 = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 8, options: { "ui.attachOnType": true } },
      "x",
    )._unsafeUnwrap();
    expect(v8.mcp).toEqual({});
    const v9 = MetatorConfigDocument.parse(
      {
        kind: "MetatorConfig",
        schemaVersion: 9,
        mcp: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { TOKEN: envRef("GITHUB_TOKEN") },
          },
          jira: { url: "https://mcp.example.com/jira" },
        },
      },
      "x",
    )._unsafeUnwrap();
    expect(v9.mcp.github).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { TOKEN: envRef("GITHUB_TOKEN") },
    });
    expect(v9.mcp.jira).toEqual({ url: "https://mcp.example.com/jira", args: [], env: {} });
    // A server needs a command or a URL; a token value in the file is refused (names only, `${VAR}`).
    expect(
      MetatorConfigDocument.parse(
        { kind: "MetatorConfig", schemaVersion: 9, mcp: { x: { args: [] } } },
        "x",
      ).isErr(),
    ).toBe(true);
  });

  test("UserOptions v2 carries the person's MCP servers; a v1 file upgrades with none", () => {
    const v1 = UserOptionsDocument.parse(
      { kind: "UserOptions", schemaVersion: 1, options: {} },
      "x",
    )._unsafeUnwrap();
    expect(v1.mcp).toEqual({});
    const v2 = UserOptionsDocument.parse(
      { kind: "UserOptions", schemaVersion: 2, options: {}, mcp: { notes: { command: "notes-mcp" } } },
      "x",
    )._unsafeUnwrap();
    expect(v2.mcp.notes).toEqual({ command: "notes-mcp", args: [], env: {} });
  });

  test("the person's servers override the repository's by name; the host file keeps entries nobody configured", () => {
    const servers = mergeMcpServers(
      { github: { command: "npx", args: ["a"], env: {} }, jira: { url: "https://j", args: [], env: {} } },
      { github: { command: "gh-mcp", args: [], env: {} } },
    );
    expect(Object.keys(servers)).toEqual(["github", "jira"]);
    expect(servers.github?.command).toBe("gh-mcp");
    const existing = JSON.stringify({ mcpServers: { theirs: { command: "x" }, github: { command: "old" } } });
    const rendered = mcpJson(existing, servers)._unsafeUnwrap();
    expect(JSON.parse(rendered)).toEqual({
      mcpServers: {
        theirs: { command: "x" },
        github: { command: "gh-mcp" },
        jira: { url: "https://j" },
      },
    });
    expect(mcpJson("{not json", servers).isErr()).toBe(true);
    expect(JSON.parse(mcpJson(undefined, {})._unsafeUnwrap())).toEqual({ mcpServers: {} });
  });
});
