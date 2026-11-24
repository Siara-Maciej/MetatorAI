/**
 * What happens after a card on Home took its answer. "Attach and answer in the pane": the person
 * goes to the run's pane, holding its keyboard. Otherwise Home goes on to the next decision (when
 * the person is still on Home), and what the run did with the answer is read back and said: a
 * Reject may have escalated it. Only the latest answer's confirmation speaks (confirm.ts).
 */
import { DaemonClient, type InboxItem } from "../../shared/api/api.ts";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { sessionStore } from "../../shared/daemon/session.ts";
import { goesToPane, paneOfQuestion } from "../../shared/model/needs.ts";
import { flattenState, sameRepo } from "../../shared/model/places.ts";
import { navigate } from "../../shared/navigation.ts";
import { say } from "../../shared/notice.ts";
import { useOpenRun } from "../runs/open-run.ts";
import { createConfirmer } from "./confirm.ts";
import { afterAnswer } from "./model.ts";

const confirmer = createConfirmer({
  read: async (runId, repo) =>
    flattenState((await new DaemonClient(sessionStore().getState().url).state()).data).runs.find(
      (x) => x.runId === runId && sameRepo(x.repo, repo),
    ),
  say: (text) => say({ text, tone: "info", sticky: true }),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
});

export function useAnswered(): (choices?: readonly string[], item?: InboxItem) => void {
  const { panes } = useDaemon("panes");
  const openRun = useOpenRun();
  return (choices, item) => {
    if (item && goesToPane(item.question, choices?.[0])) {
      openRun(item.runId, true, paneOfQuestion(item.question, panes));
      say({
        text: "You hold the keyboard of the run: answer the host in its pane, then release it to the agent.",
        tone: "info",
        sticky: true,
      });
      return;
    }
    const back = afterAnswer(window.location.hash);
    if (back) navigate(back);
    if (!choices || !item) {
      say(undefined);
      return;
    }
    void confirmer.confirm(choices, item);
  };
}
