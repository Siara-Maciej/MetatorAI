/**
 * What a click on a sidebar row does, read from the daemon's state at the moment of the click (no
 * row draws again for it): an escalated run's card is on Home, a run that asks on a card opens that
 * decision, any other run opens its page; a thread opens its chat.
 */
import { useOpenRun } from "../../features/runs/open-run.ts";
import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { decisionKey } from "../../shared/model/needs.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { navigate } from "../../shared/navigation.ts";

export interface SideActs {
  /** An escalated run's card is on Home; any other run opens its page (at `pane`). */
  onRun(runId: string, repo: string | undefined, pane?: string): void;
  /** A run that asks on a card opens that decision on Home, exactly that one; else as `onRun`. */
  openDecisionOr(runId: string, repo: string | undefined, pane?: string): void;
}

export function useSideActs(): SideActs {
  const daemon = useDaemonStore();
  const openRun = useOpenRun();
  const onRun = (runId: string, repo: string | undefined, pane?: string) => {
    const r = daemon.getState().runs.find((x) => x.runId === runId && sameRepo(x.repo, repo));
    if (r?.status === "escalated") navigate({ screen: "inbox", pick: `escalated:${repo ?? ""}:${runId}` });
    else openRun(runId, false, pane);
  };
  return {
    onRun,
    openDecisionOr: (runId, repo, pane) => {
      const d = daemon.getState().inbox.find((i) => i.runId === runId && sameRepo(i.repo, repo));
      if (d) navigate({ screen: "inbox", pick: decisionKey(d) });
      else onRun(runId, repo, pane);
    },
  };
}

/** A thread's chat. */
export const openThread = (id: string): void => navigate({ screen: "thread", id });
