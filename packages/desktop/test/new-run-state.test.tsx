/**
 * The New run form's store (ADR-0113): what a create sends and what it says back, and a field that
 * draws again alone when the person types in it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StoreApi } from "zustand/vanilla";
import { NewRun, type NewRunState } from "../src/features/runs/new-run-state.ts";
import { TaskField, WorktreeField } from "../src/features/runs/new-session.tsx";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import type { Store } from "../src/shared/daemon/daemon-store.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, fakeDaemon, made } from "./screen-fakes.tsx";

const form = (daemon: Store<Daemon>): StoreApi<NewRunState> => made(NewRun.create({ daemon }));
const choice = { workflow: "mt-feature", host: "claude", autonomy: "L1" };
const created = { ok: true, data: { run: { runId: "r7" } } };

describe("the New run form's state", () => {
  test("it starts in the shown repository, with a worktree, at L0", () => {
    const s = form(fakeDaemon().daemon).getState();
    expect([s.repo, s.worktree, s.wantedAutonomy, s.task]).toEqual(["shop", true, "L0", ""]);
  });

  test("no task asks nothing and says why", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = form(daemon);
    s.getState().setTask("   ");
    expect(await s.getState().create(false, choice)).toBeUndefined();
    expect([calls.createRun, s.getState().notice?.text]).toEqual([
      undefined,
      "a workflow and a task are needed",
    ]);
    expect(await s.getState().create(false, { ...choice, workflow: "" })).toBeUndefined();
    expect(calls.createRun).toBeUndefined();
  });

  test("a create sends the trimmed task, the choices and the parent; its run id comes back", async () => {
    const { daemon, calls } = fakeDaemon({ createRun: created });
    const s = form(daemon);
    s.getState().setTask("  Fix the cart ");
    s.getState().setParent("r1");
    s.getState().setWorktree(false);
    s.getState().setRepo("");
    expect(await s.getState().create(true, choice)).toBe("r7");
    expect(calls.createRun?.[0]).toEqual([
      {
        workflow: "mt-feature",
        task: "Fix the cart",
        autonomy: "L1",
        worktree: false,
        parent: "r1",
        drive: "claude",
      },
      undefined,
    ]);
    expect([s.getState().busy, s.getState().notice]).toEqual([false, undefined]);
  });

  test("refused for uncommitted changes: the same create is offered from the last commit; closing forgets it", async () => {
    const refusal = { ok: false, error: { message: "uncommitted changes", details: { check: "tree" } } };
    const { daemon, calls } = fakeDaemon({ createRun: refusal });
    const s = form(daemon);
    s.getState().setTask("Fix");
    expect(await s.getState().create(true, { ...choice, host: "" })).toBeUndefined();
    expect([s.getState().notice?.text, s.getState().dirty]).toEqual([
      "uncommitted changes",
      { andAttach: true },
    ]);
    await s.getState().create(true, { ...choice, host: "" }, true);
    expect(calls.createRun?.[1]?.[0]).toMatchObject({ allowDirty: true });
    expect(calls.createRun?.[1]?.[0]).not.toHaveProperty("drive");
    s.getState().closeNotice();
    expect([s.getState().notice, s.getState().dirty]).toEqual([undefined, undefined]);
  });

  test("another refusal says its words and offers nothing more", async () => {
    const { daemon } = fakeDaemon({ createRun: { ok: false } });
    const s = form(daemon);
    s.getState().setTask("Fix");
    await s.getState().create(false, choice);
    expect([s.getState().notice?.text, s.getState().dirty]).toEqual(["the run was not created", undefined]);
  });

  test("a run created whose agent did not start stays said, and the dialog stays", async () => {
    const { daemon } = fakeDaemon({
      createRun: { ok: true, data: { run: { runId: "r7" }, drive: { error: "no claude." } } },
    });
    const s = form(daemon);
    s.getState().setTask("Fix");
    expect(await s.getState().create(false, choice)).toBeUndefined();
    expect(s.getState().notice?.text).toBe(
      "The run was created, but its agent did not start: no claude. Open it from the panel on the left.",
    );
  });
});

let grabbed: StoreApi<NewRunState> | undefined;
function Grab() {
  grabbed = useScopedApi(NewRun);
  return null;
}

describe("the New run form's fields", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("typing the task draws the task field again, not the other fields", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { daemon } = fakeDaemon();
    const draws: Record<string, number> = {};
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <ScopeProvider store={NewRun} init={{ daemon }}>
          <Grab />
          {counted(draws, "task", <TaskField />)}
          {counted(draws, "worktree", <WorktreeField />)}
        </ScopeProvider>,
      ),
    );
    act(() => grabbed?.getState().setTask("F"));
    act(() => grabbed?.getState().setTask("Fi"));
    expect(draws).toEqual({ task: 3, worktree: 1 });
    act(() => grabbed?.getState().setWorktree(false));
    expect(draws).toEqual({ task: 3, worktree: 2 });
    act(() => root.unmount());
  });
});
