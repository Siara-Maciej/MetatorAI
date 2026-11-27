/**
 * The small stores of a run's page (ADR-0113): "Debug changes" (removing all or one, forgetting,
 * what the entry says once the list is closed), the host a start goes to, the artifact opened and
 * the answer a task's page gave; and the run page's action, which only its notice draws.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StoreApi } from "zustand/vanilla";
import { DebugChanges, type DebugChangesState } from "../src/features/runs/debug-changes-state.ts";
import { Artifacts, RunPage, StartHost, TaskSaid } from "../src/features/runs/run-parts-state.ts";
import { storeAction } from "../src/features/runs/store-action.ts";
import type { ScratchItem } from "../src/shared/model/stage1.ts";
import { ScopeProvider, useScoped, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, fakeDaemon, made } from "./screen-fakes.tsx";

const item = (id: string, state: ScratchItem["state"], repo?: string): ScratchItem => ({
  id,
  repo,
  files: [`${id}.ts`],
  at: "2026-11-27T10:00:00Z",
  state,
});
const dropped = (ids: string[]) => ({
  ok: true,
  data: { dropped: ids.map((id) => ({ id, files: [`${id}.ts`] })) },
});

const debug = (answers: Record<string, unknown> = {}) => {
  const { daemon, calls } = fakeDaemon(answers);
  const s: StoreApi<DebugChangesState> = made(DebugChanges.create({ daemon }));
  s.getState().openList();
  return { s, calls };
};

describe("the debug changes' state", () => {
  test("Remove debug changes with every one removable: one request per repository, the list closes saying it", async () => {
    const { s, calls } = debug({ dropScratch: dropped(["d1"]) });
    await s.getState().drop(["shop", undefined], [item("d1", "removable", "shop")]);
    expect(calls.dropScratch).toEqual([
      [{ by: "ana" }, "shop"],
      [{ by: "ana" }, undefined],
    ]);
    expect([s.getState().open, s.getState().said?.ok, s.getState().said?.text]).toEqual([
      false,
      true,
      expect.stringContaining("Removed"),
    ]);
  });

  test("with a changed one, all asks for the removable ones by name and the list stays", async () => {
    const { s, calls } = debug({ dropScratch: dropped(["d1"]) });
    await s.getState().drop(["shop"], [item("d1", "removable", "shop"), item("d2", "changed", "shop")]);
    expect(calls.dropScratch?.[0]).toEqual([{ ids: ["d1"], by: "ana" }, "shop"]);
    expect([s.getState().open, s.getState().listSaid?.ok]).toEqual([true, true]);
  });

  test("Remove on one names it and the list stays; a refusal says why and removes nothing more", async () => {
    const { s, calls } = debug({ dropScratch: { ok: false, error: { message: "busy tree" } } });
    await s.getState().drop(["shop"], [item("d1", "removable", "shop")], item("d1", "removable", "shop"));
    expect(calls.dropScratch?.[0]).toEqual([{ ids: ["d1"], by: "ana" }, "shop"]);
    expect([s.getState().open, s.getState().notice?.text, s.getState().listSaid]).toEqual([
      true,
      "busy tree",
      undefined,
    ]);
  });

  test("Forget says what it did; closing leaves that word in the entry's place", async () => {
    const { s, calls } = debug({
      forgetScratch: { ok: true, data: { forgotten: [{ id: "d2", files: ["a.ts"] }] } },
    });
    await s.getState().forget(["shop"], item("d2", "changed", "shop"));
    expect(calls.forgetScratch?.[0]).toEqual([{ ids: ["d2"], by: "ana" }, "shop"]);
    s.getState().closeList();
    expect([s.getState().open, s.getState().said?.text]).toEqual([
      false,
      "Forgot 1 debug change (a.ts): its lines stay in your files.",
    ]);
    s.getState().dismiss();
    expect(s.getState().said).toBeUndefined();
  });

  test("what is gone is kept while the list is open, left in the entry's place, and a new opening starts afresh", () => {
    const { s } = debug();
    s.getState().noteGone("d1 is gone.");
    s.getState().noteGone("d2 is gone.");
    expect(s.getState().gone).toBe("d1 is gone. d2 is gone.");
    s.getState().closeList();
    expect(s.getState().said).toEqual({ text: "d1 is gone. d2 is gone.", ok: true });
    s.getState().openList();
    expect([s.getState().gone, s.getState().listSaid, s.getState().open]).toEqual(["", undefined, true]);
  });
});

describe("the small parts' state", () => {
  test("a start's host, the artifact opened, a task's answer", () => {
    const host = made(StartHost.create(undefined));
    host.getState().choose("codex");
    const artifacts = made(Artifacts.create(undefined));
    artifacts.getState().view("plan.json");
    const said = made(TaskSaid.create(undefined));
    said.getState().answered(["Approve", "Later"]);
    expect([host.getState().chosen, artifacts.getState().viewing, said.getState().said]).toEqual([
      "codex",
      "plan.json",
      "Answered: Approve, Later.",
    ]);
  });

  test("the run page's action runs through its store: busy, then the refusal as its notice", async () => {
    const { daemon, calls } = fakeDaemon({ attach: { ok: false, error: { message: "taken" } } });
    const page = made(RunPage.create({ daemon }));
    const action = storeAction(page, daemon, false);
    expect(await action.run((by) => daemon.getState().client.attach("r1", by), { who: true })).toBe(false);
    expect([calls.attach?.[0], page.getState().notice?.text, page.getState().busy]).toEqual([
      ["r1", "ana"],
      "taken",
      false,
    ]);
    action.say("hello", "info");
    expect(page.getState().notice).toEqual({ text: "hello", tone: "info" });
    page.getState().closeNotice();
    expect(page.getState().notice).toBeUndefined();
  });
});

let grabbed: StoreApi<DebugChangesState> | undefined;
function Grab() {
  grabbed = useScopedApi(DebugChanges);
  return null;
}
function Gone() {
  return <span>{useScoped(DebugChanges, (s) => s.gone)}</span>;
}
function Opened() {
  return <span>{String(useScoped(DebugChanges, (s) => s.open))}</span>;
}

describe("the debug changes' parts", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a record said gone draws the gone line again, not the entry", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { daemon } = fakeDaemon();
    const draws: Record<string, number> = {};
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <ScopeProvider store={DebugChanges} init={{ daemon }}>
          <Grab />
          {counted(draws, "gone", <Gone />)}
          {counted(draws, "open", <Opened />)}
        </ScopeProvider>,
      ),
    );
    act(() => grabbed?.getState().noteGone("d1 is gone."));
    expect(draws).toEqual({ gone: 2, open: 1 });
    act(() => root.unmount());
  });
});
