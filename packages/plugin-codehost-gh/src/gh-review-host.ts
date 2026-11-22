import {
  err,
  type HostPullRequest,
  type HostPullRequestDetail,
  type HostReview,
  type HostThread,
  MetatorError,
  ok,
  type PostedReview,
  type ProcessRunner,
  type Result,
  type ReviewerHost,
  type ReviewHost,
  type ReviewSource,
} from "@metator/core";

const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const login = (v: unknown): string => text((v as { login?: unknown } | undefined)?.login) ?? "";

function parse(payload: string): Result<unknown, MetatorError> {
  try {
    return ok(JSON.parse(payload) as unknown);
  } catch (e) {
    return err(new MetatorError("PARSE_FAILED", `gh did not answer with JSON: ${(e as Error).message}`));
  }
}

const PR_FIELDS = "number,title,headRefName,url,author";

/** `gh pr list --json …`: the requests as `HostPullRequest`s; what has no number or title is left out. */
export function requestsFromGh(payload: string): Result<HostPullRequest[], MetatorError> {
  const raw = parse(payload);
  if (raw.isErr()) return err(raw.error);
  if (!Array.isArray(raw.value))
    return err(new MetatorError("PARSE_FAILED", "gh's answer is no list of requests"));
  const out: HostPullRequest[] = [];
  for (const e of raw.value as Record<string, unknown>[]) {
    const number = Number(e?.number);
    const title = text(e?.title);
    if (!Number.isInteger(number) || number <= 0 || !title) continue;
    const branch = text(e.headRefName);
    const url = text(e.url);
    const author = login(e.author);
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

/** The review threads of `gh api graphql` (`repository.pullRequest.reviewThreads.nodes`). */
export function threadsFromGh(payload: string): Result<HostThread[], MetatorError> {
  const raw = parse(payload);
  if (raw.isErr()) return err(raw.error);
  const nodes = (
    raw.value as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } | null } | null };
    }
  )?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes))
    return err(new MetatorError("PARSE_FAILED", "gh's answer holds no review threads"));
  const out: HostThread[] = [];
  for (const t of nodes as Record<string, unknown>[]) {
    const id = text(t?.id);
    const comments = ((t?.comments as { nodes?: unknown } | undefined)?.nodes ?? []) as Record<
      string,
      unknown
    >[];
    const first = comments[0];
    const body = text(first?.body);
    if (!id || !first || body === undefined) continue;
    const file = text(first.path);
    const line = Number(first.line ?? first.originalLine);
    const commentId = text(first.databaseId);
    const replies = comments
      .slice(1)
      .flatMap((c) =>
        text(c?.body) === undefined ? [] : [{ author: login(c.author), body: text(c.body) as string }],
      );
    out.push({
      id,
      ...(commentId ? { commentId } : {}),
      author: login(first.author),
      ...(file ? { file } : {}),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      body,
      resolved: t.isResolved === true,
      ...(replies.length > 0 ? { replies } : {}),
    });
  }
  return ok(out);
}

/** `gh pr view --json …`: the request without its diff and threads. */
export function requestFromGh(
  payload: string,
): Result<Omit<HostPullRequestDetail, "diff" | "threads">, MetatorError> {
  const raw = parse(payload);
  if (raw.isErr()) return err(raw.error);
  const e = raw.value as Record<string, unknown>;
  const number = Number(e?.number);
  const title = text(e?.title);
  const headSha = text(e?.headRefOid);
  if (!Number.isInteger(number) || number <= 0 || !title || !headSha)
    return err(new MetatorError("PARSE_FAILED", "gh's answer is no pull request"));
  const state = String(e.state ?? "OPEN").toUpperCase();
  const commits = Array.isArray(e.commits)
    ? (e.commits as Record<string, unknown>[]).flatMap((c) => (text(c?.oid) ? [text(c.oid) as string] : []))
    : undefined;
  return ok({
    number,
    title,
    url: text(e.url) ?? "",
    author: login(e.author),
    base: text(e.baseRefName) ?? "",
    head: text(e.headRefName) ?? "",
    headSha,
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    ...(commits ? { commits } : {}),
  });
}

const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId body path line originalLine author{login}}}}}}}}";
const RESOLVE_MUTATION = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}";

/** The `gh` argument lists per operation; `gh` itself talks to GitHub with its own login. */
export function ghCalls(source: ReviewSource): {
  list(): string[];
  requested(): string[];
  threads(number: number): string[];
  reply(number: number, commentId: string, body: string): string[];
  resolve(threadId: string): string[];
  view(url: string): string[];
  diff(url: string): string[];
  publish(number: number, review: HostReview): string[];
  approve(number: number, body?: string): string[];
} {
  const [owner = "", name = ""] = source.repo.split("/");
  const repo = ["-R", source.repo];
  return {
    list: () => ["pr", "list", ...repo, "--state", "open", "--limit", "100", "--json", PR_FIELDS],
    requested: () => [
      "pr",
      "list",
      ...repo,
      "--state",
      "open",
      "--search",
      "review-requested:@me",
      "--limit",
      "100",
      "--json",
      PR_FIELDS,
    ],
    threads: (number) => [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ],
    reply: (number, commentId, body) => [
      "api",
      "-X",
      "POST",
      `repos/${source.repo}/pulls/${number}/comments/${commentId}/replies`,
      "-f",
      `body=${body}`,
    ],
    resolve: (threadId) => ["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `id=${threadId}`],
    view: (url) => [
      "pr",
      "view",
      url,
      "--json",
      "number,title,url,author,baseRefName,headRefName,headRefOid,state,commits",
    ],
    diff: (url) => ["pr", "diff", url, "--color", "never"],
    // One review in one call: its body and every comment on a line (`comments[][…]`, gh's array form).
    publish: (number, review) => [
      "api",
      "-X",
      "POST",
      `repos/${source.repo}/pulls/${number}/reviews`,
      "-f",
      `body=${review.body}`,
      "-f",
      "event=COMMENT",
      "-f",
      `commit_id=${review.headSha}`,
      ...review.comments.flatMap((c) => [
        "-f",
        `comments[][path]=${c.file}`,
        "-F",
        `comments[][line]=${c.line}`,
        "-f",
        "comments[][side]=RIGHT",
        "-f",
        `comments[][body]=${c.body}`,
      ]),
    ],
    approve: (number, body) => [
      "pr",
      "review",
      String(number),
      ...repo,
      "--approve",
      ...(body ? ["--body", body] : []),
    ],
  };
}

/**
 * `ReviewHost` and `ReviewerHost` over GitHub's `gh` CLI (ADR-0097), run through the process
 * runner: GitHub only, with gh's own login (no token in MetatorAI). A failing `gh` is an error
 * value naming its first line of stderr.
 */
export class GhReviewHost implements ReviewHost, ReviewerHost {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: { readonly command: string; readonly cwd: string },
  ) {}

  /** Whether `gh` runs here and is logged in; its version line (a stand-in says so in it). */
  /**
   * `standIn`: only a stand-in that says so in its version line counts (while real hosts are
   * refused); a real gh is then never asked anything that could reach GitHub (`auth status` can).
   */
  async status(
    options: { readonly standIn?: boolean } = {},
  ): Promise<{ readonly ready: boolean; readonly version?: string }> {
    const version = await this.runner.run({
      argv: [this.options.command, "--version"],
      cwd: this.options.cwd,
    });
    if (version.exitCode !== 0) return { ready: false };
    const line = version.stdout.split("\n")[0]?.trim() ?? "";
    if (options.standIn && !line.includes("stand-in")) return { ready: false, version: line };
    const auth = await this.runner.run({
      argv: [this.options.command, "auth", "status"],
      cwd: this.options.cwd,
    });
    return { ready: auth.exitCode === 0, version: line };
  }

  async listPullRequests(source: ReviewSource): Promise<Result<readonly HostPullRequest[], MetatorError>> {
    return (await this.gh(source, ghCalls(source).list())).andThen(requestsFromGh);
  }

  async listThreads(
    source: ReviewSource,
    number: number,
  ): Promise<Result<readonly HostThread[], MetatorError>> {
    return (await this.gh(source, ghCalls(source).threads(number))).andThen(threadsFromGh);
  }

  async reply(
    source: ReviewSource,
    number: number,
    threadId: string,
    body: string,
  ): Promise<Result<void, MetatorError>> {
    return (await this.gh(source, ghCalls(source).reply(number, threadId, body))).map(() => undefined);
  }

  async resolve(
    source: ReviewSource,
    _number: number,
    threadId: string,
  ): Promise<Result<void, MetatorError>> {
    return (await this.gh(source, ghCalls(source).resolve(threadId))).map(() => undefined);
  }

  async openFromUrl(url: string, source: ReviewSource): Promise<Result<HostPullRequestDetail, MetatorError>> {
    const calls = ghCalls(source);
    const viewed = (await this.gh(source, calls.view(url))).andThen(requestFromGh);
    if (viewed.isErr()) return err(viewed.error);
    const diff = await this.gh(source, calls.diff(url));
    if (diff.isErr()) return err(diff.error);
    const threads = await this.listThreads(source, viewed.value.number);
    if (threads.isErr()) return err(threads.error);
    return ok({ ...viewed.value, url: viewed.value.url || url, diff: diff.value, threads: threads.value });
  }

  async requested(source: ReviewSource): Promise<Result<readonly HostPullRequest[], MetatorError>> {
    return (await this.gh(source, ghCalls(source).requested())).andThen(requestsFromGh);
  }

  async publish(
    source: ReviewSource,
    number: number,
    review: HostReview,
  ): Promise<Result<PostedReview, MetatorError>> {
    const posted = await this.gh(source, ghCalls(source).publish(number, review));
    if (posted.isErr()) return err(posted.error);
    const threads = await this.listThreads(source, number);
    const listed = threads.isOk() ? threads.value : [];
    const body = parse(posted.value);
    const bodyId = body.isOk() ? text((body.value as { id?: unknown } | null)?.id) : undefined;
    return ok({
      comments: review.comments.map((c, i) => {
        const t = listed.find(
          (x) => x.file === c.file && x.line === c.line && x.body.trim() === c.body.trim(),
        );
        return t ? { hostId: t.commentId ?? t.id, threadId: t.id } : { hostId: `posted-${i + 1}` };
      }),
      ...(bodyId ? { bodyId } : {}),
    });
  }

  async approve(source: ReviewSource, number: number, body?: string): Promise<Result<void, MetatorError>> {
    return (await this.gh(source, ghCalls(source).approve(number, body))).map(() => undefined);
  }

  private async gh(source: ReviewSource, args: readonly string[]): Promise<Result<string, MetatorError>> {
    if (source.kind !== "github")
      return err(
        MetatorError.usage(`gh reads GitHub only: ${source.kind}:${source.repo} is read through MCP`),
      );
    const r = await this.runner.run(
      { argv: [this.options.command, ...args], cwd: this.options.cwd },
      { timeoutMs: 60_000 },
    );
    if (r.exitCode === 0) return ok(r.stdout);
    const why = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
    return err(
      new MetatorError(
        r.exitCode === 127 ? "BIN_NOT_FOUND" : "COMMAND_FAILED",
        `gh ${args.slice(0, 2).join(" ")}: ${why}`,
        {
          hint: "Is gh installed and logged in (`gh auth status`)?",
        },
      ),
    );
  }
}
