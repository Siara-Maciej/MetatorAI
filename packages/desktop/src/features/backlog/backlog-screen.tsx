/**
 * The backlog (S4, design/13 §4, mockup "Backlog"): proposals that wait for your decision and the
 * open tasks in one list, a parent's children right under it; the chosen one on the right with its
 * text, its analysis and its plan (each with a freshness badge), its children and what each waits
 * for, and the decision. An agent only proposes; the task exists after your "Add". Analyse, Make
 * plan and Implement each start an agent in a terminal of its own, and the app shows it (round 17).
 *
 * The screen only lays its parts out (ADR-0113): what it keeps is the Backlog store (`state.ts`),
 * and each part reads only the value it draws.
 */
import { useEffect } from "react";
import { Freshness } from "../../shared/components/freshness.tsx";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { useDaemon, useDaemonStore, usePolled } from "../../shared/daemon/daemon.tsx";
import { plural } from "../../shared/model/format.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { ListDetail } from "../../ui/list-detail.tsx";
import { Notice } from "../../ui/notice.tsx";
import { START_FROM_COMMIT } from "../runs/model.ts";
import { useOpenRun } from "../runs/open-run.ts";
import { BacklogList } from "./backlog-list.tsx";
import { useIssues } from "./data.ts";
import { dropBacklogDraft, useBacklogDraft } from "./draft.ts";
import { BacklogDetail } from "./item-detail.tsx";
import { backlogRows } from "./model.ts";
import { Backlog, issuesKey, useBacklog } from "./state.ts";

export function BacklogScreen({
  id,
}: {
  /** The item chosen by the route (a plan view's "Open its Backlog item"). */
  readonly id?: string | undefined;
}) {
  const daemon = useDaemonStore();
  const openRun = useOpenRun();
  // "New task from here…": the draft fills the form when the screen opens and goes when it is left.
  const draft = useBacklogDraft();
  useEffect(() => dropBacklogDraft, []);
  return (
    <ScopeProvider store={Backlog} init={{ daemon, routeId: id, draft, openRun }}>
      <RouteToItem id={id} />
      <ListDetail
        className="backlog"
        testId="backlog"
        listLabel="tasks"
        top={<BacklogTop />}
        list={<BacklogList />}
      >
        <BacklogNotice />
        <TasksFreshness />
        <BacklogDetail />
      </ListDetail>
    </ScopeProvider>
  );
}

/** The route's item wins when the route changes (a plan view's "Open its Backlog item"). */
function RouteToItem({ id }: { readonly id: string | undefined }) {
  const routeTo = useBacklog((s) => s.routeTo);
  useEffect(() => routeTo(id), [id, routeTo]);
  return null;
}

function BacklogTop() {
  return (
    <>
      <b>Backlog</b>
      <span className="dim">.metator/issues</span>
      <ProposalsWaiting />
      <span className="spacer" />
      <RepoSelect />
      <AddTaskButton />
    </>
  );
}

function ProposalsWaiting() {
  const waiting = useIssues((issues) => backlogRows(issues ?? []).proposals.filter((r) => !r.child).length);
  return waiting > 0 ? (
    <span className="amber">
      {plural(waiting, "proposal")} wait{waiting === 1 ? "s" : ""} for you
    </span>
  ) : null;
}

function AddTaskButton() {
  const openForm = useBacklog((s) => s.openForm);
  return <Button onClick={openForm}>+ task</Button>;
}

/** What the last action answered: it stays until closed (D5); a dirty-tree refusal offers the start again. */
function BacklogNotice() {
  const notice = useBacklog((s) => s.notice);
  const retry = useBacklog((s) => s.retry);
  const closeNotice = useBacklog((s) => s.closeNotice);
  return (
    <Notice
      text={notice?.text}
      tone={notice?.tone ?? "error"}
      action={retry ? { label: START_FROM_COMMIT, run: retry } : undefined}
      onClose={closeNotice}
    />
  );
}

/** A failed read of the tasks, or stale ones: one line. */
function TasksFreshness() {
  const { client, repo } = useDaemon("client", "repo");
  const list = usePolled(issuesKey(repo), () => client.issues(repo), 2000);
  return <Freshness reads={[list]} what="The tasks" />;
}
