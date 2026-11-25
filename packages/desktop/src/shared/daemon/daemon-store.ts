/**
 * The daemon's state as a store (ADR-0108): a part of the app subscribes to the fields it names
 * and draws again only when one of them changed. What is published is shared with what was there
 * (`shared`): a run that did not change is the same object as before.
 */
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import { shared } from "../api/query.ts";

export type Store<S> = StoreApi<S>;

export const createStateStore = <S extends object>(initial: S): Store<S> => createStore<S>(() => initial);

/** The next state, with every unchanged part kept; subscribers hear of it only if a part changed. */
export function publish<S extends object>(store: Store<S>, next: S): void {
  store.setState(shared(store.getState(), next), true);
}

/** The named fields of a state: what one subscriber reads. */
export function pick<S extends object, K extends keyof S>(state: S, keys: readonly K[]): Pick<S, K> {
  const out = {} as Pick<S, K>;
  for (const k of keys) out[k] = state[k];
  return out;
}

/** The named fields of a store, read by a component: it draws again only when one of them changed. */
export function useFields<S extends object, K extends keyof S>(
  store: Store<S>,
  keys: readonly K[],
): Pick<S, K> {
  return useStore(
    store,
    useShallow((state: S) => pick(state, keys)),
  );
}
