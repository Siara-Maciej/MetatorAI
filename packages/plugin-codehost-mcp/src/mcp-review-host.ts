import {
  err,
  type HostPullRequest,
  type HostPullRequestDetail,
  type HostReview,
  type HostThread,
  type McpServers,
  MetatorError,
  ok,
  type PostedReview,
  parseMrUrl,
  type Result,
  type ReviewerHost,
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
    const replies = (comments.slice(1) as Record<string, unknown>[])
      .filter((c) => c?.system !== true && text(c?.body) !== undefined)
      .map((c) => ({ author: login(c.author ?? c.user), body: text(c.body) as string }));
    out.push({
      id,
      ...(commentId && commentId !== id ? { commentId } : {}),
      author: login(first.author ?? first.user),
      ...(file ? { file } : {}),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      body,
      resolved: e.isResolved === true || e.is_resolved === true || e.resolved === true,
      ...(replies.length > 0 ? { replies } : {}),
    });
  }
  return ok(out);
}

/** A request as GitHub's or GitLab's JSON describes it (without its diff and threads). */
export function requestFromResult(
  payload: string,
): Result<Omit<HostPullRequestDetail, "diff" | "threads"> & { readonly baseSha?: string }, MetatorError> {
  const raw = parse(payload);
  if (raw.isErr()) return err(raw.error);
  const e = raw.value as Record<string, unknown>;
  const number = Number(e?.number ?? e?.iid);
  const title = text(e?.title);
  const head = e?.head as { ref?: unknown; sha?: unknown } | undefined;
  const base = e?.base as { ref?: unknown; sha?: unknown } | undefined;
  const refs = e?.diff_refs as { base_sha?: unknown; head_sha?: unknown } | undefined;
  const headSha = text(head?.sha) ?? text(e?.sha) ?? text(refs?.head_sha);
  if (!Number.isInteger(number) || number <= 0 || !title || !headSha)
    return err(new MetatorError("PARSE_FAILED", "the MCP server's answer is no pull or merge request"));
  const merged = e.merged === true || e.merged_at != null || e.state === "merged";
  const closed = e.state === "closed" || e.state === "locked";
  const baseSha = text(base?.sha) ?? text(refs?.base_sha);
  return ok({
    number,
    title,
    url: text(e.html_url) ?? text(e.web_url) ?? "",
    author: login(e.user ?? e.author),
    base: text(base?.ref) ?? text(e.target_branch) ?? "",
    head: text(head?.ref) ?? text(e.source_branch) ?? "",
    headSha,
    state: merged ? "merged" : closed ? "closed" : "open",
    ...(baseSha ? { baseSha } : {}),
  });
}

/**
 * A request's diff as the server gives it: GitHub's unified diff text, or GitLab's list of file
 * diffs (put in `diff --git` form).
 */
export function diffFromResult(payload: string): string {
  if (
    /^diff --git /m.test(payload) &&
    !payload.trimStart().startsWith("[") &&
    !payload.trimStart().startsWith("{")
  )
    return payload;
  const raw = parse(payload);
  if (raw.isErr()) return payload;
  const list = listOf(raw.value, "changes", "diffs", "files") ?? [];
  const out: string[] = [];
  for (const f of list as Record<string, unknown>[]) {
    const from = text(f?.old_path) ?? text(f?.filename);
    const to = text(f?.new_path) ?? text(f?.filename);
    const body = text(f?.diff) ?? text(f?.patch);
    if (!from || !to || body === undefined) continue;
    out.push(`diff --git a/${from} b/${to}`);
    if (f.new_file === true) out.push("new file mode 100644", "--- /dev/null");
    else out.push(`--- a/${from}`);
    out.push(f.deleted_file === true ? "+++ /dev/null" : `+++ b/${to}`, body.replace(/\n$/, ""));
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
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
  request(number: number): Call;
  diff(number: number): Call;
  requested(): Call | undefined;
  /** The calls that post a review, in order. */
  publish(number: number, review: HostReview, baseSha?: string): Call[];
  approve(number: number, body?: string): Call;
} {
  if (source.kind === "github") {
    const [owner = "", repo = ""] = source.repo.split("/");
    const read = (method: string, pullNumber: number): Call => ({
      tool: "pull_request_read",
      args: { method, owner, repo, pullNumber },
    });
    return {
      request: (n) => read("get", n),
      diff: (n) => read("get_diff", n),
      requested: () => ({
        tool: "search_pull_requests",
        args: { query: `repo:${source.repo} is:open review-requested:@me` },
      }),
      // A pending review, its comments on lines, then the review submitted with its body.
      publish: (pullNumber, review) => [
        {
          tool: "pull_request_review_write",
          args: { method: "create", owner, repo, pullNumber, commitID: review.headSha },
        },
        ...review.comments.map((c) => ({
          tool: "add_comment_to_pending_review",
          args: {
            owner,
            repo,
            pullNumber,
            path: c.file,
            line: c.line,
            side: "RIGHT",
            subjectType: "LINE",
            body: c.body,
          },
        })),
        {
          tool: "pull_request_review_write",
          args: { method: "submit_pending", owner, repo, pullNumber, body: review.body, event: "COMMENT" },
        },
      ],
      approve: (pullNumber, body) => ({
        tool: "pull_request_review_write",
        args: { method: "create", owner, repo, pullNumber, event: "APPROVE", ...(body ? { body } : {}) },
      }),
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
    request: (merge_request_iid) => ({ tool: "get_merge_request", args: { project_id, merge_request_iid } }),
    diff: (merge_request_iid) => ({
      tool: "get_merge_request_diffs",
      args: { project_id, merge_request_iid },
    }),
    // GitLab knows no "me" in a filter: the source's author is the person.
    requested: () =>
      source.author
        ? {
            tool: "list_merge_requests",
            args: { project_id, state: "opened", reviewer_username: source.author },
          }
        : undefined,
    publish: (merge_request_iid, review, baseSha) => [
      ...review.comments.map((c) => ({
        tool: "create_merge_request_thread",
        args: {
          project_id,
          merge_request_iid,
          body: c.body,
          position: {
            position_type: "text",
            base_sha: baseSha ?? review.headSha,
            start_sha: baseSha ?? review.headSha,
            head_sha: review.headSha,
            new_path: c.file,
            new_line: c.line,
          },
        },
      })),
      { tool: "create_merge_request_note", args: { project_id, merge_request_iid, body: review.body } },
    ],
    approve: (merge_request_iid) => ({
      tool: "approve_merge_request",
      args: { project_id, merge_request_iid },
    }),
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
export class McpReviewHost implements ReviewHost, ReviewerHost {
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

  async openFromUrl(url: string, source: ReviewSource): Promise<Result<HostPullRequestDetail, MetatorError>> {
    const ref = parseMrUrl(url);
    if (ref.isErr()) return err(ref.error);
    const calls = reviewCalls(source);
    const request = await this.call(source, calls.request(ref.value.number));
    if (request.isErr()) return err(request.error);
    const read = requestFromResult(request.value);
    if (read.isErr()) return err(read.error);
    const diff = await this.call(source, calls.diff(ref.value.number));
    if (diff.isErr()) return err(diff.error);
    const threads = await this.listThreads(source, ref.value.number);
    if (threads.isErr()) return err(threads.error);
    const { baseSha: _b, ...detail } = read.value;
    return ok({
      ...detail,
      url: detail.url || ref.value.url,
      diff: diffFromResult(diff.value),
      threads: threads.value,
    });
  }

  async requested(source: ReviewSource): Promise<Result<readonly HostPullRequest[], MetatorError>> {
    const call = reviewCalls(source).requested();
    if (!call)
      return err(
        MetatorError.usage(
          `${source.kind}:${source.repo}: name yourself as the source's author to find the requests you are asked to review`,
        ),
      );
    const answered = await this.call(source, call);
    return answered.isErr() ? err(answered.error) : pullRequestsFromResult(answered.value);
  }

  async publish(
    source: ReviewSource,
    number: number,
    review: HostReview,
  ): Promise<Result<PostedReview, MetatorError>> {
    let baseSha: string | undefined;
    if (source.kind === "gitlab" && review.comments.length > 0) {
      const request = await this.call(source, reviewCalls(source).request(number));
      if (request.isErr()) return err(request.error);
      const read = requestFromResult(request.value);
      if (read.isOk()) baseSha = read.value.baseSha;
    }
    for (const call of reviewCalls(source).publish(number, review, baseSha)) {
      const posted = await this.call(source, call);
      if (posted.isErr()) return err(posted.error);
    }
    return postedFrom(review, await this.listThreads(source, number));
  }

  async approve(source: ReviewSource, number: number, body?: string): Promise<Result<void, MetatorError>> {
    return (await this.call(source, reviewCalls(source).approve(number, body))).map(() => undefined);
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

/**
 * The posted comments' ids, read back from the request's threads (a host answers a posted review
 * without them): each comment is the thread on its file and line whose first words are its body.
 */
export function postedFrom(
  review: HostReview,
  threads: Result<readonly HostThread[], MetatorError>,
): Result<PostedReview, MetatorError> {
  const listed = threads.isOk() ? threads.value : [];
  return ok({
    comments: review.comments.map((c, i) => {
      const t = listed.find((x) => x.file === c.file && x.line === c.line && x.body.trim() === c.body.trim());
      return t ? { hostId: t.commentId ?? t.id, threadId: t.id } : { hostId: `posted-${i + 1}` };
    }),
  });
}
