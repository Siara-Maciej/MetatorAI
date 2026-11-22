import { describe, expect, test } from "bun:test";
import { ok } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { Call } from "../src/serve/http.ts";
import { REVIEW_ROUTES } from "../src/serve/routes/reviews.ts";

/** A repository's container as `GET /reviews` reads it: its watched MRs and their cards. */
const repoWith = (review: object, card: object) =>
  ({
    resolve: (name: string) => {
      if (name !== "watchedReviews") throw new Error(`unexpected ${name}`);
      return { list: async () => ok({ reviews: [review], cards: [card] }) };
    },
  }) as unknown as MetatorContainer;

describe("GET /reviews in a folder", () => {
  test("a review keeps the code host's repo; the folder's repository is localRepo; a card's actions name it", async () => {
    const route = REVIEW_ROUTES.find((r) => r.method === "GET" && r.pattern === "/reviews");
    const review = { id: "github-acme-shop-45", repo: "acme/shop" };
    const card = {
      id: "changed:github-acme-shop-45",
      review: review.id,
      actions: [{ label: "Re-review", method: "POST", path: "/reviews/github-acme-shop-45/rereview" }],
    };
    const call = {
      daemon: { repos: () => [{ name: "web", c: repoWith(review, card) }] },
    } as unknown as Call;
    const answer = (await route?.handler(call)) as {
      isOk(): boolean;
      value: { reviews: unknown[]; cards: unknown[] };
    };
    expect(answer.value.reviews).toEqual([
      { id: "github-acme-shop-45", repo: "acme/shop", localRepo: "web" },
    ]);
    expect(answer.value.cards).toEqual([
      {
        ...card,
        repo: "web",
        actions: [
          { label: "Re-review", method: "POST", path: "/reviews/github-acme-shop-45/rereview?repo=web" },
        ],
      },
    ]);
  });
});
