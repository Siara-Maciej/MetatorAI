import type { RunStatus } from "./run-record.ts";

/**
 * A plan item's progress from the run that carries it out (refactor moves, system steps): done
 * when the run is, blocked when it escalated or was aborted, running while it is active.
 */
export function progressOf<S extends string>(run: RunStatus, current: S): S | "done" | "blocked" | "running" {
  if (run === "done") return "done";
  if (run === "aborted" || run === "escalated") return "blocked";
  return current === "pending" ? "running" : current;
}
