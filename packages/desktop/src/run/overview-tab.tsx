/**
 * The Overview tab of a run: what happened since you left, deterministic, from the run's own
 * events; the question that waits, with its answers; and the run's change, counted from the same
 * source as the Changes tab.
 */
import { ActivityList } from "../components/activity-list.tsx";
import { QuickAnswer } from "../components/answer.tsx";
import { Notice } from "../components/common.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { duration, plural, type Run, routeHash } from "../model.ts";

export function OverviewTab({
  run,
  runId,
  onOpenRun,
}: {
  readonly run: Run | undefined;
  readonly runId: string;
  /** The run's Terminal tab, with the keyboard taken when asked. */
  onOpenRun(runId: string, attach?: boolean): void;
}) {
  const { client } = useDaemon();
  const repo = run?.repo;
  const {
    data,
    error,
    reload: load,
  } = usePolled(
    `overview:${repo ?? ""}:${runId}`,
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
          // The run's change: the same files the Changes tab lists, so the two never disagree.
          files: c.data?.files,
        },
      };
    },
    5000,
  );
  const action = useAction(load);
  const brief = data?.brief;
  const events = data?.events ?? [];
  const files = data?.files;
  const since = brief ? Date.now() - new Date(brief.since).getTime() : 0;
  const question = run?.questions[0];
  const figures: [string, string][] = [
    [String(brief?.transitions.length ?? 0), "stage transitions since you left"],
    [String(brief?.answers.length ?? 0), "decisions taken since you left"],
    [files ? String(files.length) : "—", "files in the run's change"],
    [String(brief?.errors.length ?? 0), "errors since you left"],
  ];
  return (
    <div className="briefing">
      <div className="main">
        <div className="since">
          <h2>Since you left · {duration(since)}</h2>
          <span className="spacer" />
          <button type="button" onClick={() => onOpenRun(runId, true)}>
            Open terminal and attach
          </button>
          <button type="button" onClick={() => void action.run(() => client.seen(runId, repo))}>
            Mark as read
          </button>
        </div>
        {error && !data ? <div className="banner">{error}</div> : null}
        <Notice {...action.notice} />
        <section className="box needs-box" aria-label="what it needs from you">
          <h3>What it needs from you</h3>
          {question ? (
            <>
              <div>{question.prompt}</div>
              {question.source === "permission" ? (
                <button type="button" className="primary" onClick={() => onOpenRun(runId, true)}>
                  Answer in the pane
                </button>
              ) : (
                <QuickAnswer question={question} repo={repo} onDone={() => void load()} />
              )}
            </>
          ) : run?.terminalAsk ? (
            <div className="muted">
              The agent asks in its terminal: open the Terminal tab and answer there.
            </div>
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
        <div className="kpis">
          {figures.map(([value, label]) => (
            <div className="kpi" key={label}>
              <div className="v">{value}</div>
              <div className="l">{label}</div>
            </div>
          ))}
        </div>
        <ActivityList entries={events} variant="by-stage" empty="Nothing happened since then." />
      </div>
      <aside className="side">
        <div className="box">
          <h3>Gates and errors</h3>
          {brief?.errors.length ? (
            <ul>
              {brief.errors.map((e) => (
                <li key={e} className="mono">
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">No errors.</div>
          )}
        </div>
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
        <div className="box">
          <h3>Where this comes from</h3>
          <div className="muted mono">log.md · activity.jsonl · questions/ · .metator/gates/ · git diff</div>
        </div>
      </aside>
    </div>
  );
}
