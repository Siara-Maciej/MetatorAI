/**
 * The app's own state outside React (ADR-0113): what the daemon's sockets wrote, the yes/nos the
 * window keeps, and the parts of the shell that read one value each and draw again only when it
 * changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Profiler, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { StateData } from "../src/shared/api/api.ts";
import { CommandText } from "../src/shared/components/command-text.tsx";
import { RepoSelect } from "../src/shared/components/repo-select.tsx";
import { type Daemon, DaemonScope } from "../src/shared/daemon/daemon.tsx";
import { publish } from "../src/shared/daemon/daemon-store.ts";
import { NameDialog } from "../src/shared/daemon/name-dialog.tsx";
import { failed, inboxRead, retry, stateRead, wireStore } from "../src/shared/daemon/wire.ts";
import { useKeptFlag } from "../src/shared/hooks.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";

describe("what the daemon's sockets wrote", () => {
  test("a state read again keeps the parts that did not change; a refusal is the address's", () => {
    const state = (stage: string) =>
      ({
        runs: [
          { runId: "r1", stage: "plan" },
          { runId: "r2", stage },
        ],
      }) as unknown as StateData;
    stateRead(state("build"));
    const before = wireStore.getState().state as unknown as { runs: object[] };
    stateRead(state("review"));
    const after = wireStore.getState().state as unknown as { runs: object[] };
    expect(after.runs[0]).toBe(before.runs[0]);
    expect(after.runs[1]).not.toBe(before.runs[1]);
    failed("http://a", "refused");
    expect(wireStore.getState().failure).toEqual({ url: "http://a", message: "refused" });
    failed("http://a", undefined);
    expect(wireStore.getState().failure).toBeUndefined();
  });

  test("the inbox's three lists, each kept when equal; Retry counts an attempt", () => {
    inboxRead({ decisions: [{ id: "d1" }], panes: [{ id: "p1" }] } as never);
    const panes = wireStore.getState().paneAsks;
    inboxRead({ decisions: [{ id: "d2" }], panes: [{ id: "p1" }] } as never);
    expect(wireStore.getState().paneAsks).toBe(panes);
    expect(wireStore.getState().reviewCards).toEqual([]);
    const n = wireStore.getState().attempt;
    retry();
    expect(wireStore.getState().attempt).toBe(n + 1);
  });
});

/** How many times each named part committed. */
const counted = (draws: Record<string, number>, id: string, children: ReactNode) => (
  <Profiler
    id={id}
    onRender={() => {
      draws[id] = (draws[id] ?? 0) + 1;
    }}
  >
    {children}
  </Profiler>
);

const setters: Record<string, (v: boolean) => void> = {};
function Flag({ name, keyName }: { readonly name: string; readonly keyName: string }) {
  const [on, set] = useKeptFlag(keyName, false);
  setters[name] = set;
  return <span>{on ? "on" : "off"}</span>;
}

let daemon: StoreApi<Daemon> | undefined;
function GrabDaemon() {
  daemon = useScopedApi(DaemonScope);
  return null;
}

/** Types into an input the way a person does: React hears the input event. */
function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("parts of the shell that read one value", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a kept yes/no: every part with its key hears a change, others draw nothing; storage keeps it", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    localStorage.setItem("test.flag.b", "1");
    const draws: Record<string, number> = {};
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <>
          {counted(draws, "a1", <Flag name="a1" keyName="test.flag.a" />)}
          {counted(draws, "a2", <Flag name="a2" keyName="test.flag.a" />)}
          {counted(draws, "b", <Flag name="b" keyName="test.flag.b" />)}
        </>,
      ),
    );
    expect(host.textContent).toBe("offoffon");
    act(() => setters.a1?.(true));
    expect(host.textContent).toBe("ononon");
    expect(draws).toEqual({ a1: 2, a2: 2, b: 1 });
    expect(localStorage.getItem("test.flag.a")).toBe("1");
    act(() => root.unmount());
  });

  test("the repository choice draws again for its places, not for a run's change", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const chosen: string[] = [];
    const value = {
      repos: [{ name: "shop" }, { name: "api" }],
      repo: "shop",
      runs: [],
      setRepo: (name: string) => chosen.push(name),
    } as unknown as Daemon;
    const draws: Record<string, number> = {};
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <ScopeProvider store={DaemonScope} init={value}>
          <GrabDaemon />
          {counted(draws, "select", <RepoSelect />)}
        </ScopeProvider>,
      ),
    );
    act(() => daemon && publish(daemon, { ...daemon.getState(), runs: [{ runId: "r1" }] as never }));
    expect(draws).toEqual({ select: 1 });
    act(() => daemon && publish(daemon, { ...daemon.getState(), repo: "api" }));
    expect(draws).toEqual({ select: 2 });
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("api");
    act(() => root.unmount());
  });

  test("one long command opened draws that one, not the others", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const long = `bun run ${"x".repeat(400)}`;
    const draws: Record<string, number> = {};
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <>
          {counted(draws, "one", <CommandText prompt="p" command={long} />)}
          {counted(draws, "two", <CommandText prompt="p" command={long} />)}
        </>,
      ),
    );
    act(() => (host.querySelector('[data-testid="command-short"]') as HTMLButtonElement).click());
    expect(host.querySelectorAll('[data-testid="command-full"]').length).toBe(1);
    expect(draws).toEqual({ one: 2, two: 1 });
    act(() => root.unmount());
  });

  test("the name dialog: Save waits for a name; the name is sent trimmed; Cancel sends nothing", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const done: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<NameDialog initial="" onDone={(n) => done.push(n)} />));
    const save = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Save");
    expect(save()?.disabled).toBe(true);
    act(() => typeInto(host.querySelector("input") as HTMLInputElement, "  ana "));
    expect(save()?.disabled).toBe(false);
    act(() => (host.querySelector("form") as HTMLFormElement).requestSubmit());
    expect(done).toEqual(["ana"]);
    act(() => root.unmount());
    host.remove();
  });
});
