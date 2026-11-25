/**
 * The place the hash route names (D7): read again on every move. A move also does what a move
 * means for the shell: what the last place said goes with it (`noticeAfterMove`), and `onMove`
 * (the drawer closes).
 */
import { useEffect, useState } from "react";
import { parseRoute, type Route } from "../shared/model/route.ts";
import { noticeAfterMove } from "../shared/notice.ts";
import { useLatest } from "../shared/use-latest.ts";

export function useRoute(onMove: (next: Route) => void): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const moved = useLatest(onMove);
  useEffect(() => {
    const onHash = () => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
      noticeAfterMove();
      moved.current(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
