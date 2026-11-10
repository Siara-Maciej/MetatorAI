/**
 * A stand-in for a code host's MCP server, over stdio: one tool, `list_issues`, that answers with
 * the JSON file named by FAKE_MCP_ISSUES (GitHub's shape). Used by the intake tests instead of a
 * real GitHub, GitLab or Jira.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
// Reviews of pull requests (T3): FAKE_MCP_PULLS names a JSON file `{ pulls: [...], threads: { "<number>": [...] } }`;
// replies and resolutions are appended to FAKE_MCP_LOG, one JSON line each, and change the file.
interface Pulls {
  pulls: unknown[];
  threads: Record<string, { id: string; isResolved?: boolean; comments: { id: number; body: string }[] }[]>;
}
const pulls = (): Pulls => JSON.parse(readFileSync(process.env.FAKE_MCP_PULLS ?? "", "utf8")) as Pulls;
const answer = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const log = (entry: object) =>
  appendFileSync(process.env.FAKE_MCP_LOG ?? "/dev/null", `${JSON.stringify(entry)}\n`);
const repoShape = { owner: z.string().optional(), repo: z.string().optional() };

server.registerTool(
  "list_pull_requests",
  {
    description: "Lists the open pull requests",
    inputSchema: { ...repoShape, state: z.string().optional() },
  },
  async () => answer(pulls().pulls),
);
server.registerTool(
  "pull_request_read",
  {
    description: "Reads a pull request",
    inputSchema: { ...repoShape, method: z.string(), pullNumber: z.number() },
  },
  async (input: { pullNumber: number }) =>
    answer({ threads: pulls().threads[String(input.pullNumber)] ?? [] }),
);
server.registerTool(
  "add_reply_to_pull_request_comment",
  {
    description: "Replies to a review comment",
    inputSchema: { ...repoShape, pullNumber: z.number(), commentId: z.number(), body: z.string() },
  },
  async (input: { pullNumber: number; commentId: number; body: string }) => {
    log({ reply: input.commentId, pull: input.pullNumber, body: input.body });
    return answer({ ok: true });
  },
);
server.registerTool(
  "resolve_review_thread",
  { description: "Resolves a review thread", inputSchema: { threadId: z.string() } },
  async (input: { threadId: string }) => {
    log({ resolve: input.threadId });
    const state = pulls();
    for (const list of Object.values(state.threads))
      for (const t of list) if (t.id === input.threadId) t.isResolved = true;
    writeFileSync(process.env.FAKE_MCP_PULLS ?? "", JSON.stringify(state));
    return answer({ ok: true });
  },
);
await server.connect(new StdioServerTransport());
