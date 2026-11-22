import { DISMISSABLE, err, MetatorError, ok, type ReviewCard } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { z } from "zod";
import { body, type Call, type Daemon, denied, optional, type Route, route, strings, text } from "../http.ts";

/**
 * `/reviews` and `/mrs` (ADR-0097): someone else's MR reviewed from its link and watched (the
 * review, the re-review, approving, stopping), and my MRs (the new reviews, "Analyse", sending
 * the chosen replies). What changes the host is the person's: approve is a person's only.
 */

const id = ({ params }: Call<unknown>) => params.id as string;
const by = body({ by: text });

/** Approving at the host is the person's: a Yes on the card, never a pane's call. */
async function personOnly({ token }: Call): Promise<ReturnType<typeof denied> | undefined> {
  return token
    ? denied(
        "approving an MR at its host is the person's decision, not a pane's",
        "Propose it to the person; they say Yes on the card, or `metator review approve` runs after their word.",
      )
    : undefined;
}

/** In a folder, a card's actions name the repository that holds the MR. */
function inRepo(card: ReviewCard, repo: string | undefined): ReviewCard & { readonly repo?: string } {
  if (!repo) return card;
  const q = `?repo=${encodeURIComponent(repo)}`;
  return { ...card, repo, actions: card.actions.map((a) => ({ ...a, path: `${a.path}${q}` })) };
}

/** The served repositories: each with its name in a folder. */
const served = (daemon: Daemon): readonly { readonly name?: string; readonly c: MetatorContainer }[] =>
  daemon.repos();

/** Every repository's watched MRs and cards, then my MRs' cards: what Home and the Reviews place show. */
export async function reviewCards(
  repos: readonly { readonly name?: string | undefined; readonly c: MetatorContainer }[],
): Promise<(ReviewCard & { readonly repo?: string })[]> {
  const out: (ReviewCard & { readonly repo?: string })[] = [];
  for (const r of repos) {
    const watched = await r.c.resolve("watchedReviews").list();
    if (watched.isOk()) out.push(...watched.value.cards.map((c) => inRepo(c, r.name)));
    const mine = await r.c.resolve("myReviews").overview();
    if (mine.isOk()) out.push(...mine.value.cards.map((c) => inRepo(c, r.name)));
  }
  return out;
}

export const REVIEW_ROUTES: readonly Route[] = [
  // A review from a link: the repository whose checkout is the MR's (a full review), else the one asked (from the diff).
  route({
    method: "POST",
    pattern: "/reviews",
    global: true,
    body: body({
      url: z.string().min(1),
      by: text,
      host: optional(z.string()),
      threadId: optional(z.string()),
    }),
    handler: async (call) => {
      const b = call.body;
      if (!b.by?.trim()) return err(MetatorError.usage("say who asks for the review: by"));
      const repos = served(call.daemon);
      let target = repos.find((r) => r.name !== undefined && r.name === call.repo) ?? repos[0];
      for (const r of repos)
        if (await r.c.resolve("watchedReviews").isLocal(b.url)) {
          target = r;
          break;
        }
      if (!target) return err(MetatorError.notFound("a repository to review in"));
      let threadId = b.threadId;
      if (!threadId && call.token) {
        const thread = await target.c.resolve("threads").ofPane(call.token);
        if (thread.isOk()) threadId = thread.value.id;
      }
      const opened = await target.c.resolve("watchedReviews").open({
        url: b.url,
        by: b.by,
        ...(b.host ? { host: b.host } : {}),
        ...(threadId ? { threadId } : {}),
      });
      return opened.map((o) => ({ ...o, ...(target.name ? { localRepo: target.name } : {}) }));
    },
  }),
  route({
    method: "GET",
    pattern: "/reviews",
    global: true,
    handler: async ({ daemon }) => {
      const reviews: unknown[] = [];
      const cards: ReviewCard[] = [];
      for (const r of served(daemon)) {
        const listed = await r.c.resolve("watchedReviews").list();
        if (listed.isErr()) return err(listed.error);
        // `repo` is the code host's owner/name; the folder's repository that holds it is `localRepo`.
        reviews.push(...listed.value.reviews.map((v) => (r.name ? { ...v, localRepo: r.name } : v)));
        cards.push(...listed.value.cards.map((c) => inRepo(c, r.name)));
      }
      return ok({ reviews, cards });
    },
  }),
  route({
    method: "GET",
    pattern: "/reviews/:id",
    handler: (call) => call.c.resolve("watchedReviews").show(id(call)),
  }),
  route({
    method: "POST",
    pattern: "/reviews/:id/rereview",
    body: body({ by: text, host: optional(z.string()) }),
    handler: (call) =>
      call.c.resolve("watchedReviews").rereview(id(call), {
        by: call.body.by ?? "",
        ...(call.body.host ? { host: call.body.host } : {}),
      }),
  }),
  route({
    method: "POST",
    pattern: "/reviews/:id/approve",
    body: by,
    guard: personOnly,
    handler: (call) => call.c.resolve("watchedReviews").approve(id(call), { by: call.body.by ?? "" }),
  }),
  route({
    method: "POST",
    pattern: "/reviews/:id/unwatch",
    body: by,
    handler: (call) => call.c.resolve("watchedReviews").unwatch(id(call), { by: call.body.by ?? "" }),
  }),
  route({
    method: "POST",
    pattern: "/reviews/:id/dismiss",
    body: body({ by: text, card: z.enum(DISMISSABLE) }),
    handler: (call) =>
      call.c.resolve("watchedReviews").dismiss(id(call), { card: call.body.card, by: call.body.by ?? "" }),
  }),
  // My MRs: the requests with what nobody analysed yet, and a card for each new review.
  route({ method: "GET", pattern: "/mrs", handler: ({ c }) => c.resolve("myReviews").overview() }),
  route({
    method: "GET",
    pattern: "/mrs/:request",
    handler: ({ c, params }) => c.resolve("myReviews").show(params.request as string),
  }),
  route({
    method: "POST",
    pattern: "/mrs/:request/analyse",
    body: body({ by: text, host: optional(z.string()) }),
    handler: async (call) => {
      let threadId: string | undefined;
      if (call.token) {
        const thread = await call.c.resolve("threads").ofPane(call.token);
        if (thread.isOk()) threadId = thread.value.id;
      }
      return call.c.resolve("myReviews").analyse(call.params.request as string, {
        ...(call.body.by ? { by: call.body.by } : {}),
        ...(call.body.host ? { host: call.body.host } : {}),
        ...(threadId ? { threadId } : {}),
      });
    },
  }),
  // One consent for the batch: all, only the threads named, or all but the skipped ones.
  route({
    method: "POST",
    pattern: "/mrs/:request/send",
    body: body({ by: text, only: strings, skip: strings }),
    handler: ({ c, params, body: b }) =>
      c.resolve("myReviews").send(params.request as string, {
        by: b.by ?? "",
        ...(b.only ? { only: b.only } : {}),
        ...(b.skip ? { skip: b.skip } : {}),
      }),
  }),
  route({
    method: "POST",
    pattern: "/mrs/:request/resolve",
    body: body({ by: text, thread: text }),
    handler: ({ c, params, body: b }) =>
      c.resolve("myReviews").resolve(params.request as string, b.thread ?? "", { by: b.by ?? "" }),
  }),
];
