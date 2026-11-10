/**
 * A stand-in for a code host's MCP server, over stdio: one tool, `list_issues`, that answers with
 * the JSON file named by FAKE_MCP_ISSUES (GitHub's shape). Used by the intake tests instead of a
 * real GitHub, GitLab or Jira.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-code-host", version: "1" });
server.registerTool(
  "list_issues",
  {
    description: "Lists the issues of a repository",
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      state: z.string().optional(),
      labels: z.array(z.string()).optional(),
    },
  },
  async (input: { labels?: string[] | undefined }) => {
    const all = JSON.parse(readFileSync(process.env.FAKE_MCP_ISSUES ?? "", "utf8")) as {
      labels?: { name: string }[];
    }[];
    const wanted = input.labels ?? [];
    const listed = all.filter((i) => wanted.every((l) => (i.labels ?? []).some((x) => x.name === l)));
    return { content: [{ type: "text" as const, text: JSON.stringify(listed) }] };
  },
);
await server.connect(new StdioServerTransport());
