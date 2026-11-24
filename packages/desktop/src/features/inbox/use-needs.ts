/**
 * Everything that needs the person, in one queue: the runs' questions, their terminals' asks and
 * the questions of panes without a run (`needsQueue`), then the reviews' cards (round 18). The
 * sidebar counts it, Home shows it one at a time, the keys step through it.
 */
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { type NeedRow, needsQueue } from "../../shared/model/needs.ts";
import { reviewNeeds } from "../reviews/model.ts";

export function useNeeds(): readonly NeedRow[] {
  const { inbox, runs, panes, paneAsks, reviewCards } = useDaemon(
    "inbox",
    "runs",
    "panes",
    "paneAsks",
    "reviewCards",
  );
  return [...needsQueue(inbox, runs, panes, paneAsks), ...reviewNeeds(reviewCards)];
}
