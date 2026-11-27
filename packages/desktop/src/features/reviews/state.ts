/**
 * What Reviews keeps while it is open (ADR-0113): the MR chosen (the route's), the fold of ended
 * watches, the proposed replies the person unchecked, and what the last actions answered: one for
 * the buttons that start an agent (Review, Re-review, Analyse), one for the others (Stop watching,
 * Send selected, Resolve). The actions that ask the daemon live here too.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Envelope, ReviewedRequest, ReviewStarted, ReviewView } from "../../shared/api/api.ts";
import { type Daemon, readAgainNow } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { navigate } from "../../shared/navigation.ts";
import { type ActionState, type Answer, IDLE, runAction } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { startedRoute } from "./model.ts";

/** The polled requests the screen lists the watched MRs and my MRs with (one key for every part). */
export const watchedKey = (repo: string | undefined): string => `reviews:${repo ?? ""}`;
export const mineKey = (repo: string | undefined): string => `mrs:${repo ?? ""}`;

export interface ReviewsState {
  readonly daemon: Store<Daemon>;
  /** The MR the route named; the first watched one (else the first of mine) when none. */
  readonly picked: string | undefined;
  readonly showEnded: boolean;
  /** The proposed replies the person unchecked: every other one to send is checked. */
  readonly unchecked: ReadonlySet<string>;
  /** A button that starts an agent: busy, and what it answered. */
  readonly agent: StoreApi<ActionState>;
  /** Stop watching, Send selected, Resolve: busy, and what it answered. */
  readonly act: StoreApi<ActionState>;

  /** The route named another MR: its detail starts clean (checked replies, notices). */
  routeTo(id: string | undefined): void;
  toggleEnded(): void;
  toggleReply(thread: string): void;

  review(w: ReviewView): Promise<boolean>;
  rereview(w: ReviewView): Promise<boolean>;
  unwatch(w: ReviewView): Promise<boolean>;
  analyse(m: ReviewedRequest): Promise<boolean>;
  sendReplies(m: ReviewedRequest, only: readonly string[] | undefined): Promise<boolean>;
  resolve(m: ReviewedRequest, thread: string): Promise<boolean>;
}

export interface ReviewsInit {
  readonly daemon: Store<Daemon>;
  readonly routeId: string | undefined;
}

export const Reviews = scopedStore<ReviewsState, ReviewsInit>(
  "Reviews",
  ({ daemon, routeId }) =>
    (set, get) => {
      const agent = createStore<ActionState>(() => IDLE);
      const act = createStore<ActionState>(() => IDLE);
      const repo = () => daemon.getState().repo;
      const client = () => daemon.getState().client;
      /** Both lists read again: an action changed one of them. */
      const reload = async () => {
        const { url } = daemon.getState();
        await Promise.all([readAgainNow(url, watchedKey(repo())), readAgainNow(url, mineKey(repo()))]);
      };
      const run = (request: (by: string) => Promise<Answer>) =>
        runAction(act, daemon, request, { who: true, reload });
      /** A request that may start an agent: once the daemon says yes, its terminal shows. */
      const start = (request: (by: string) => Promise<Envelope<ReviewStarted>>) =>
        runAction(
          agent,
          daemon,
          async (by) => {
            const r = await request(by);
            const to = r.ok ? startedRoute(r.data) : undefined;
            if (to) navigate(to);
            return r;
          },
          { who: true, reload },
        );
      return {
        daemon,
        picked: routeId,
        showEnded: false,
        unchecked: new Set(),
        agent,
        act,

        routeTo: (id) => {
          if (id === get().picked) return;
          set({ picked: id, unchecked: new Set() });
          agent.setState(IDLE);
          act.setState(IDLE);
        },
        toggleEnded: () => set((s) => ({ showEnded: !s.showEnded })),
        toggleReply: (thread) =>
          set((s) => {
            const next = new Set(s.unchecked);
            if (next.has(thread)) next.delete(thread);
            else next.add(thread);
            return { unchecked: next };
          }),

        review: (w) => start((by) => client().startReview(w.url, by, repo())),
        rereview: (w) => start((by) => client().rereview(w.id, by, repo())),
        unwatch: (w) => run((by) => client().unwatchReview(w.id, by, repo())),
        analyse: (m) => start((by) => client().analyseMr(m.id, by, repo())),
        sendReplies: (m, only) => run((by) => client().sendMrReplies(m.id, by, repo(), only)),
        resolve: (m, thread) => run((by) => client().resolveMrThread(m.id, thread, by, repo())),
      };
    },
);

/** One value of Reviews' state: the part draws again only when it changed. */
export const useReviews = <T>(select: (s: ReviewsState) => T): T => useScoped(Reviews, select);
/** The store at the moment of an event: no subscription. */
export const useReviewsApi = () => useScopedApi(Reviews);
