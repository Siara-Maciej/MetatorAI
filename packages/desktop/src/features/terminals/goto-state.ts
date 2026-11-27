/**
 * What the go-to picker keeps while it is open (ADR-0113): the words typed, the state chosen and
 * the row pointed at. Made when the picker opens, so it opens empty every time.
 */
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import type { GotoFilter } from "./model.ts";

export interface GotoState {
  readonly query: string;
  readonly filter: GotoFilter;
  /** The row Enter goes to. */
  readonly index: number;
  /** Words typed: the first row is pointed at. */
  type(query: string): void;
  /** A state chosen: the first row is pointed at. */
  choose(filter: GotoFilter): void;
  /** One row down (1) or up (-1), within the `count` rows shown. */
  move(step: 1 | -1, count: number): void;
  point(index: number): void;
}

export const Goto = scopedStore<GotoState, undefined>("Goto", () => (set) => ({
  query: "",
  filter: "all",
  index: 0,
  type: (query) => set({ query, index: 0 }),
  choose: (filter) => set({ filter, index: 0 }),
  move: (step, count) =>
    set((s) => ({ index: step === 1 ? Math.min(count - 1, s.index + 1) : Math.max(0, s.index - 1) })),
  point: (index) => set({ index }),
}));

export const useGoto = <T>(select: (s: GotoState) => T): T => useScoped(Goto, select);
export const useGotoApi = () => useScopedApi(Goto);
