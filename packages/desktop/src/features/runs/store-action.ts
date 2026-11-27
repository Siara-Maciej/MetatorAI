/**
 * A screen store's action (ADR-0113) as the `Action` the shared run controls take (`runControls`,
 * `StartRun`, `FromPlanButton`): the request runs through `runAction`, so `busy` and the notice are
 * fields of the screen's store and only the parts that show them draw again.
 */
import type { StoreApi } from "zustand/vanilla";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import type { Action } from "../../shared/hooks.ts";
import { type ActionState, runAction, sayIn } from "../../shared/state/action.ts";

/**
 * `busy` is the value the calling part read from the store (it draws again when it changes); the
 * notice is the store's at this moment: a screen shows its notice in a part of its own.
 */
export function storeAction(
  api: StoreApi<ActionState>,
  daemon: Store<Pick<Daemon, "me" | "who">>,
  busy: boolean,
  reload?: () => unknown,
): Action {
  const notice = api.getState().notice;
  return {
    run: (fn, options = {}) => runAction(api, daemon, fn, reload ? { ...options, reload } : options),
    busy,
    notice: { text: notice?.text, tone: notice?.tone ?? "error", onClose: () => sayIn(api, undefined) },
    say: (text, tone = "error") => sayIn(api, text, tone),
  };
}
