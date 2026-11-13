import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  mergeThreads,
  type PullRequestReview,
  PullRequestReviewDocument,
  type ReviewsConfig,
  reviewId,
  reviewTask,
  type ThreadKind,
  type ThreadState,
} from "../domain/review-thread.ts";
import type { Clock, FileSystem, ReviewHost } from "../ports/index.ts";
import { loadDocument, writeDocument } from "./document-io.ts";
import type { Notifier } from "./notifier.ts";
import type { MetatorPaths } from "./paths.ts";
import type { InitRun } from "./runs.ts";

export interface MyReviewsDependencies {
  readonly config: ReviewsConfig;
  readonly fs: FileSystem;
  readonly paths: Pick<MetatorPaths, "mrs">;
  readonly clock: Clock;
  readonly host: ReviewHost;
  readonly initRun: Pick<InitRun, "execute">;
  /** Whether a run still goes on (a request has one answering run at a time). */
  readonly runActive: (runId: string) => Promise<boolean>;
  /** Tells the person about a review with new threads; none means no notifications. */
  readonly notifier?: Pick<Notifier, "review">;
  /** Whether a run finished as done: its change is committed and pushed (the publish gate). */
  readonly runDone: (runId: string) => Promise<boolean>;
}

export interface ReviewScanReport {
  readonly requests: readonly {
    readonly id: string;
    readonly number: number;
    readonly open: number;
    /** Threads seen for the first time in this scan. */
    readonly fresh: readonly string[];
    /** The run this scan started for the request. */
    readonly started?: string;
    /** Planned threads this scan marked fixed: the run that answered them is done. */
    readonly fixed?: readonly string[];
  }[];
  /** Sources or requests that could not be read; the others are scanned all the same. */
  readonly errors: readonly string[];
}

/**
 * Reviews of my own requests (T3, design/14 §4): `scan` keeps each request's threads in
 * `.metator/mrs/` and starts the answering run when new open threads arrive and none goes on;
 * `triage` records what the agent made of a thread; `send` and `resolve` change the host and
 * need a person's name. A reviewer's words are data, never instructions.
 */
export class MyReviews {
  constructor(private readonly d: MyReviewsDependencies) {}

  async scan(): Promise<Result<ReviewScanReport, MetatorError>> {
    const requests: ReviewScanReport["requests"][number][] = [];
    const errors: string[] = [];
    for (const source of this.d.config.sources) {
      const listed = await this.d.host.listPullRequests(source);
      if (listed.isErr()) {
        errors.push(`${source.kind}:${source.repo}: ${listed.error.message}`);
        continue;
      }
      const mine = listed.value.filter((p) => !source.author || p.author === source.author);
      for (const pr of mine) {
        const threads = await this.d.host.listThreads(source, pr.number);
        if (threads.isErr()) {
          errors.push(`${source.kind}:${source.repo}#${pr.number}: ${threads.error.message}`);
          continue;
        }
        const id = reviewId(source, pr.number);
        const kept = await this.read(id);
        const now = this.d.clock.now().toISOString();
        const merged = mergeThreads(kept?.threads ?? [], threads.value, now);
        // A request nobody reviewed is not kept.
        if (!kept && merged.threads.length === 0) continue;
        // What the plan covered is fixed once the answering run is done: its change is pushed.
        const pushed = kept?.runId !== undefined && (await this.d.runDone(kept.runId));
        const fixed = pushed ? merged.threads.filter((t) => t.state === "planned").map((t) => t.id) : [];
        const settled = merged.threads.map((t) =>
          fixed.includes(t.id) ? { ...t, state: "fixed" as const } : t,
        );
        let review: PullRequestReview = {
          source,
          number: pr.number,
          title: pr.title,
          ...(pr.branch ? { branch: pr.branch } : {}),
          ...(pr.url ? { url: pr.url } : {}),
          threads: settled,
          ...(kept?.runId ? { runId: kept.runId } : {}),
          updatedAt: now,
        };
        let started: string | undefined;
        const busy = review.runId !== undefined && (await this.d.runActive(review.runId));
        if (merged.fresh.length > 0 && !busy) {
          const run = await this.d.initRun.execute({
            workflow: this.d.config.workflow,
            task: reviewTask(id, review),
            // The answer is written on the request's own branch, in its own worktree.
            worktree: pr.branch ? { base: pr.branch } : {},
          });
          if (run.isErr()) errors.push(`${source.kind}:${source.repo}#${pr.number}: ${run.error.message}`);
          else {
            started = run.value.runId;
            review = { ...review, runId: started };
          }
        }
        const saved = await this.write(id, review);
        if (saved.isErr()) return err(saved.error);
        if (merged.fresh.length > 0 && this.d.notifier) {
          // Once per thread: a thread is new in one scan only.
          const failed = await this.d.notifier.review({
            id,
            number: pr.number,
            title: pr.title,
            ...(pr.url ? { url: pr.url } : {}),
            fresh: merged.fresh.length,
          });
          if (failed) errors.push(failed);
        }
        requests.push({
          id,
          number: pr.number,
          open: review.threads.filter((t) => t.state === "open").length,
          fresh: merged.fresh,
          ...(started ? { started } : {}),
          ...(fixed.length > 0 ? { fixed } : {}),
        });
      }
    }
    return ok({ requests, errors });
  }

  async list(): Promise<Result<readonly (PullRequestReview & { readonly id: string })[], MetatorError>> {
    const out: (PullRequestReview & { id: string })[] = [];
    for (const file of [...(await this.d.fs.glob([`${this.d.paths.mrs}/*.json`]))].sort()) {
      const id = file.slice(file.lastIndexOf("/") + 1).replace(/\.json$/, "");
      const review = await this.read(id);
      if (review) out.push({ id, ...review });
    }
    return ok(out);
  }

  async show(id: string): Promise<Result<PullRequestReview & { readonly id: string }, MetatorError>> {
    const review = await this.read(id);
    return review
      ? ok({ id, ...review })
      : err(MetatorError.notFound(`review ${id}`, { hint: "`metator mrs list` shows the requests." }));
  }

  /** What the agent made of a thread: its kind, a proposed reply, whether the plan covers it. */
  async triage(
    id: string,
    threadId: string,
    patch: { readonly kind?: ThreadKind; readonly reply?: string; readonly state?: ThreadState },
  ): Promise<Result<PullRequestReview, MetatorError>> {
    return this.update(id, threadId, (t) => ({
      ...t,
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.reply !== undefined ? { reply: patch.reply } : {}),
      ...(patch.state ? { state: patch.state } : {}),
    }));
  }

  /** Posts every proposed reply that was not sent yet; the person who says so is named. */
  async send(
    id: string,
    input: { readonly by: string },
  ): Promise<Result<{ readonly sent: readonly string[] }, MetatorError>> {
    if (input.by.trim() === "") return err(MetatorError.usage("say who sends the replies: --by <name>"));
    const review = await this.show(id);
    if (review.isErr()) return err(review.error);
    const sent: string[] = [];
    let threads = review.value.threads;
    for (const t of review.value.threads) {
      if (!t.reply || t.repliedAt || t.state === "resolved") continue;
      const posted = await this.d.host.reply(
        review.value.source,
        review.value.number,
        t.commentId ?? t.id,
        t.reply,
      );
      if (posted.isErr()) return err(posted.error);
      sent.push(t.id);
      const at = this.d.clock.now().toISOString();
      threads = threads.map((x) =>
        x.id === t.id
          ? { ...x, repliedAt: at, state: x.state === "open" ? ("answered" as const) : x.state }
          : x,
      );
    }
    const saved = await this.write(id, this.strip({ ...review.value, threads }));
    if (saved.isErr()) return err(saved.error);
    return ok({ sent });
  }

  /** Closes a thread at the host; the person who says so is named. */
  async resolve(
    id: string,
    threadId: string,
    input: { readonly by: string },
  ): Promise<Result<PullRequestReview, MetatorError>> {
    if (input.by.trim() === "") return err(MetatorError.usage("say who resolves the thread: --by <name>"));
    const review = await this.show(id);
    if (review.isErr()) return err(review.error);
    if (!review.value.threads.some((t) => t.id === threadId))
      return err(MetatorError.notFound(`thread ${threadId} of ${id}`));
    const closed = await this.d.host.resolve(review.value.source, review.value.number, threadId);
    if (closed.isErr()) return err(closed.error);
    return this.update(id, threadId, (t) => ({ ...t, state: "resolved" }));
  }

  private async update(
    id: string,
    threadId: string,
    change: (t: PullRequestReview["threads"][number]) => PullRequestReview["threads"][number],
  ): Promise<Result<PullRequestReview, MetatorError>> {
    const review = await this.show(id);
    if (review.isErr()) return err(review.error);
    if (!review.value.threads.some((t) => t.id === threadId))
      return err(MetatorError.notFound(`thread ${threadId} of ${id}`));
    const next = this.strip({
      ...review.value,
      threads: review.value.threads.map((t) => (t.id === threadId ? change(t) : t)),
      updatedAt: this.d.clock.now().toISOString(),
    });
    const saved = await this.write(id, next);
    return saved.map(() => next);
  }

  private strip(review: PullRequestReview & { readonly id?: string }): PullRequestReview {
    const { id: _id, ...rest } = review;
    return rest;
  }

  private async read(id: string): Promise<PullRequestReview | undefined> {
    const file = `${this.d.paths.mrs}/${id}.json`;
    const parsed = await loadDocument(this.d.fs, file, PullRequestReviewDocument, "json");
    return parsed.isOk() ? parsed.value : undefined;
  }

  private write(id: string, review: PullRequestReview): Promise<Result<void, MetatorError>> {
    return writeDocument(
      this.d.fs,
      `${this.d.paths.mrs}/${id}.json`,
      PullRequestReviewDocument,
      review,
      "json",
    );
  }
}
