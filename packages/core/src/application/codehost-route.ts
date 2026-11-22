import type { CodeHostSource } from "../domain/codehost.ts";
import type { MetatorError } from "../domain/errors.ts";
import type { Result } from "../domain/result.ts";
import type {
  HostPullRequest,
  HostPullRequestDetail,
  HostReview,
  HostThread,
  PostedReview,
  ReviewSource,
} from "../domain/review-thread.ts";
import type { ReviewerHost, ReviewHost } from "../ports/index.ts";

/**
 * The code-host port over both adapters (ADR-0097): a source goes to the tool `codehost.sources`
 * names for its repository (`gh`, or an MCP server); anything else to the MCP servers, as before.
 */
export class RoutedReviewHost implements ReviewHost, ReviewerHost {
  constructor(
    private readonly sources: readonly CodeHostSource[],
    private readonly hosts: {
      readonly mcp: ReviewHost & ReviewerHost;
      readonly gh: ReviewHost & ReviewerHost;
    },
  ) {}

  /** The adapter for a source: gh when its configured source says so. */
  adapterFor(source: Pick<ReviewSource, "kind" | "repo" | "mcp">): ReviewHost & ReviewerHost {
    const configured = this.sources.find(
      (s) => s.kind === source.kind && s.repo?.toLowerCase() === source.repo.toLowerCase(),
    );
    return configured?.via === "gh" && source.mcp === undefined ? this.hosts.gh : this.hosts.mcp;
  }

  listPullRequests(source: ReviewSource): Promise<Result<readonly HostPullRequest[], MetatorError>> {
    return this.adapterFor(source).listPullRequests(source);
  }
  listThreads(source: ReviewSource, number: number): Promise<Result<readonly HostThread[], MetatorError>> {
    return this.adapterFor(source).listThreads(source, number);
  }
  reply(
    source: ReviewSource,
    number: number,
    threadId: string,
    text: string,
  ): Promise<Result<void, MetatorError>> {
    return this.adapterFor(source).reply(source, number, threadId, text);
  }
  resolve(source: ReviewSource, number: number, threadId: string): Promise<Result<void, MetatorError>> {
    return this.adapterFor(source).resolve(source, number, threadId);
  }
  openFromUrl(url: string, source: ReviewSource): Promise<Result<HostPullRequestDetail, MetatorError>> {
    return this.adapterFor(source).openFromUrl(url, source);
  }
  requested(source: ReviewSource): Promise<Result<readonly HostPullRequest[], MetatorError>> {
    return this.adapterFor(source).requested(source);
  }
  publish(
    source: ReviewSource,
    number: number,
    review: HostReview,
  ): Promise<Result<PostedReview, MetatorError>> {
    return this.adapterFor(source).publish(source, number, review);
  }
  approve(source: ReviewSource, number: number, body?: string): Promise<Result<void, MetatorError>> {
    return this.adapterFor(source).approve(source, number, body);
  }
}
