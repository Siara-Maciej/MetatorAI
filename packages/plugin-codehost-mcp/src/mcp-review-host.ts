import {
  err,
  type HostPullRequest,
  type HostThread,
  type McpServers,
  MetatorError,
  ok,
  type Result,
  type ReviewHost,
  type ReviewSource,
} from "@metator/core";
import type { McpToolCaller } from "./mcp-code-host.ts";

const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const login = (v: unknown): string =>
  text(v) ?? text((v as { login?: unknown })?.login) ?? text((v as { username?: unknown })?.username) ?? "";

function parse(payload: string): Result<unknown, MetatorError> {
  try {
    return ok(JSON.parse(payload) as unknown);
  } catch (e) {
    return err(
      new MetatorError("PARSE_FAILED", `the MCP server did not answer with JSON: ${(e as Error).message}`),
    );
  }
}

const listOf = (raw: unknown, ...keys: string[]): unknown[] | undefined => {
  if (Array.isArray(raw)) return raw;
  for (const k of keys) {
    const v = (raw as Record<string, unknown> | null)?.[k];
    if (Array.isArray(v)) return v;
    const nodes = (v as { nodes?: unknown } | undefined)?.nodes;
    if (Array.isArray(nodes)) return nodes;
  }
  return undefined;
};

/** The open requests of a repository as the host's JSON lists them (GitHub pulls, GitLab merge requests). */
export function pullRequestsFromResult(payload: string): Result<HostPullRequest[], MetatorError> {
  const raw = parse(payload);
  if (raw.isErr()) return err(raw.error);
  const list = listOf(raw.value, "pull_requests", "merge_requests", "items");
  if (!list)
    return err(new MetatorError("PARSE_FAILED", "the MCP server's answer holds no list of requests"));
  const out: HostPullRequest[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const number = Number(e?.number ?? e?.iid);
    const title = text(e?.title);
    if (!Number.isInteger(number) || number <= 0 || !title) continue;
    const branch = text((e.head as { ref?: unknown } | undefined)?.ref) ?? text(e.source_branch);
    const url = text(e.html_url) ?? text(e.web_url);
    const author = login(e.user ?? e.author);
    out.push({
      number,
      title,
      ...(branch ? { branch } : {}),
      ...(url ? { url } : {}),
      ...(author ? { author } : {}),
    });
  }
  return ok(out);
}

/** Review threads as the host's JSON lists them: GitHub's review threads, GitLab's discussions. */
export function threadsFromResult(payload: string): Result<HostThread[], MetatorError> {
  const raw = parse(payload);
  if (raw.isErr()) return err(raw.error);
  const list = listOf(raw.value, "threads", "reviewThreads", "review_threads", "discussions");
  if (!list) return err(new MetatorError("PARSE_FAILED", "the MCP server's answer holds no list of threads"));
  const out: HostThread[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const id = text(e?.id) ?? text(e?.node_id);
    const comments = listOf(e, "comments", "notes") ?? [];
    const first = (comments[0] ?? e) as Record<string, unknown>;
    const body = text(first.body);
    // A discussion without a reviewer's comment (a system note) is not a thread to answer.
    if (!id || body === undefined || first.system === true) continue;
    const position = (first.position ?? {}) as Record<string, unknown>;
    const file = text(first.path) ?? text(position.new_path);
    const line = Number(first.line ?? first.original_line ?? position.new_line);
    const commentId = text(first.id) ?? text(first.databaseId);
    out.push({
      id,
      ...(commentId && commentId !== id ? { commentId } : {}),
      author: login(first.author ?? first.user),
      ...(file ? { file } : {}),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      body,
      resolved: e.isResolved === true || e.is_resolved === true || e.resolved === true,
    });
  }
  return ok(out);
}

interface Call {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The tool calls per host; the names are those of the hosts' usual MCP servers. */
export function reviewCalls(source: ReviewSource): {
  list(): Call;
  threads(number: number): Call;
  reply(number: number, commentId: string, body: string): Call;
  resolve(number: number, threadId: string): Call;
} {
  if (source.kind === "github") {
    const [owner = "", repo = ""] = source.repo.split("/");
    return {
      list: () => ({ tool: "list_pull_requests", args: { owner, repo, state: "open" } }),
      threads: (pullNumber) => ({
        tool: "pull_request_read",
        args: { method: "get_review_comments", owner, repo, pullNumber },
      }),
      reply: (pullNumber, commentId, body) => ({
        tool: "add_reply_to_pull_request_comment",
        args: { owner, repo, pullNumber, commentId: Number(commentId) || commentId, body },
      }),
      resolve: (_n, threadId) => ({ tool: "resolve_review_thread", args: { threadId } }),
    };
  }
  const project_id = source.repo;
  return {
    list: () => ({ tool: "list_merge_requests", args: { project_id, state: "opened" } }),
    threads: (merge_request_iid) => ({ tool: "mr_discussions", args: { project_id, merge_request_iid } }),
    reply: (merge_request_iid, discussion_id, body) => ({
      tool: "create_merge_request_discussion_note",
      args: { project_id, merge_request_iid, discussion_id, body },
    }),
    resolve: (merge_request_iid, discussion_id) => ({
      tool: "resolve_merge_request_thread",
      args: { project_id, merge_request_iid, discussion_id, resolved: true },
    }),
  };
}

/** `ReviewHost` over the MCP servers configured in MetatorAI (T3, design/14 §4). */
export class McpReviewHost implements ReviewHost {
  constructor(
    private readonly servers: () => Promise<Result<McpServers, MetatorError>>,
    private readonly caller: McpToolCaller,
  ) {}

  async listPullRequests(source: ReviewSource): Promise<Result<readonly HostPullRequest[], MetatorError>> {
    const answered = await this.call(source, reviewCalls(source).list());
    return answered.isErr() ? err(answered.error) : pullRequestsFromResult(answered.value);
  }

  async listThreads(
    source: ReviewSource,
    number: number,
  ): Promise<Result<readonly HostThread[], MetatorError>> {
    const answered = await this.call(source, reviewCalls(source).threads(number));
    return answered.isErr() ? err(answered.error) : threadsFromResult(answered.value);
  }

  async reply(
    source: ReviewSource,
    number: number,
    threadId: string,
    body: string,
  ): Promise<Result<void, MetatorError>> {
    return (await this.call(source, reviewCalls(source).reply(number, threadId, body))).map(() => undefined);
  }

  async resolve(source: ReviewSource, number: number, threadId: string): Promise<Result<void, MetatorError>> {
    return (await this.call(source, reviewCalls(source).resolve(number, threadId))).map(() => undefined);
  }

  private async call(source: ReviewSource, call: Call): Promise<Result<string, MetatorError>> {
    const servers = await this.servers();
    if (servers.isErr()) return err(servers.error);
    const name = source.mcp ?? source.kind;
    const server = servers.value[name];
    if (!server)
      return err(
        new MetatorError("NOT_FOUND", `no MCP server named ${name} is configured`, {
          hint: "Add it under `mcp:` in metator.config.yml or ~/.config/metator/options.yml.",
        }),
      );
    return this.caller.call(server, call.tool, call.args);
  }
}
