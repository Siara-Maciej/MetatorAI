/**
 * The page about one run, in two kinds. A task's page (a system run, a run with child runs; level
 * 2) is how the task goes: Overview (the one thing to decide, the flow, the steps by repository) ·
 * Changes · Activity. A step's page (a step, a child run, a run of its own; level 3) is what the
 * agent does: Overview (its question, its plan read-only, its artefacts) · Terminal · Changes ·
 * Activity, with a breadcrumb back to its task. The head says the first level only; what the run
 * is goes in its Details. The routes a run's screens once had (the Plan tab too) still lead here.
 *
 * The page only lays its parts out (ADR-0113): its action is the RunPage store's, and each part
 * reads the one run (`useRun`) or the one pane fact it draws, so another run or pane changing
 * draws none of it again.
 */

import { useEffect } from "react";
import { useStore } from "zustand";
import { Chip } from "../../shared/components/chips.tsx";
import { NotFound } from "../../shared/components/not-found.tsx";
import { type Daemon, useDaemon, useDaemonStore, usePolled, useRun } from "../../shared/daemon/daemon.tsx";
import { useFound, useTasks } from "../../shared/hooks.ts";
import { duration } from "../../shared/model/format.ts";
import { stateHasRun } from "../../shared/model/found.ts";
import { plainKey } from "../../shared/model/keys.ts";
import { idleRuns } from "../../shared/model/needs.ts";
import { paneStateOf, panesOfRun } from "../../shared/model/panes.ts";
import { type RunTab, routeHash, tabsOf } from "../../shared/model/route.ts";
import { finishedText, type Run, runWithPanes } from "../../shared/model/runs.ts";
import { runPage } from "../../shared/model/tasks.ts";
import { navigate } from "../../shared/navigation.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { EscalatedActions } from "../inbox/escalated-card.tsx";
import { SystemRunBar } from "../plans/system-run-bar.tsx";
import { ActivityList } from "./activity-list.tsx";
import { ChangesTab } from "./changes-tab.tsx";
import { asksWithoutSession, autonomyLabel, conductorMoves, runPhase } from "./model.ts";
import { answering as onAnswering, useAnswerIn, useOpenRun } from "./open-run.ts";
import { OverviewTab } from "./overview-tab.tsx";
import { useRunControls } from "./run-controls.ts";
import { RunHeader } from "./run-header.tsx";
import { RunPage, useRunPage, useRunPageApi } from "./run-parts-state.ts";
import { StartRun } from "./start-run.tsx";
import { StopReason } from "./stop-reason.tsx";
import { storeAction } from "./store-action.ts";
import { TaskOverview } from "./task-overview.tsx";
import { TerminalTab } from "./terminal-tab.tsx";

const go = navigate;

export function RunScreen({
  runId,
  tab,
  pane,
  file,
}: {
  readonly runId: string;
  readonly tab: RunTab;
  readonly pane?: string | undefined;
  readonly file?: string | undefined;
}) {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={RunPage} init={{ daemon }}>
      <RunPageParts runId={runId} tab={tab} pane={pane} file={file} />
    </ScopeProvider>
  );
}

function RunPageParts({
  runId,
  tab,
  pane,
  file,
}: {
  readonly runId: string;
  readonly tab: RunTab;
  readonly pane: string | undefined;
  readonly file: string | undefined;
}) {
  const { client } = useDaemon("client");
  const present = useFact((d) => d.run(runId) !== undefined);
  // A run the state does not hold yet may have just been made: missing only on the daemon's word.
  const lookup = useFound(`run:${runId}`, present, client.state, (s) => stateHasRun(s, runId));
  if (lookup === "missing") return <NotFound what="run" id={runId} />;
  return (
    <div className="run-screen" data-testid="run" data-tab={tab}>
      <SeenMarker runId={runId} />
      <TabKeys runId={runId} />
      <PageHead runId={runId} tab={tab} />
      <DriverBar runId={runId} />
      <PageNotice />
      <ConductorBar runId={runId} tab={tab} />
      <div className="run-tab">
        <TabBody runId={runId} tab={tab} pane={pane} file={file} />
      </div>
    </div>
  );
}

/** One fact of the daemon's state: the part draws again only when it changed (a primitive, or a kept object). */
const useFact = <T,>(select: (d: Daemon) => T): T => useStore(useDaemonStore(), select);

/** The run's own word with its panes (`runWithPanes`): "idle" while the run is not here. */
const fineOf = (d: Daemon, runId: string): string => {
  const run = d.run(runId);
  return run
    ? runWithPanes(
        run,
        panesOfRun(d.panesOf(run.repo), run.runId).map((p) => paneStateOf(p)),
      )
    : "idle";
};

/** What the page is about: a task's page or a step's, its title, state and progress. */
function usePage(runId: string) {
  const run = useRun(runId);
  const fine = useFact((d) => fineOf(d, runId));
  const tasks = useTasks();
  const { run: runOf } = useDaemon("run");
  return run ? runPage(run, fine, tasks, (id) => runOf(id)) : undefined;
}

/** Whether this is a task's page (its tabs, its Overview). */
const useIsTask = (runId: string): boolean => usePage(runId)?.task ?? false;

/** The page's action as the run's controls take it: its busy and notice are the page store's. */
function usePageControls(run: Run | undefined) {
  const api = useRunPageApi();
  const daemon = useDaemonStore();
  const busy = useRunPage((s) => s.busy);
  const action = storeAction(api, daemon, busy);
  return { action, controls: useRunControls(run, action) };
}

/** The person looks at the run now: a finished run stops reading `done` in the sidebar. */
function SeenMarker({ runId }: { readonly runId: string }) {
  const run = useRun(runId);
  const { markSeen } = useDaemon("markSeen");
  const repo = run?.repo;
  const updatedAt = run?.updatedAt;
  useEffect(() => {
    void updatedAt;
    markSeen({ runId, repo });
  }, [runId, repo, updatedAt, markSeen]);
  return null;
}

/** One letter per tab, and `e` for the editor; the same letters mean the same on every tab. */
function TabKeys({ runId }: { readonly runId: string }) {
  const isTask = useIsTask(runId);
  const { controls } = usePageControls(useRun(runId));
  const { openEditor } = controls;
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
  return null;
}

function PageHead({ runId, tab }: { readonly runId: string; readonly tab: RunTab }) {
  const run = useRun(runId);
  const page = usePage(runId);
  const fine = useFact((d) => fineOf(d, runId));
  return (
    <RunHeader
      runId={runId}
      run={run}
      tab={tab}
      task={page?.task ?? false}
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
  );
}

/** What drives the run: why it escalated, a start when nothing does, or how it finished. */
function DriverBar({ runId }: { readonly runId: string }) {
  const run = useRun(runId);
  const asks = useFact((d) => {
    const r = d.run(runId);
    return r ? asksWithoutSession(r, d.panesOf(r.repo)) : false;
  });
  const idle = useFact((d) => {
    const r = d.run(runId);
    return r ? idleRuns([r], d.panesOf(r.repo)).length > 0 : false;
  });
  const { action } = usePageControls(run);
  const phase = run ? runPhase(run) : "active";
  const onStarted = (how: "session" | "drive") =>
    how === "session" ? go({ screen: "run", runId, tab: "terminal" }) : undefined;
  if (!run) return null;
  if (phase === "escalated")
    return (
      <div className="driverbar escalated" data-testid="driverbar">
        <strong>Escalated at {run.stage}</strong>
        <span className="note">
          <StopReason reason={run.reason} stop={run.stop} testId="escalated-reason" />
        </span>
        <EscalatedActions run={run} />
      </div>
    );
  // Its question waits on its card; its conductor can still be opened, the question stays.
  if (asks) return <StartRun run={run} action={action} sessionOnly onStarted={onStarted} />;
  if (idle) return <StartRun run={run} action={action} onStarted={onStarted} />;
  if (phase === "finished")
    return (
      <div className={`driverbar finished ${run.status}`} data-testid="driverbar">
        <strong>{run.status === "done" ? "Done" : "Aborted"}</strong>
        <span className="note">{finishedText(run)}</span>
      </div>
    );
  return null;
}

function PageNotice() {
  const notice = useRunPage((s) => s.notice);
  const closeNotice = useRunPage((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

function ConductorBar({ runId, tab }: { readonly runId: string; readonly tab: RunTab }) {
  const moves = useFact((d) => {
    const r = d.run(runId);
    return r ? conductorMoves(r, d.panesOf(r.repo)) : false;
  });
  const stage = useFact((d) => d.run(runId)?.stage);
  return moves ? (
    <div className="driverbar conductor" data-testid="conductor-moves">
      <strong>Conductor</strong>
      <span className="note">The conductor moves this run on at {stage}: talk to it in its terminal.</span>
      {tab !== "terminal" ? (
        <Button onClick={() => go({ screen: "run", runId, tab: "terminal" })}>Open the terminal</Button>
      ) : null}
    </div>
  ) : null;
}

function TabBody({
  runId,
  tab,
  pane,
  file,
}: {
  readonly runId: string;
  readonly tab: RunTab;
  readonly pane: string | undefined;
  readonly file: string | undefined;
}) {
  const run = useRun(runId);
  const isTask = useIsTask(runId);
  const onOpenRun = useOpenRun();
  const answerIn = useAnswerIn(runId);
  const openChanges = (id: string) => go({ screen: "run", runId: id, tab: "changes" });
  if (!run)
    // A run just started is not in the state yet: its files are asked for once it is, in its repository.
    return (
      <div className="empty" data-testid="run-not-yet">
        Run <span className="mono">{runId}</span> is not in the state yet: it appears here in a moment.
      </div>
    );
  if (tab === "overview")
    return isTask ? (
      <TaskOverview run={run} onOpenRun={(id) => onOpenRun(id)} onOpenChanges={openChanges} />
    ) : (
      <OverviewTab
        run={run}
        runId={runId}
        onOpenRun={onOpenRun}
        onOpenPane={(p) => go({ screen: "grid", pane: p })}
      />
    );
  if (tab === "terminal")
    return (
      <TerminalTab
        run={run}
        pane={pane}
        answerIn={answerIn}
        onAnswering={onAnswering}
        onOpenRun={onOpenRun}
        onOpenChanges={openChanges}
      />
    );
  if (tab === "changes")
    return (
      <ChangesTab
        run={run}
        runId={runId}
        file={file}
        onOpenFile={(id, f) => go({ screen: "run", runId: id, tab: "changes", ...(f ? { file: f } : {}) })}
      />
    );
  return tab === "activity" ? <ActivityTab runId={runId} repo={run.repo} /> : null;
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
