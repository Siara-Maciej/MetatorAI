/**
 * What the Overview's System and Dependencies parts keep while they are shown (ADR-0113): the
 * system plan or the map chosen, and the Dependencies panel's action ("Notify both").
 */
import { type ActionState, IDLE } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";

/** The row chosen in the System part: a system plan's id, or "map". */
export interface SystemChoiceState {
  readonly chosen: string | undefined;
  choose(id: string): void;
}
export const SystemChoice = scopedStore<SystemChoiceState, undefined>("SystemChoice", () => (set) => ({
  chosen: undefined,
  choose: (id) => set({ chosen: id }),
}));
export const useSystemChoice = <T>(select: (s: SystemChoiceState) => T): T => useScoped(SystemChoice, select);

/** The Dependencies panel's action: busy, and what it answered until closed (D5). */
export interface LinksActionState extends ActionState {
  closeNotice(): void;
}
export const LinksAction = scopedStore<LinksActionState, undefined>("LinksAction", () => (set) => ({
  ...IDLE,
  closeNotice: () => set({ notice: undefined }),
}));
export const useLinksAction = <T>(select: (s: LinksActionState) => T): T => useScoped(LinksAction, select);
export const useLinksActionApi = () => useScopedApi(LinksAction);
