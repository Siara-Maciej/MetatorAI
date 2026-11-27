/**
 * The place the hash route names (D7): app-wide state (ADR-0113), a store outside React fed by
 * `hashchange`. A part reads the piece of the route it draws (`useRouteOf`) and draws again only
 * when that changed. A move also does what a move means for the shell: what the last place said
 * goes with it (`noticeAfterMove`), and `onMove` (the drawer closes).
 */
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { shared } from "../shared/api/query.ts";
import { parseRoute, type Route } from "../shared/model/route.ts";
import { noticeAfterMove } from "../shared/notice.ts";
import { useLatest } from "../shared/use-latest.ts";

/** The window's route, made on first use (a test imports this without a window). */
let made: StoreApi<{ readonly route: Route }> | undefined;
const routeStore = () => (made ??= createStore(() => ({ route: parseRoute(window.location.hash) })));

/** The route as the window's address says it now: an equal one keeps its object. */
function readHash(): Route {
  const store = routeStore();
  store.setState((s) => ({ route: shared(s.route, parseRoute(window.location.hash)) }));
  return store.getState().route;
}

/** The whole route: for a part that draws whatever it names (the screens). */
export const useRoute = (): Route => useStore(routeStore(), (s) => s.route);

/** One piece of the route: the part draws again only when it changed. */
export const useRouteOf = <T>(select: (route: Route) => T): T =>
  useStore(routeStore(), (s) => select(s.route));

/** Listens to the window's moves while the shell is there; `onMove` hears each. */
export function useRouteListener(onMove: (next: Route) => void): void {
  const moved = useLatest(onMove);
  useEffect(() => {
    // What the address says now: it may have changed while nothing listened.
    readHash();
    const onHash = () => {
      const next = readHash();
      noticeAfterMove();
      moved.current(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
}
