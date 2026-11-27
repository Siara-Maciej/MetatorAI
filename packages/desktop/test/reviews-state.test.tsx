/**
 * Reviews' store (ADR-0113): the route's MR starts its detail clean, replies are unchecked one by
 * one, each kind of action keeps its own answer; choosing an MR draws two rows again, not the list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { MineRow, WatchedRow } from "../src/features/reviews/reviews-screen.tsx";
import { mineKey, Reviews, type ReviewsState, watchedKey } from "../src/features/reviews/state.ts";
import { polledOptions, queryClient } from "../src/shared/api/query.ts";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import type { Store } from "../src/shared/daemon/daemon-store.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, drawRoot, fakeDaemon } from "./screen-kit.tsx";

const reviews = (daemon: Store<Daemon>, routeId?: string): StoreApi<ReviewsState> =>
  createStore<ReviewsState>()(Reviews.create({ daemon, routeId }));

const watched = (id: string, status = "reviewed") =>
  ({
    id,
    number: 1,
    title: `MR ${id}`,
    status,
    author: "bob",
    head: "feat",
    base: "main",
    url: `https://host/${id}`,
    findings: [],
    counts: { open: 0, fixed: 0, disputed: 0, new: 0 },
  }) as never;
const mine = (id: string) => ({ id, number: 2, title: `mine ${id}`, threads: [] }) as never;
const request = { id: "m1", threads: [] } as never;

describe("Reviews' state", () => {
  test("another MR from the route starts clean: its replies checked, no notice; the same one keeps them", async () => {
    const { daemon } = fakeDaemon({ unwatchReview: { ok: false, error: { message: "gone" } } });
    const s = reviews(daemon, "w1");
    s.getState().toggleReply("t1");
    await s.getState().unwatch(watched("w1"));
    s.getState().routeTo("w1");
    expect([[...s.getState().unchecked], s.getState().act.getState().notice?.text]).toEqual([["t1"], "gone"]);
    s.getState().routeTo("m1");
    expect([s.getState().picked, [...s.getState().unchecked], s.getState().act.getState().notice]).toEqual([
      "m1",
      [],
      undefined,
    ]);
  });

  test("a reply unchecked and checked again; Send selected names the replies to send", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = reviews(daemon);
    s.getState().toggleReply("t1");
    s.getState().toggleReply("t2");
    s.getState().toggleReply("t1");
    expect([...s.getState().unchecked]).toEqual(["t2"]);
    expect(await s.getState().sendReplies(request, ["t1"])).toBe(true);
    expect(calls.sendMrReplies?.[0]).toEqual(["m1", "ana", "shop", ["t1"]]);
  });

  test("a refused agent start says so in its own notice; the other actions' stays clear", async () => {
    const { daemon, calls } = fakeDaemon({ analyseMr: { ok: false, error: { message: "no new threads" } } });
    const s = reviews(daemon);
    expect(await s.getState().analyse(request)).toBe(false);
    expect(calls.analyseMr?.[0]).toEqual(["m1", "ana", "shop"]);
    expect([s.getState().agent.getState().notice?.text, s.getState().act.getState().notice]).toEqual([
      "no new threads",
      undefined,
    ]);
    await s.getState().resolve(request, "t9");
    expect(calls.resolveMrThread?.[0]).toEqual(["m1", "t9", "ana", "shop"]);
  });
});

let grabbed: StoreApi<ReviewsState> | undefined;
function Grab() {
  grabbed = useScopedApi(Reviews);
  return null;
}

describe("parts of Reviews", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    queryClient.clear();
    await GlobalRegistrator.unregister();
  });

  test("choosing an MR draws the rows that were and are chosen, not the others", async () => {
    const { daemon } = fakeDaemon({}, { run: () => undefined });
    const seed = (key: string, data: unknown) =>
      queryClient.setQueryData(
        polledOptions("http://d", key, async () => ({ ok: true }), 2000).queryKey,
        data,
      );
    seed(watchedKey("shop"), { reviews: [watched("w1"), watched("w2"), watched("w3")] });
    seed(mineKey("shop"), { requests: [mine("m1")] });
    const draws: Record<string, number> = {};
    const r = await drawRoot();
    r.draw(
      <QueryClientProvider client={queryClient}>
        <ScopeProvider store={Reviews} init={{ daemon, routeId: undefined }}>
          <Grab />
          {counted(draws, "w1", <WatchedRow id="w1" />)}
          {counted(draws, "w2", <WatchedRow id="w2" />)}
          {counted(draws, "w3", <WatchedRow id="w3" />)}
          {counted(draws, "m1", <MineRow id="m1" />)}
        </ScopeProvider>
      </QueryClientProvider>,
    );
    const chosen = () => [...r.host.querySelectorAll('[aria-current="true"]')].length;
    expect(draws).toEqual({ w1: 1, w2: 1, w3: 1, m1: 1 });
    expect(chosen()).toBe(1);
    // w1 is shown first; then the route names w3: w1 and w3 draw again, w2 and m1 do not.
    r.act(() => grabbed?.getState().routeTo("w3"));
    expect(draws).toEqual({ w1: 2, w2: 1, w3: 2, m1: 1 });
    r.act(() => grabbed?.getState().routeTo("m1"));
    expect([draws.w2, draws.w3, draws.m1]).toEqual([1, 3, 2]);
    r.done();
  });
});
