/**
 * A screen store's action as the `Action` the shared controls take (`runControls`, `<StartRun>`):
 * the request runs through `runAction`, so its busy and its notice are fields of the screen's store.
 */
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import type { Action } from "../../shared/hooks.ts";
import { type ActionState, runAction, sayIn } from "../../shared/state/action.ts";
import type { StoreApi } from "../../shared/state/scoped-store.ts";

/**
 * `busy` is what the caller read from the store (a part that draws a button subscribes to it);
 * `reload` reads the screen's data again after each answer. The notice is read when it is asked for.
 */
export function actionIn(
  store: StoreApi<ActionState>,
  daemon: Store<Pick<Daemon, "me" | "who">>,
  busy = false,
  reload?: () => unknown,
): Action {
  return {
    run: (fn, options = {}) => runAction(store, daemon, fn, reload ? { ...options, reload } : options),
    busy,
    get notice() {
      const notice = store.getState().notice;
      return { text: notice?.text, tone: notice?.tone ?? "error", onClose: () => sayIn(store, undefined) };
    },
    say: (text, tone) => sayIn(store, text, tone),
  };
}
