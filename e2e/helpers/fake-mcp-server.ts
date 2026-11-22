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
// Review from a link (ADR-0097): `diffs: { "<number>": "<unified diff>" }`, `requested: [<number>]` (I am a
// requested reviewer); a posted review's comments become threads of the request, an approval is logged.
interface Comment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  author?: { login: string };
}
interface Pulls {
  pulls: { number: number }[];
  threads: Record<string, { id: string; isResolved?: boolean; comments: Comment[] }[]>;
  diffs?: Record<string, string>;
  requested?: number[];
  pending?: Record<string, Comment[]>;
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
  async (input: { method: string; pullNumber: number }) => {
    const state = pulls();
    if (input.method === "get") return answer(state.pulls.find((p) => p.number === input.pullNumber) ?? {});
    if (input.method === "get_diff")
      return { content: [{ type: "text" as const, text: state.diffs?.[String(input.pullNumber)] ?? "" }] };
    return answer({ threads: state.threads[String(input.pullNumber)] ?? [] });
  },
);
server.registerTool(
  "search_pull_requests",
  { description: "Searches pull requests", inputSchema: { query: z.string() } },
  async (input: { query: string }) => {
    const state = pulls();
    const asked = input.query.includes("review-requested:@me") ? (state.requested ?? []) : [];
    return answer({ items: state.pulls.filter((p) => asked.includes(p.number)) });
  },
);
server.registerTool(
  "pull_request_review_write",
  {
    description: "Creates, submits or approves a review",
    inputSchema: {
      ...repoShape,
      method: z.string(),
      pullNumber: z.number(),
      body: z.string().optional(),
      event: z.string().optional(),
      commitID: z.string().optional(),
    },
  },
  async (input: {
    method: string;
    pullNumber: number;
    body?: string | undefined;
    event?: string | undefined;
  }) => {
    const state = pulls();
    const key = String(input.pullNumber);
    if (input.event === "APPROVE")
      log({ approve: input.pullNumber, ...(input.body ? { body: input.body } : {}) });
    else if (input.method === "create") state.pending = { ...state.pending, [key]: [] };
    else if (input.method === "submit_pending") {
      const posted = state.pending?.[key] ?? [];
      state.threads[key] = [
        ...(state.threads[key] ?? []),
        ...posted.map((c) => ({ id: `RT${c.id}`, isResolved: false, comments: [c] })),
      ];
      if (state.pending) delete state.pending[key];
      log({ review: input.pullNumber, event: input.event, body: input.body, comments: posted.length });
    }
    writeFileSync(process.env.FAKE_MCP_PULLS ?? "", JSON.stringify(state));
    return answer({ ok: true });
  },
);
server.registerTool(
  "add_comment_to_pending_review",
  {
    description: "Adds a comment on a line to the pending review",
    inputSchema: {
      ...repoShape,
      pullNumber: z.number(),
      path: z.string(),
      line: z.number(),
      side: z.string().optional(),
      subjectType: z.string().optional(),
      body: z.string(),
    },
  },
  async (input: { pullNumber: number; path: string; line: number; body: string }) => {
    const state = pulls();
    const key = String(input.pullNumber);
    const list = state.pending?.[key];
    if (!list) return { isError: true, content: [{ type: "text" as const, text: "no pending review" }] };
    const id = 7000 + Object.values(state.threads).flat().length + list.length;
    list.push({ id, body: input.body, path: input.path, line: input.line, author: { login: "metator-bot" } });
    writeFileSync(process.env.FAKE_MCP_PULLS ?? "", JSON.stringify(state));
    log({ inline: input.pullNumber, path: input.path, line: input.line, body: input.body });
    return answer({ ok: true });
  },
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
