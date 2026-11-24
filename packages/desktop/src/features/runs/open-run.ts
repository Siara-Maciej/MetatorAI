/**
 * Opening a run's page, the same from every place that lists runs: its Terminal tab when the
 * person attaches or a pane is named, the tab its state calls for otherwise. "Attach and answer in
 * the pane" also says which run and pane: the run's Terminal tab attaches, focuses the pane and
 * scrolls to its question, then clears it (`answering`).
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { runTabFor } from "../../shared/model/runs.ts";
import { navigate } from "../../shared/navigation.ts";

export interface AnswerIn {
  readonly runId: string;
  readonly pane?: string | undefined;
}

const answerInStore = createStore<{ readonly answerIn: AnswerIn | undefined }>(() => ({
  answerIn: undefined,
}));

/** Opens a run: `attach` to answer in its pane, `pane` to show one of its panes. */
export function useOpenRun(): (runId: string, attach?: boolean, pane?: string) => void {
  const { run } = useDaemon("run");
  return (runId, attach = false, pane) => {
    const found = run(runId);
    navigate({
      screen: "run",
      runId,
      tab: attach || pane ? "terminal" : found ? runTabFor(found) : "overview",
      ...(pane ? { pane } : {}),
    });
    if (attach) answerInStore.setState({ answerIn: { runId, pane } });
  };
}

/** The pane the person answers in, when it is this run's. */
export const useAnswerIn = (runId: string): AnswerIn | undefined =>
  useStore(answerInStore, (s) => (s.answerIn?.runId === runId ? s.answerIn : undefined));

/** The Terminal tab took the person to the pane. */
export const answering = (): void => answerInStore.setState({ answerIn: undefined });
