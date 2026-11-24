/**
 * The app's state (ADR-0108): a polled answer equal to the last one keeps the last one's objects,
 * and a component hears only of the fields it reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryObserver } from "@tanstack/react-query";
import type { Envelope } from "../src/api.ts";
import { createStateStore, pick, publish, type Store, useFields } from "../src/daemon-store.ts";
import { createQueryClient, polledOptions, shared } from "../src/query.ts";

interface Pane {
  readonly id: string;
  readonly state: string;
}
const panes = (second = "idle"): Envelope<Pane[]> => ({
  ok: true,
  data: [
    { id: "p1", state: "working" },
    { id: "p2", state: second },
  ],
});

describe("a polled request", () => {
  test("an answer equal to the last one keeps its objects and tells nobody", async () => {
    const client = createQueryClient();
    const observer = new QueryObserver(
      client,
      polledOptions("http://d", "layout", async () => panes(), 0),
    );
    const seen: unknown[] = [];
    const stop = observer.subscribe((r) => {
      if (r.data && seen.at(-1) !== r.data) seen.push(r.data);
    });
    await observer.refetch();
    const first = observer.getCurrentResult().data;
    await observer.refetch();
    expect(observer.getCurrentResult().data).toBe(first);
    expect(seen).toHaveLength(1);
    stop();
    client.clear();
  });

  test("only the part that changed is new", async () => {
    const client = createQueryClient();
    let second = "idle";
    const observer = new QueryObserver(
      client,
      polledOptions("http://d", "layout", async () => panes(second), 0),
    );
    const first = (await observer.refetch()).data;
    second = "asks";
    const next = (await observer.refetch()).data;
    expect(next).not.toBe(first);
    expect(next?.[0]).toBe(first?.[0] as Pane);
    expect(next?.[1]).toEqual({ id: "p2", state: "asks" });
    client.clear();
  });

  test("a refusal is the error and the data that was there stays", async () => {
    const client = createQueryClient();
    let answer: Envelope<Pane[]> = panes();
    const observer = new QueryObserver(
      client,
      polledOptions("http://d", "layout", async () => answer, 0),
    );
    const first = (await observer.refetch()).data;
    answer = { ok: false, error: { code: "UNREACHABLE", message: "no layout" } };
    const refused = await observer.refetch();
    expect(refused.error?.message).toBe("no layout");
    expect(refused.data).toBe(first);
    // A refusal that carries data is still a refusal.
    answer = {
      ok: false,
      data: [{ id: "p9", state: "idle" }],
      error: { code: "REFUSED", message: "not now" },
    };
    const withData = await observer.refetch();
    expect(withData.error?.message).toBe("not now");
    expect(withData.data).toBe(first);
    answer = { ok: true };
    expect((await observer.refetch()).error?.message).toBe("the daemon did not answer");
    client.clear();
  });

  test("another daemon starts with nothing; 0 ms asks once", () => {
    const a = polledOptions("http://a", "layout", async () => panes(), 0);
    const b = polledOptions("http://b", "layout", async () => panes(), 1000);
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.refetchInterval).toBe(false);
    expect(b.refetchInterval).toBe(1000);
  });
});

describe("the state store", () => {
  const initial = { runs: [{ runId: "r1", stage: "build" }], me: "alice", url: "http://d" };

  test("publishing what is already there tells nobody", () => {
    const store = createStateStore(initial);
    let heard = 0;
    store.subscribe(() => heard++);
    publish(store, { ...initial, runs: [{ runId: "r1", stage: "build" }] });
    expect(heard).toBe(0);
    expect(store.getState()).toBe(initial);
    publish(store, { ...initial, me: "bob" });
    expect(heard).toBe(1);
    expect(store.getState().runs).toBe(initial.runs);
  });

  test("pick takes the named fields only", () => {
    expect(pick(initial, ["me", "url"])).toEqual({ me: "alice", url: "http://d" });
    expect(shared(initial.runs, [{ runId: "r1", stage: "build" }])).toBe(initial.runs);
  });
});

let draws = 0;
const Who = ({ store }: { readonly store: Store<{ readonly me: string }> }) => {
  draws++;
  return <span>{useFields(store, ["me"]).me}</span>;
};

describe("a component that reads fields", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("draws again only when a field it reads changed", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const store = createStateStore({ runs: [{ runId: "r1", stage: "build" }], me: "alice", url: "http://d" });
    draws = 0;
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Who store={store} />));
    expect(host.textContent).toBe("alice");
    expect(draws).toBe(1);
    // Another field changed, then the same content came again: nothing to draw.
    act(() => publish(store, { ...store.getState(), runs: [{ runId: "r1", stage: "approval" }] }));
    act(() => publish(store, { ...store.getState(), runs: [{ runId: "r1", stage: "approval" }] }));
    expect(draws).toBe(1);
    act(() => publish(store, { ...store.getState(), me: "bob" }));
    expect(host.textContent).toBe("bob");
    expect(draws).toBe(2);
    act(() => root.unmount());
  });
});
