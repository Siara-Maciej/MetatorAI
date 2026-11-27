import { useEffect, useState } from "react";

/**
 * The time now, every `ms` while `on`; frozen otherwise (a line that says "… ago" ticks only while
 * it shows, so a quiet window draws nothing). Each part that shows a time keeps its own clock.
 */
export function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, on]);
  return now;
}
