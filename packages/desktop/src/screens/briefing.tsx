/** Screen 5: what happened since you left, deterministic, from the run's own events. */
import { useCallback, useEffect, useState } from "react";
import type { Activity, Brief } from "../api.ts";
import { StageBar } from "../components/stage-bar.tsx";
import { useDaemon } from "../daemon.tsx";
import { clock, duration } from "../model.ts";

export function BriefingScreen({
  runId,
  onOpenSession,
}: {
  readonly runId: string;
  onOpenSession(runId: string, attach?: boolean): void;
}) {
  const { client, runs } = useDaemon();
  const run = runs.find((r) => r.runId === runId);
  const [brief, setBrief] = useState<Brief>();
  const [events, setEvents] = useState<Activity[]>([]);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const b = await client.brief(runId, run?.repo);
    if (b.ok && b.data) {
      setBrief(b.data);
      const a = await client.activity(runId, run?.repo);
      if (a.ok && a.data) setEvents(a.data.entries.filter((e) => e.at > (b.data as Brief).since));
    } else setError(b.error?.message);
  }, [client, runId, run?.repo]);
  useEffect(() => {
    void load();
  }, [load]);
  const markRead = async () => {
    await client.seen(runId, run?.repo);
    await load();
  };
  const since = brief ? Date.now() - new Date(brief.since).getTime() : 0;
  const question = run?.questions[0];
  const byStage = new Map<string, Activity[]>();
  for (const e of events) byStage.set(e.stage ?? "run", [...(byStage.get(e.stage ?? "run") ?? []), e]);
  return (
    <div className="briefing">
      <div className="main">
        <div className="head">
          <h2>Since you left · {duration(since)}</h2>
          <span className="dim mono">{runId}</span>
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => onOpenSession(runId, true)}>
            Open terminal and attach
          </button>
          <button type="button" onClick={() => void markRead()}>
            Mark as read
          </button>
        </div>
        {run ? <StageBar stages={run.stages} /> : null}
        {error ? <div className="banner">{error}</div> : null}
        <div className="kpis">
          <div className="kpi">
            <div className="v">{brief?.transitions.length ?? 0}</div>
            <div className="l">stage transitions</div>
          </div>
          <div className="kpi">
            <div className="v">{brief?.answers.length ?? 0}</div>
            <div className="l">decisions taken</div>
          </div>
          <div className="kpi">
            <div className="v">{brief?.files.length ?? 0}</div>
            <div className="l">files changed</div>
          </div>
          <div className="kpi">
            <div className="v">{brief?.errors.length ?? 0}</div>
            <div className="l">errors</div>
          </div>
        </div>
        {[...byStage.entries()].map(([stage, list]) => (
          <section key={stage}>
            <h3>{stage}</h3>
            <ul className="timeline">
              {list.map((e, i) => (
                <li key={`${e.at}-${String(i)}`} className={e.type}>
                  <span className="t">{clock(e.at)}</span>
                  <span className="dim">{e.type} · </span>
                  {e.text}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {events.length === 0 ? <div className="empty">Nothing happened since then.</div> : null}
        <section className="box" style={{ marginTop: 12 }}>
          <h3>What it needs from you</h3>
          {question ? (
            <div>
              <div>{question.prompt}</div>
              <div className="chips" style={{ marginTop: 6 }}>
                {question.options.map((o) => (
                  <span
                    key={o.label}
                    className={`chip${question.card?.recommended === o.label ? " teal" : ""}`}
                  >
                    {o.label}
                    {question.card?.recommended === o.label ? " · recommended" : ""}
                  </span>
                ))}
              </div>
            </div>
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
