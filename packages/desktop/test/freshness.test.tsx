/**
 * The freshness line over a screen's data: nothing while fresh or not here yet, a failure with Try
 * again when there is no data, "Not up to date" with Try now when the reads after a good one fail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Freshness } from "../src/shared/components/freshness.tsx";

const read = (data: unknown, error: string | undefined, updatedAt?: number) => {
  const r = { data, error, updatedAt, reloads: 0, reload: async () => void r.reloads++ };
  return r;
};

describe("the freshness line", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("says a failure, then staleness, and nothing for fresh or loading data", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    const root = createRoot(host);
    const line = () => host.querySelector('[data-testid="freshness"]');

    const failed = read(undefined, "the daemon answered 500 on /issues");
    act(() => root.render(<Freshness reads={[failed]} what="The tasks" />));
    expect(line()?.getAttribute("data-state")).toBe("failed");
    expect(line()?.textContent).toContain("The tasks could not be read: the daemon answered 500 on /issues");
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(failed.reloads).toBe(1);

    const at = Date.now() - 30_000;
    const stale = read({ issues: [] }, "the daemon is not answering", at);
    act(() => root.render(<Freshness reads={[read({}, undefined), stale]} what="The reviews" />));
    expect(line()?.getAttribute("data-state")).toBe("stale");
    expect(line()?.textContent).toContain(`no answer since ${new Date(at).toTimeString().slice(0, 8)}`);
    expect(line()?.textContent).toContain("the daemon is not answering");
    expect(line()?.textContent).toContain("Try now");

    act(() => root.render(<Freshness reads={[read({ issues: [] }, undefined, at)]} what="The tasks" />));
    expect(line()).toBeNull();
    act(() => root.render(<Freshness reads={[read(undefined, undefined)]} what="The tasks" />));
    expect(line()).toBeNull();
    act(() => root.unmount());
  });
});
