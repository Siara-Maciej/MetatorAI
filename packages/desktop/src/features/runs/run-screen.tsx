/**
 * The page about one run, in two kinds. A task's page (a system run, a run with child runs; level
 * 2) is how the task goes: Overview (the one thing to decide, the flow, the steps by repository) ·
 * Changes · Activity. A step's page (a step, a child run, a run of its own; level 3) is what the
 * agent does: Overview (its question, its plan read-only, its artefacts) · Terminal · Changes ·
 * Activity, with a breadcrumb back to its task. The head says the first level only; what the run
 * is goes in its Details. The routes a run's screens once had (the Plan tab too) still lead here.
 */

import { useEffect } from "react";
import { Chip } from "../../shared/components/chips.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { useAction, useTasks } from "../../shared/hooks.ts";
import { duration } from "../../shared/model/format.ts";
import { plainKey } from "../../shared/model/keys.ts";
import { idleRuns } from "../../shared/model/needs.ts";
import { paneStateOf, panesOfRun } from "../../shared/model/panes.ts";
import { type Route, type RunTab, routeHash, tabsOf } from "../../shared/model/route.ts";
import { finishedText, runWithPanes } from "../../shared/model/runs.ts";
import { runPage } from "../../shared/model/tasks.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { EscalatedActions } from "../inbox/escalated-card.tsx";
import { SystemRunBar } from "../plans/system-run-bar.tsx";
import { ActivityList } from "./activity-list.tsx";
import { ChangesTab } from "./changes-tab.tsx";
import { asksWithoutSession, autonomyLabel, conductorMoves, runPhase } from "./model.ts";
import { OverviewTab } from "./overview-tab.tsx";
import { useRunControls } from "./run-controls.ts";
import { RunHeader } from "./run-header.tsx";
import { StartRun } from "./start-run.tsx";
import { StopReason } from "./stop-reason.tsx";
import { TaskOverview } from "./task-overview.tsx";
import { TerminalTab } from "./terminal-tab.tsx";

export function RunScreen({
  runId,
  tab,
  pane,
  file,
  go,
  onOpenRun,
  answerIn,
  onAnswering,
}: {
  readonly runId: string;
  readonly tab: RunTab;
  readonly pane?: string | undefined;
  /** The person chose to answer in a pane of this run: the Terminal tab takes them there. */
  readonly answerIn?: { readonly pane?: string | undefined } | undefined;
  onAnswering?: (() => void) | undefined;
  readonly file?: string | undefined;
  go(route: Route): void;
  /** Another run's page (a parent, a step), or this one's terminal with the keyboard taken. */
  onOpenRun(runId: string, attach?: boolean): void;
}) {
  const { run: runOf, markSeen, panesOf } = useDaemon("run", "markSeen", "panesOf");
  const run = runOf(runId);
  const tasks = useTasks();
  const fine = run
    ? runWithPanes(
        run,
        panesOfRun(panesOf(run.repo), run.runId).map((p) => paneStateOf(p)),
      )
    : "idle";
  const page = run ? runPage(run, fine, tasks, (id) => runOf(id)) : undefined;
  const isTask = page?.task ?? false;
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
      const to = tabsOf(isTask).find((t) => t.key === k);
      if (to) go({ screen: "run", runId, tab: to.tab });
      if (k === "e") void openEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const phase = run ? runPhase(run) : "active";
  return (
    <div className="run-screen" data-testid="run" data-tab={tab}>
      <RunHeader
        runId={runId}
        run={run}
        tab={tab}
        task={isTask}
        title={page?.title ?? runId}
        state={page?.state ?? "blocked"}
        why={page?.why}
        progress={page?.progress ?? { done: 0, of: 0, text: "" }}
        partOf={
          page?.partOf
            ? {
                title: page.partOf.title,
                href: page.partOf.runId
                  ? routeHash({ screen: "run", runId: page.partOf.runId, tab: "overview" })
                  : routeHash({ screen: "board", task: page.partOf.key }),
              }
            : undefined
        }
        details={
          run ? (
            <>
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
                <Chip>{fine}</Chip>
              </div>
              <SystemRunBar run={run} />
            </>
          ) : null
        }
      />
      {run && phase === "escalated" ? (
        <div className="driverbar escalated" data-testid="driverbar">
          <strong>Escalated at {run.stage}</strong>
          <span className="note">
            <StopReason reason={run.reason} stop={run.stop} testId="escalated-reason" />
          </span>
          <EscalatedActions run={run} />
        </div>
      ) : run && asksWithoutSession(run, panesOf(run.repo)) ? (
        // Its question waits on its card; its conductor can still be opened, the question stays.
        <StartRun
          run={run}
          action={action}
          sessionOnly
          onStarted={(how) => (how === "session" ? go({ screen: "run", runId, tab: "terminal" }) : undefined)}
        />
      ) : run && idleRuns([run], panesOf(run.repo)).length > 0 ? (
        <StartRun
          run={run}
          action={action}
          onStarted={(how) => (how === "session" ? go({ screen: "run", runId, tab: "terminal" }) : undefined)}
        />
      ) : run && phase === "finished" ? (
        <div className={`driverbar finished ${run.status}`} data-testid="driverbar">
          <strong>{run.status === "done" ? "Done" : "Aborted"}</strong>
          <span className="note">{finishedText(run)}</span>
        </div>
      ) : null}
      <Notice {...action.notice} />
      {run && conductorMoves(run, panesOf(run.repo)) ? (
        <div className="driverbar conductor" data-testid="conductor-moves">
          <strong>Conductor</strong>
          <span className="note">
            The conductor moves this run on at {run.stage}: talk to it in its terminal.
          </span>
          {tab !== "terminal" ? (
            <Button onClick={() => go({ screen: "run", runId, tab: "terminal" })}>Open the terminal</Button>
          ) : null}
        </div>
      ) : null}
      <div className="run-tab">
        {!run ? (
          // A run just started is not in the state yet: its files are asked for once it is, in its repository.
          <div className="empty" data-testid="run-not-yet">
            Run <span className="mono">{runId}</span> is not in the state yet: it appears here in a moment.
          </div>
        ) : null}
        {run && tab === "overview" && isTask ? (
          <TaskOverview
            run={run}
            onOpenRun={(id) => onOpenRun(id)}
            onOpenChanges={(id) => go({ screen: "run", runId: id, tab: "changes" })}
          />
        ) : null}
        {run && tab === "overview" && !isTask ? (
          <OverviewTab
            run={run}
            runId={runId}
            onOpenRun={onOpenRun}
            onOpenPane={(p) => go({ screen: "grid", pane: p })}
          />
        ) : null}
        {tab === "terminal" ? (
          run ? (
            <TerminalTab
              run={run}
              pane={pane}
              answerIn={answerIn}
              onAnswering={onAnswering}
              onOpenRun={onOpenRun}
              onOpenChanges={(id) => go({ screen: "run", runId: id, tab: "changes" })}
            />
          ) : null
        ) : null}
        {run && tab === "changes" ? (
          <ChangesTab
            run={run}
            runId={runId}
            file={file}
            onOpenFile={(id, f) =>
              go({ screen: "run", runId: id, tab: "changes", ...(f ? { file: f } : {}) })
            }
          />
        ) : null}
        {run && tab === "activity" ? <ActivityTab runId={runId} repo={repo} /> : null}
      </div>
    </div>
  );
}

/** Everything the run did, newest last: the time, the type, where it came from, what happened. */
function ActivityTab({ runId, repo }: { readonly runId: string; readonly repo: string | undefined }) {
  const { client } = useDaemon("client");
  const { data, error } = usePolled(
    `activity:${repo ?? ""}:${runId}`,
    () => client.activity(runId, repo),
    2000,
  );
  return (
    <>
      {error && !data ? <div className="banner">{error}</div> : null}
      <ActivityList
        entries={data?.entries ?? []}
        variant="table"
        empty={data ? "Nothing happened yet." : undefined}
      />
    </>
  );
}
