/**
 * What the plan views keep while they are shown (ADR-0113), a small store each: an action of a
 * plan part (Approve, Retry this step, Plan this step, Create Backlog item), the words of "Ask for
 * changes", the step chosen in a run's plan, and the step whose tile was clicked in a flow.
 */
import type { ActionState } from "../../shared/state/action.ts";
import { IDLE } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";

/** A plan part's action and nothing else: busy, and what it answered until closed (D5). */
export interface PlanActionState extends ActionState {
  closeNotice(): void;
}
export const PlanAction = scopedStore<PlanActionState, undefined>("PlanAction", () => (set) => ({
  ...IDLE,
  closeNotice: () => set({ notice: undefined }),
}));
export const usePlanAction = <T>(select: (s: PlanActionState) => T): T => useScoped(PlanAction, select);
export const usePlanActionApi = () => useScopedApi(PlanAction);

/** The words of "Ask for changes", being written. */
export interface AskChangesState {
  readonly text: string;
  write(text: string): void;
}
export const AskChanges = scopedStore<AskChangesState, undefined>("AskChanges", () => (set) => ({
  text: "",
  write: (text) => set({ text }),
}));
export const useAskChanges = <T>(select: (s: AskChangesState) => T): T => useScoped(AskChanges, select);

/** A step chosen in a list or a flow (its id), if any. */
export interface ChosenStepState {
  readonly chosen: string | undefined;
  choose(id: string | undefined): void;
}
export const ChosenStep = scopedStore<ChosenStepState, undefined>("ChosenStep", () => (set) => ({
  chosen: undefined,
  choose: (id) => set({ chosen: id }),
}));
export const useChosenStep = <T>(select: (s: ChosenStepState) => T): T => useScoped(ChosenStep, select);
