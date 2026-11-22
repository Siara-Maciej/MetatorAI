import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  mergeThreads,
  type PullRequestReview,
  PullRequestReviewDocument,
  type ReviewsConfig,
  reviewId,
  reviewTask,
  selectThreads,
  type ThreadKind,
  type ThreadState,
} from "../domain/review-thread.ts";
import { mineCard, type ReviewCard } from "../domain/watched-review.ts";
import type { Clock, FileSystem, ReviewHost } from "../ports/index.ts";
import { loadDocument, writeDocument } from "./document-io.ts";
import type { Notifier } from "./notifier.ts";
import type { Panes, PaneView } from "./panes.ts";
import type { MetatorPaths } from "./paths.ts";
import type { InitRun } from "./runs.ts";
import type { Threads } from "./threads.ts";

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
  /**
   * `codehost.mine.analyse` (ADR-0097): a new review starts the answering run by itself. Off (the
   * default), a new review is only kept and shown as a card; "Analyse" starts the work.
   */
  readonly analyse?: boolean;
  /** The daemon's panes: "Analyse" opens the responder where a person sees it. */
  readonly panes?: Pick<Panes, "openWorkspace" | "openTab" | "openPane">;
  readonly threads?: Pick<Threads, "addMr">;
}

/** My request as the list shows it: with the threads nobody analysed yet. */
export type MyRequestView = PullRequestReview & {
  readonly id: string;
  /** Open threads not triaged yet (`unsorted`): what "Analyse" works on. */
  readonly fresh: number;
};

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
        // Detected always; the work starts by itself only when the person chose so (ADR-0097).
        if (merged.fresh.length > 0 && !busy && this.d.analyse === true) {
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

  /** My requests with what is new in each, and a card for each review nobody analysed yet. */
  async overview(): Promise<
    Result<
      { readonly requests: readonly MyRequestView[]; readonly cards: readonly ReviewCard[] },
      MetatorError
    >
  > {
    const all = await this.list();
    if (all.isErr()) return err(all.error);
    const requests: MyRequestView[] = [];
    const cards: ReviewCard[] = [];
    for (const r of all.value) {
      const fresh = r.threads.filter((t) => t.state === "open" && t.kind === "unsorted").length;
      requests.push({ ...r, fresh });
      const answering = r.runId !== undefined && (await this.d.runActive(r.runId));
      const card = mineCard({ id: r.id, number: r.number, title: r.title, url: r.url, fresh, answering });
      if (card) cards.push(card);
    }
    return ok({ requests, cards });
  }

  /**
   * "Analyse": the responder in a pane a person sees, told to analyse every new thread, propose
   * replies and fixes (quick or the full workflow by the escalators), and send nothing itself.
   */
  async analyse(
    id: string,
    input: { readonly by?: string; readonly host?: string; readonly threadId?: string } = {},
  ): Promise<Result<{ readonly request: MyRequestView; readonly pane: PaneView }, MetatorError>> {
    if (!this.d.panes)
      return err(
        MetatorError.usage("analysing in a pane needs the daemon (`metator serve`)", "Start the app."),
      );
    const review = await this.show(id);
    if (review.isErr()) return err(review.error);
    const workspace = await this.d.panes.openWorkspace({ label: "reviews" });
    if (workspace.isErr()) return err(workspace.error);
    const tab = await this.d.panes.openTab(workspace.value.id, `#${review.value.number}`);
    if (tab.isErr()) return err(tab.error);
    const pane = await this.d.panes.openPane({
      workspace: workspace.value.id,
      tab: tab.value,
      role: "apps",
      label: `analyse ${id}`,
      process: {
        kind: "host",
        ...(input.host ? { host: input.host } : {}),
        agent: "mt-review-responder",
        prompt: analyseTask(id, review.value),
      },
    });
    if (pane.isErr()) return err(pane.error);
    if (input.threadId && this.d.threads)
      await this.d.threads.addMr(input.threadId, id, `MR #${review.value.number} ${review.value.title}`);
    const fresh = review.value.threads.filter((t) => t.state === "open" && t.kind === "unsorted").length;
    return ok({ request: { ...review.value, fresh }, pane: pane.value });
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

  /**
   * Posts the proposed replies that were not sent yet, in one consent: all of them, only the
   * threads named (`only`), or all but those (`skip`). The person who says so is named.
   */
  async send(
    id: string,
    input: {
      readonly by: string;
      readonly only?: readonly string[] | undefined;
      readonly skip?: readonly string[] | undefined;
    },
  ): Promise<
    Result<{ readonly sent: readonly string[]; readonly skipped: readonly string[] }, MetatorError>
  > {
    if (input.by.trim() === "") return err(MetatorError.usage("say who sends the replies: --by <name>"));
    const review = await this.show(id);
    if (review.isErr()) return err(review.error);
    const chosen = selectThreads(
      review.value.threads.map((t) => t.id),
      { only: input.only, skip: input.skip },
    );
    if ("problem" in chosen)
      return err(MetatorError.usage(chosen.problem, `\`metator mrs show ${id}\` lists the threads.`));
    const sent: string[] = [];
    const skipped: string[] = [];
    let threads = review.value.threads;
    for (const t of review.value.threads) {
      if (!t.reply || t.repliedAt || t.state === "resolved") continue;
      if (!chosen.chosen.includes(t.id)) {
        skipped.push(t.id);
        continue;
      }
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
    return ok({ sent, skipped });
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

/** What "Analyse" tells the responder: every new thread of the review, quoted as data. */
export function analyseTask(
  id: string,
  review: Pick<PullRequestReview, "number" | "title" | "url" | "threads">,
): string {
  return `Analyse mode. ${reviewTask(id, review)}\n\nFor each thread: record its kind and a proposed reply with \`metator mrs triage ${id} --thread <id> --kind … --reply "…"\`. For a change it asks for, propose the fix: quick when \`metator quick check\` says so, else the full workflow (\`metator run new --workflow mt-review-response\`); start nothing without the person. Never send a reply yourself: the person sends them (\`metator mrs send ${id} --by <name> [--only t1,t3 | --skip t2]\`).`;
}
