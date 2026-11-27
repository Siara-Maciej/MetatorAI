/**
 * A store per screen (ADR-0113): what one screen keeps (the item chosen, a form being written, a
 * fold) is a zustand store made when the screen opens and dropped when it closes, given to its
 * parts through `<ScopeProvider>`. A part reads the one value it draws through a selector and
 * draws again only when that value changed; an event handler reads or changes the store at that
 * moment through `useScopedApi`, without subscribing. Two copies of a screen have two stores.
 *
 * A screen defines its store once (`scopedStore`) and its own hooks at the top of its module:
 *
 *     export const Backlog = scopedStore("Backlog", (init: BacklogInit) => (set, get) => ({ ... }));
 *     export const useBacklog = <T,>(select: (s: BacklogState) => T): T => useScoped(Backlog, select);
 */
import { type Context, createContext, createElement, type ReactNode, useContext, useState } from "react";
import { useStore } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";

export type { StoreApi };

/** A screen's store as data: how to make it, and the context its parts find it through. */
export interface ScopedStore<S, I> {
  readonly name: string;
  readonly create: (init: I) => StateCreator<S>;
  readonly context: Context<StoreApi<S> | null>;
}

/**
 * Defines a store made per provider. `create` gets what the screen knows when it opens (`init`:
 * the route's id, the daemon's store) and returns zustand's state creator: the values and the
 * actions that change them, in one place.
 */
export function scopedStore<S extends object, I>(
  name: string,
  create: (init: I) => StateCreator<S>,
): ScopedStore<S, I> {
  const context = createContext<StoreApi<S> | null>(null);
  context.displayName = name;
  return { name, create, context };
}

/** Makes the store once, from `init`, for the parts under it; a later `init` is not read. */
export function ScopeProvider<S extends object, I>({
  store,
  init,
  children,
}: {
  readonly store: ScopedStore<S, I>;
  readonly init: I;
  readonly children?: ReactNode;
}): ReactNode {
  // The store lives as long as the screen: made on the first draw, never again.
  const [api] = useState(() => createStore<S>()(store.create(init)));
  return createElement(store.context.Provider, { value: api }, children);
}

/** The store, to read or change at the moment of an event: no subscription, no drawing. */
export function useScopedApi<S, I>(store: ScopedStore<S, I>): StoreApi<S> {
  const api = useContext(store.context);
  if (!api) throw new Error(`${store.name}: used outside its <ScopeProvider>`);
  return api;
}

/** One value of the state: the part draws again only when it is another value (`Object.is`). */
export function useScoped<S, I, T>(store: ScopedStore<S, I>, select: (state: S) => T): T {
  return useStore(useScopedApi(store), select);
}
