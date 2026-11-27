/**
 * The plan views' small stores (ADR-0113): the words of "Ask for changes" (typing draws the text
 * box and the button, not the closed-Approve line), a plan part's action, the step chosen.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StoreApi } from "zustand/vanilla";
import { ChangesText, SendChanges } from "../src/features/plans/plan-approval-line.tsx";
import {
  AskChanges,
  type AskChangesState,
  ChosenStep,
  PlanAction,
} from "../src/features/plans/plans-state.ts";
import { storeAction } from "../src/features/runs/store-action.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, fakeDaemon, made } from "./screen-fakes.tsx";

describe("the plan views' state", () => {
  test("the step chosen, and none again", () => {
    const s = made(ChosenStep.create(undefined));
    s.getState().choose("S2");
    expect(s.getState().chosen).toBe("S2");
    s.getState().choose(undefined);
    expect(s.getState().chosen).toBeUndefined();
  });

  test("a plan part's action is busy while it runs and keeps what it said; it reads again after", async () => {
    const { daemon } = fakeDaemon();
    const s = made(PlanAction.create(undefined));
    const reload = mock(() => undefined);
    let seen: boolean | undefined;
    const action = storeAction(s, daemon, false, reload);
    await action.run(
      async () => {
        seen = s.getState().busy;
        return { ok: true };
      },
      { done: "approved" },
    );
    expect([seen, s.getState().busy, s.getState().notice?.text, reload.mock.calls.length]).toEqual([
      true,
      false,
      "approved",
      1,
    ]);
    s.getState().closeNotice();
    expect(s.getState().notice).toBeUndefined();
  });
});

let grabbed: StoreApi<AskChangesState> | undefined;
function Grab() {
  grabbed = useScopedApi(AskChanges);
  return null;
}

describe("Ask for changes", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("typing draws the text box again; the button only when it opens; it sends the words trimmed", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const sent: string[] = [];
    const draws: Record<string, number> = {};
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <ScopeProvider store={AskChanges} init={undefined}>
          <Grab />
          {counted(draws, "text", <ChangesText />)}
          {counted(draws, "send", <SendChanges busy={false} onSend={(t) => sent.push(t)} />)}
        </ScopeProvider>,
      ),
    );
    const button = () => host.querySelector("button") as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    act(() => grabbed?.getState().write(" S"));
    act(() => grabbed?.getState().write(" S2 "));
    act(() => grabbed?.getState().write(" S2 needs "));
    expect(draws).toEqual({ text: 4, send: 2 });
    act(() => button().click());
    expect(sent).toEqual(["S2 needs"]);
    act(() => root.unmount());
  });
});
