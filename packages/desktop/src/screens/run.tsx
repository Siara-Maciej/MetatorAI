/**
 * The page about one run: one header and five tabs. Overview is what happened since you left and
 * what the run needs; Terminal is its live session; Plan, Changes and Activity are where it
 * stands, what it changed and everything it did. The routes a run's four screens once had still
 * lead here, each to its tab.
 */
import { useEffect } from "react";
import { ActivityList } from "../components/activity-list.tsx";
import { Chip } from "../components/chips.tsx";
import { Notice } from "../components/common.tsx";
import { EscalatedActions } from "../components/escalated-card.tsx";
import { RunHeader } from "../components/run-header.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction, useRunControls } from "../hooks.ts";
import {
  autonomyLabel,
  duration,
  finishedText,
  plainKey,
  RUN_TABS,
  type Route,
  type RunTab,
  runPhase,
} from "../model.ts";
import { ChangesTab } from "../run/changes-tab.tsx";
import { OverviewTab } from "../run/overview-tab.tsx";
import { PlanTab } from "../run/plan-tab.tsx";
import { TerminalTab } from "../run/terminal-tab.tsx";

export function RunScreen({
  runId,
  tab,
  pane,
  file,
  go,
  onOpenRun,
}: {
  readonly runId: string;
  readonly tab: RunTab;
  readonly pane?: string | undefined;
  readonly file?: string | undefined;
  go(route: Route): void;
  /** Another run's page (a parent, a step), or this one's terminal with the keyboard taken. */
  onOpenRun(runId: string, attach?: boolean): void;
}) {
  const { run: runOf, markSeen } = useDaemon();
  const run = runOf(runId);
  const action = useAction();
  const { openEditor } = useRunControls(run, action);
  // The person looks at the run now: a finished run stops reading `done` in the sidebar.
  const repo = run?.repo;
  const updatedAt = run?.updatedAt;
  useEffect(() => {
    void updatedAt;
    markSeen({ runId, repo });
  }, [runId, repo, updatedAt, markSeen]);
  // One letter per tab, and `e` for the editor; the same letters mean the same on every tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      const k = plainKey(e);
      const to = RUN_TABS.find((t) => t.key === k);
      if (to) go({ screen: "run", runId, tab: to.tab });
      if (k === "e") void openEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const phase = run ? runPhase(run) : "active";
  return (
    <div className="run-screen" data-testid="run" data-tab={tab}>
      <RunHeader runId={runId} run={run} tab={tab} showStages={tab !== "plan"}>
        {run ? (
          <div className="chips">
            {run.repo ? <Chip>{run.repo}</Chip> : null}
            <Chip>{run.workflow}</Chip>
            <Chip>{autonomyLabel(run.autonomy)}</Chip>
            <Chip>{run.host ?? "no host"}</Chip>
            {run.worktree?.ports ? (
              <Chip>
                ports {run.worktree.ports.from}–{run.worktree.ports.from + run.worktree.ports.count - 1}
              </Chip>
            ) : null}
            <Chip>{duration(run.elapsedMs)}</Chip>
            {run.died ? <Chip tone="red">drive died</Chip> : null}
          </div>
        ) : null}
      </RunHeader>
      {run && phase === "escalated" ? (
        <div className="driverbar escalated" data-testid="driverbar">
          <strong>Escalated at {run.stage}</strong>
          <span className="note" data-testid="escalated-reason">
            {run.reason ?? "The run recorded no reason. Its activity shows what happened last."}
          </span>
          <EscalatedActions run={run} />
        </div>
      ) : run && phase === "finished" ? (
        <div className={`driverbar finished ${run.status}`} data-testid="driverbar">
          <strong>{run.status === "done" ? "Done" : "Aborted"}</strong>
          <span className="note">{finishedText(run)}</span>
        </div>
      ) : null}
      <Notice {...action.notice} />
      <div className="run-tab">
        {tab === "overview" ? <OverviewTab run={run} runId={runId} onOpenRun={onOpenRun} /> : null}
        {tab === "terminal" ? (
          run ? (
            <TerminalTab
              run={run}
              pane={pane}
              onOpenRun={onOpenRun}
              onOpenChanges={(id) => go({ screen: "run", runId: id, tab: "changes" })}
            />
          ) : (
            <div className="empty">Run {runId} is not in the state yet.</div>
          )
        ) : null}
        {tab === "plan" ? (
          <PlanTab
            run={run}
            runId={runId}
            onOpenPane={(p) => go({ screen: "grid", pane: p })}
            onOpenRun={onOpenRun}
          />
        ) : null}
        {tab === "changes" ? (
          <ChangesTab
            run={run}
            runId={runId}
            file={file}
            onOpenFile={(id, f) => go({ screen: "run", runId: id, tab: "changes", ...(f ? { file: f } : {}) })}
          />
        ) : null}
        {tab === "activity" ? <ActivityTab runId={runId} repo={repo} /> : null}
      </div>
    </div>
  );
}

/** Everything the run did, newest last: the time, the type, where it came from, what happened. */
function ActivityTab({ runId, repo }: { readonly runId: string; readonly repo: string | undefined }) {
  const { client } = useDaemon();
  const { data, error } = usePolled(`activity:${repo ?? ""}:${runId}`, () => client.activity(runId, repo), 2000);
  return (
    <>
      {error && !data ? <div className="banner">{error}</div> : null}
      <ActivityList entries={data?.entries ?? []} variant="table" empty={data ? "Nothing happened yet." : undefined} />
    </>
  );
}
