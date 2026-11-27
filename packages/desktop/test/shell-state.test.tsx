/**
 * The shell's parts read one value each (ADR-0113): the sidebar's rows their own entry of the tree
 * (a run's change draws its row), the route the piece a part draws (a move draws the rows that are
 * or were current, not the others), and the repository screens keep their flows in a store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Profiler, type ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { closeDrawer, toggleDrawer, useDrawerOpen } from "../src/app/shell-state.ts";
import { TaskRows } from "../src/app/sidebar/rows.tsx";
import { fold, publishTree, sidebarStore } from "../src/app/sidebar/state.ts";
import { type SideInput, sideTree } from "../src/app/sidebar/tree.ts";
import { useRouteListener, useRouteOf } from "../src/app/use-route.ts";
import { ContinueButton, PathField, PickErrors } from "../src/features/repos/add-repo-screen.tsx";
import { AddRepo, type AddRepoState, ContainerPanel, Switcher } from "../src/features/repos/state.ts";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import { DaemonScope } from "../src/shared/daemon/daemon.tsx";
import type { Run } from "../src/shared/model/runs.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";

const run = (runId: string, extra: Partial<Run> = {}): Run =>
  ({
    runId,
    task: `task ${runId}`,
    status: "active",
    driving: false,
    stage: "plan",
    workflow: "mt-feature",
    ...extra,
  }) as Run;

const input = (runs: readonly Run[], shown: SideInput["shown"] = {}): SideInput => ({
  runs,
  panes: [],
  panesOf: () => [],
  systemPlans: [],
  threads: [],
  paneAsks: [],
  shown,
  now: Date.now(),
});

describe("the sidebar's tree", () => {
  test("each task has its row; a run's change makes a new row for it only, the group stays", () => {
    publishTree(sideTree(input([run("r1"), run("r2")])));
    const before = sidebarStore.getState().tree;
    const without = before.without ?? "";
    expect(before.groups[without]?.open.length).toBe(2);
    const [k1, k2] = before.groups[without]?.open ?? [];
    expect(before.tasks[k1 ?? ""]?.sub).toBe("plan");
    publishTree(sideTree(input([run("r1", { stage: "build" }), run("r2")])));
    const after = sidebarStore.getState().tree;
    expect(after.tasks[k1 ?? ""]?.sub).toBe("build");
    expect(after.tasks[k1 ?? ""]).not.toBe(before.tasks[k1 ?? ""]);
    expect(after.tasks[k2 ?? ""]).toBe(before.tasks[k2 ?? ""]);
    expect(after.groups[without]).toBe(before.groups[without]);
  });

  test("a task with steps holds its steps' runs; a finished run says how it ended on hover", () => {
    const t = sideTree(input([run("r1", { status: "done" })]));
    const row = Object.values(t.tasks)[0];
    expect(row?.holds).toContain("r1");
    expect(row?.hover).toContain("\n");
    expect(row?.canOpen).toBe(false);
  });

  test("a fold by hand is kept by key", () => {
    fold("task:x", true);
    fold("task:y", false);
    expect(sidebarStore.getState().expanded).toMatchObject({ "task:x": true, "task:y": false });
  });
});

describe("the repository screens' stores", () => {
  const add = () =>
    createStore<AddRepoState>()(
      AddRepo.create({
        commands: {
          pickFolder: async () => "/work/shop",
        } as never,
      }),
    );

  test("Add repository: typing, a picked folder inspected, Change back from a container", async () => {
    const s = add();
    s.getState().dispatch({ type: "type", path: "/a" });
    expect(s.getState().flow).toEqual({ step: "pick", path: "/a" });
    await s.getState().pick();
    expect(s.getState().flow).toEqual({ step: "inspecting", path: "/work/shop" });
    // Installed in a container: the flow inspects its workspace folder there.
    const c = add();
    c.getState().installed({ localFolder: "/l", workspaceFolder: "/workspaces/shop" } as never);
    expect([c.getState().place?.localFolder, c.getState().flow]).toEqual([
      "/l",
      { step: "inspecting", path: "/workspaces/shop" },
    ]);
    // The container's folder failed: Change goes back to the containers, with an empty path.
    c.getState().dispatch({ type: "failed", error: "no folder" });
    c.getState().change();
    expect([c.getState().place, c.getState().flow]).toEqual([undefined, { step: "pick", path: "" }]);
    c.getState().toggleOutput();
    expect(c.getState().output).toBe(true);
  });

  test("a folder picker that fails says to type the path", async () => {
    const s = createStore<AddRepoState>()(
      AddRepo.create({
        commands: {
          pickFolder: async () => {
            throw new Error("no dialog");
          },
        } as never,
      }),
    );
    await s.getState().pick();
    expect(s.getState().pickError).toContain("Type the path instead");
    expect(s.getState().flow.step).toBe("pick");
  });

  test("the lost container's panel: a refused reconnect says why and is not busy", async () => {
    const s = createStore(ContainerPanel.create({ startDaemon: async () => "no tunnel" }));
    await s.getState().reconnect("/p");
    expect([s.getState().busy, s.getState().why]).toEqual([undefined, "no tunnel"]);
  });

  test("the switcher: an act's refusal shows, the next act clears it", async () => {
    const s = createStore(Switcher.create(undefined));
    s.getState().act(Promise.resolve("not there"));
    await Promise.resolve();
    await Promise.resolve();
    expect(s.getState().refusal).toBe("not there");
    s.getState().act(new Promise(() => undefined));
    expect(s.getState().refusal).toBeUndefined();
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

function Listen() {
  useRouteListener(closeDrawer);
  return null;
}
/** The Add repository store the last drawn part saw, for the test to act on. */
let api: StoreApi<AddRepoState> | undefined;
function Grab() {
  api = useScopedApi(AddRepo);
  return null;
}
function Screen() {
  return <span>{useRouteOf((r) => r.screen)}</span>;
}
function Drawer() {
  return <span>{useDrawerOpen() ? "open" : "closed"}</span>;
}

const fakeDaemon = (runs: readonly Run[]) => ({ runs, inbox: [], run: () => undefined }) as unknown as Daemon;

describe("parts of the shell that read one value", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  const move = (hash: string) => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  };

  test("a run's change draws its row; a move draws the row that becomes current and closes the drawer", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const runs = [run("r1"), run("r2")];
    publishTree(sideTree(input(runs)));
    const tree = sidebarStore.getState().tree;
    const [k1, k2] = tree.groups[tree.without ?? ""]?.open ?? [];
    const draws: Record<string, number> = {};
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <ScopeProvider store={DaemonScope} init={fakeDaemon(runs)}>
          <Listen />
          {counted(draws, "r1", <TaskRows taskKey={k1 ?? ""} />)}
          {counted(draws, "r2", <TaskRows taskKey={k2 ?? ""} />)}
          {counted(draws, "screen", <Screen />)}
          {counted(draws, "drawer", <Drawer />)}
        </ScopeProvider>,
      ),
    );
    expect(draws).toEqual({ r1: 1, r2: 1, screen: 1, drawer: 1 });
    act(() => publishTree(sideTree(input([run("r1", { stage: "build" }), run("r2")]))));
    expect(draws).toEqual({ r1: 2, r2: 1, screen: 1, drawer: 1 });
    expect(host.textContent).toContain("build");
    act(() => toggleDrawer());
    act(() => move("#/run/r2"));
    expect(draws).toEqual({ r1: 2, r2: 2, screen: 2, drawer: 3 });
    expect(host.querySelector('[aria-current="true"]')?.textContent).toContain("task r2");
    expect(host.textContent).toContain("closed");
    // Another place that is not a run: the current row hears it, the other one does not.
    act(() => move("#/board"));
    expect(draws).toEqual({ r1: 2, r2: 3, screen: 3, drawer: 3 });
    act(() => root.unmount());
  });

  test("typing a path draws the path field, and Continue only when it can or cannot continue", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const draws: Record<string, number> = {};
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <ScopeProvider store={AddRepo} init={{ commands: {} as never }}>
          <Grab />
          {counted(draws, "path", <PathField />)}
          {counted(draws, "continue", <ContinueButton />)}
          {counted(draws, "errors", <PickErrors />)}
        </ScopeProvider>,
      ),
    );
    act(() => api?.getState().dispatch({ type: "type", path: "/" }));
    act(() => api?.getState().dispatch({ type: "type", path: "/w" }));
    act(() => api?.getState().dispatch({ type: "type", path: "/wo" }));
    expect(draws).toEqual({ path: 4, continue: 2, errors: 1 });
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("/wo");
    expect((host.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
    act(() => root.unmount());
  });
});
