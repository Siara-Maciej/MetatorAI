/**
 * Everything that needs the person, in one queue: the runs' questions, their terminals' asks and
 * the questions of panes without a run (`needsQueue`), then the reviews' cards (round 18). The
 * sidebar counts it, Home shows it one at a time, the keys step through it.
 */
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { type NeedRow, needPlace, needsQueue } from "../../shared/model/needs.ts";
import { sameRepo } from "../../shared/model/places.ts";
import type { Route } from "../../shared/model/route.ts";
import { threadPane } from "../../shared/model/threads.ts";
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

/** Where a need is answered (`needPlace`), with the open chats' terminals as the layout has them. */
export function useNeedPlace(): (n: NeedRow) => Route {
  const { threads, panes } = useDaemon("threads", "panes");
  return (n) =>
    needPlace(
      n,
      (pane, repo) =>
        threads.find((th) => {
          const chat = th.state === "open" ? threadPane(th, panes) : undefined;
          return chat?.id === pane && sameRepo(chat.repo, repo);
        })?.id,
    );
}
