/** Screen 5: what happened since you left, deterministic, from the run's own events. */
import { ActivityList } from "../components/activity-list.tsx";
import { QuickAnswer } from "../components/answer.tsx";
import { Notice } from "../components/common.tsx";
import { RunHeader } from "../components/run-header.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { duration } from "../model.ts";

export function BriefingScreen({
  runId,
  onOpenSession,
}: {
  readonly runId: string;
  onOpenSession(runId: string, attach?: boolean): void;
}) {
  const { client, run: runOf } = useDaemon();
  const run = runOf(runId);
  const repo = run?.repo;
  const {
    data,
    error,
    reload: load,
  } = usePolled(
    `briefing:${repo ?? ""}:${runId}`,
    async () => {
      const b = await client.brief(runId, repo);
      if (!b.ok || !b.data) return { ok: false, ...(b.error ? { error: b.error } : {}) };
      const a = await client.activity(runId, repo);
      const since = b.data.since;
      return { ok: true, data: { brief: b.data, events: (a.data?.entries ?? []).filter((e) => e.at > since) } };
    },
    5000,
  );
  const action = useAction(load);
  const brief = data?.brief;
  const events = data?.events ?? [];
  const since = brief ? Date.now() - new Date(brief.since).getTime() : 0;
  const question = run?.questions[0];
  const figures: [number, string][] = [
    [brief?.transitions.length ?? 0, "stage transitions"],
    [brief?.answers.length ?? 0, "decisions taken"],
    [brief?.files.length ?? 0, "files changed"],
    [brief?.errors.length ?? 0, "errors"],
  ];
  return (
    <div className="briefing">
      <div className="main">
        <RunHeader runId={runId} run={run} screen="briefing" />
        <div className="since">
          <h2>Since you left · {duration(since)}</h2>
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => onOpenSession(runId, true)}>
            Open terminal and attach
          </button>
          <button type="button" onClick={() => void action.run(() => client.seen(runId, repo))}>
            Mark as read
          </button>
        </div>
        {error && !data ? <div className="banner">{error}</div> : null}
        <Notice {...action.notice} />
        <div className="kpis">
          {figures.map(([value, label]) => (
            <div className="kpi" key={label}>
              <div className="v">{value}</div>
              <div className="l">{label}</div>
            </div>
          ))}
        </div>
        <ActivityList entries={events} variant="by-stage" empty="Nothing happened since then." />
        <section className="box needs-box">
          <h3>What it needs from you</h3>
          {question ? (
            <>
              <div>{question.prompt}</div>
              {question.source === "permission" ? (
                <button type="button" className="primary" onClick={() => onOpenSession(runId, true)}>
                  Answer in the pane
                </button>
              ) : (
                <QuickAnswer question={question} repo={repo} onDone={() => void load()} />
              )}
            </>
          ) : (
            <div className="muted">
              nothing: the run {run?.attention === "driving" ? "is working" : (run?.status ?? "is not here")}
            </div>
          )}
        </section>
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
            <div className="muted">no errors</div>
          )}
        </div>
        <div className="box">
          <h3>Changes</h3>
          {brief?.files.length ? (
            <ul>
              {brief.files.map((f) => (
                <li key={f} className="mono">
                  {f}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">no files written</div>
          )}
        </div>
        <div className="box">
          <h3>Where this comes from</h3>
          <div className="muted mono">log.md · activity.jsonl · questions/ · .metator/gates/</div>
        </div>
      </aside>
    </div>
  );
}
