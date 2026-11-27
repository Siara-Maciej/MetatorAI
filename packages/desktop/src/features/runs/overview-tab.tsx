/**
 * The Overview of a step (level 3): the question that waits, with its answers; its plan,
 * read-only (there is no Plan tab); its artefacts and its change, counted from the same source
 * as the Changes tab; and what happened since you left, deterministic, from the run's own events.
 */

import type { Activity, Brief, DaemonClient, RunChangesView } from "../../shared/api/api.ts";
import { CommandText, commandOf } from "../../shared/components/command-text.tsx";
import {
  readAgainNow,
  useDaemon,
  useDaemonStore,
  usePolled,
  usePolledSelect,
  useRun,
} from "../../shared/daemon/daemon.tsx";
import { duration, plural } from "../../shared/model/format.ts";
import { decisionKey, hostPromptOf } from "../../shared/model/needs.ts";
import { routeHash } from "../../shared/model/route.ts";
import type { Run } from "../../shared/model/runs.ts";
import { runAction } from "../../shared/state/action.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { QuickAnswer } from "../inbox/answer.tsx";
import { StepPlan } from "../plans/step-plan.tsx";
import { ActivityList } from "./activity-list.tsx";
import { ArtifactList } from "./artifact-list.tsx";
import { Overview, useOverview, useOverviewApi } from "./run-parts-state.ts";

type OpenRun = (runId: string, attach?: boolean) => void;

interface Briefing {
  readonly brief: Brief;
  readonly events: readonly Activity[];
  /** The run's change: the same files the Changes tab lists, so the two never disagree. */
  readonly files: RunChangesView["files"] | undefined;
}

interface Of {
  readonly runId: string;
  readonly repo: string | undefined;
}

const overviewKey = ({ runId, repo }: Of) => `overview:${repo ?? ""}:${runId}`;

const briefingOf =
  (client: DaemonClient, { runId, repo }: Of) =>
  async () => {
    const b = await client.brief(runId, repo);
    if (!b.ok || !b.data) return { ok: false, ...(b.error ? { error: b.error } : {}) };
    const [a, c] = await Promise.all([
      client.activity(runId, repo),
      client.reviewChanges(runId, undefined, repo),
    ]);
    const since = b.data.since;
    return {
      ok: true,
      data: {
        brief: b.data,
        events: (a.data?.entries ?? []).filter((e) => e.at > since),
        files: c.data?.files,
      },
    };
  };

/** The step's briefing, or `select`'s part of it (undefined before the first answer). */
function useBriefing<R>(of: Of, select: (b: Briefing | undefined) => R): R {
  const { client } = useDaemon("client");
  return usePolledSelect(overviewKey(of), briefingOf(client, of), 5000, select);
}

/** Reads the briefing again now (an answer, Mark as read). */
function useReadAgain(of: Of): () => Promise<void> {
  const daemon = useDaemonStore();
  return () => readAgainNow(daemon.getState().url, overviewKey(of));
}

export function OverviewTab({
  run,
  runId,
  onOpenRun,
  onOpenPane,
}: {
  readonly run: Run | undefined;
  readonly runId: string;
  /** The run's Terminal tab, with the keyboard taken when asked. */
  onOpenRun: OpenRun;
  /** Shows a pane in Terminals (a step's worker). */
  onOpenPane(paneId: string, runId: string): void;
}) {
  const of = { runId, repo: run?.repo };
  return (
    <ScopeProvider store={Overview} init={undefined}>
      <div className="briefing">
        <div className="main">
          <BriefingError {...of} />
          <OverviewNotice />
          <Needs {...of} onOpenRun={onOpenRun} />
          <section className="step-plan" aria-label="its plan" data-testid="step-plan">
            <h3>Its plan</h3>
            <StepPlan run={run} runId={runId} onOpenPane={onOpenPane} onOpenRun={onOpenRun} asks={false} />
          </section>
          <Since {...of} onOpenRun={onOpenRun} />
          <Figures {...of} />
          <Events {...of} />
        </div>
        <aside className="side">
          <Errors {...of} />
          <ChangedFiles {...of} />
          <div className="box">
            <h3>Artifacts</h3>
            <ArtifactList runId={runId} repo={of.repo} />
          </div>
          <div className="box">
            <h3>Where this comes from</h3>
            <div className="muted mono">
              log.md · activity.jsonl · questions/ · .metator/gates/ · git diff
            </div>
          </div>
        </aside>
      </div>
    </ScopeProvider>
  );
}

/** The briefing could not be read, and there is none to show. */
function BriefingError(of: Of) {
  const { client } = useDaemon("client");
  const { data, error } = usePolled(overviewKey(of), briefingOf(client, of), 5000);
  return error && !data ? <div className="banner">{error}</div> : null;
}

function OverviewNotice() {
  const notice = useOverview((s) => s.notice);
  const closeNotice = useOverview((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

/** What the step needs from you: its question with its answers, or what it does. */
function Needs({ runId, repo, onOpenRun }: Of & { onOpenRun: OpenRun }) {
  const run = useRun(runId, repo);
  const readAgain = useReadAgain({ runId, repo });
  const question = run?.questions[0];
  return (
    <section className="box needs-box" aria-label="what it needs from you">
      <h3>What it needs from you</h3>
      {question ? (
        <>
          <div>
            {question.source === "permission" || commandOf(question) ? (
              <CommandText
                prompt={hostPromptOf(question.prompt)?.text || question.prompt}
                command={commandOf(question)}
              />
            ) : (
              question.prompt
            )}{" "}
            <a
              data-testid="decision-link"
              href={routeHash({
                screen: "inbox",
                pick: decisionKey({ repo, runId, question }),
              })}
            >
              its card on Home ›
            </a>
          </div>
          {question.source === "permission" ? (
            <Button variant="primary" onClick={() => onOpenRun(runId, true)}>
              Answer in the pane
            </Button>
          ) : (
            <QuickAnswer question={question} repo={repo} onDone={() => void readAgain()} />
          )}
        </>
      ) : run?.terminalAsk ? (
        <div className="muted">The agent asks in its terminal: open the Terminal tab and answer there.</div>
      ) : run?.status === "escalated" ? (
        <div className="muted">
          The run escalated: remove the cause, then resume or close it in the bar above.
        </div>
      ) : (
        <div className="muted">
          Nothing: the run {run?.attention === "driving" ? "is working" : (run?.status ?? "is not here")}.
        </div>
      )}
    </section>
  );
}

/** Since you left: how long, and the two ways to catch up. */
function Since({ runId, repo, onOpenRun }: Of & { onOpenRun: OpenRun }) {
  const sinceAt = useBriefing({ runId, repo }, (b) => b?.brief.since);
  const api = useOverviewApi();
  const daemon = useDaemonStore();
  const readAgain = useReadAgain({ runId, repo });
  const since = sinceAt ? Date.now() - new Date(sinceAt).getTime() : 0;
  const seen = () =>
    runAction(api, daemon, () => daemon.getState().client.seen(runId, repo), { reload: readAgain });
  return (
    <div className="since">
      <h2>Since you left · {duration(since)}</h2>
      <span className="spacer" />
      <Button onClick={() => onOpenRun(runId, true)}>Open terminal and attach</Button>
      <Button onClick={() => void seen()}>Mark as read</Button>
    </div>
  );
}

function Figures(of: Of) {
  const transitions = useBriefing(of, (b) => b?.brief.transitions.length ?? 0);
  const answers = useBriefing(of, (b) => b?.brief.answers.length ?? 0);
  const files = useBriefing(of, (b) => b?.files?.length);
  const errors = useBriefing(of, (b) => b?.brief.errors.length ?? 0);
  const figures: [string, string][] = [
    [String(transitions), "stage transitions since you left"],
    [String(answers), "decisions taken since you left"],
    [files !== undefined ? String(files) : "—", "files in the run's change"],
    [String(errors), "errors since you left"],
  ];
  return (
    <div className="kpis">
      {figures.map(([value, label]) => (
        <div className="kpi" key={label}>
          <div className="v">{value}</div>
          <div className="l">{label}</div>
        </div>
      ))}
    </div>
  );
}

const NO_EVENTS: readonly Activity[] = [];

function Events(of: Of) {
  const events = useBriefing(of, (b) => b?.events ?? NO_EVENTS);
  return <ActivityList entries={events} variant="by-stage" empty="Nothing happened since then." />;
}

function Errors(of: Of) {
  const errors = useBriefing(of, (b) => b?.brief.errors);
  return (
    <div className="box">
      <h3>Gates and errors</h3>
      {errors?.length ? (
        <ul>
          {errors.map((e) => (
            <li key={e} className="mono">
              {e}
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted">No errors.</div>
      )}
    </div>
  );
}

function ChangedFiles({ runId, repo }: Of) {
  const files = useBriefing({ runId, repo }, (b) => b?.files);
  return (
    <div className="box" data-testid="overview-changes">
      <h3>Changes · {files ? plural(files.length, "file") : "—"}</h3>
      {files?.length ? (
        <ul>
          {files.map((f) => (
            <li key={f.path} className="mono">
              <a href={routeHash({ screen: "run", runId, tab: "changes", file: f.path })}>{f.path}</a>{" "}
              <span className="green">+{f.added}</span> <span className="red">−{f.removed}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted">{files ? "No change yet." : "The change could not be read."}</div>
      )}
    </div>
  );
}
