/**
 * A plan part's action (ADR-0113): its store (`PlanAction`), the `Action` the shared buttons take
 * made from it, and its notice, drawn by a part of its own.
 */
import type { ReactNode } from "react";
import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import type { Action } from "../../shared/state/action.ts";
import { asAction } from "../../shared/state/action.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Notice } from "../../ui/notice.tsx";
import { PlanAction, usePlanAction, usePlanActionApi } from "./plans-state.ts";

/** A store for the action of the parts under it. */
export const PlanActionScope = ({ children }: { readonly children?: ReactNode }) => (
  <ScopeProvider store={PlanAction} init={undefined}>
    {children}
  </ScopeProvider>
);

/** The scope's action, read again after it with `reload`; the part draws again when `busy` changes. */
export function usePlanStoreAction(reload?: () => unknown): Action {
  const api = usePlanActionApi();
  const daemon = useDaemonStore();
  const busy = usePlanAction((s) => s.busy);
  return asAction(api, daemon, busy, reload);
}

/** What the scope's action answered, until closed. */
export function PlanActionNotice() {
  const notice = usePlanAction((s) => s.notice);
  const closeNotice = usePlanAction((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}
