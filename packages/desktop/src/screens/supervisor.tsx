/** Screen 4: the daemon, its sessions, the supervisor's settings and four figures as tiles. */
import { attentionLabel, Dot } from "../components/chips.tsx";
import { RepoSelect } from "../components/common.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { duration, type HostStatus, noHostText, openRuns, plural, runCounts } from "../model.ts";

export function SupervisorScreen({
  onOpenSession,
  onNew,
}: {
  onOpenSession(runId: string): void;
  onNew(): void;
}) {
  const { client, runs, repo, url } = useDaemon();
  const { data: view, error } = usePolled(`supervisor:${repo ?? ""}`, () => client.supervisor(repo), 5000);
  const a = view?.acceptance;
  const fromInboxPct = a && a.answered > 0 ? Math.round((100 * a.fromInbox) / a.answered) : undefined;
  // Every run that is not finished, escalated ones included: the same count the top bar reads.
  const counts = runCounts(runs);
  const active = openRuns(runs);
  const sessions = new Map((view?.sessions ?? []).map((s) => [s.runId, s]));
  const hosts: readonly HostStatus[] =
    view?.hostStatus ?? (view?.hosts ?? []).map((id) => ({ id, installed: true }));
  const installed = hosts.filter((h) => h.installed);
  return (
    <div className="supervisor">
      <div className="main">
        <div className="head">
          <h2>Daemon</h2>
          <span className={`chip ${view ? "green" : "red"}`}>{view ? "running" : "no answer"}</span>
          <span className="dim">
            {plural(counts.open, "run")} · {counts.needYou} need you · {installed.length} of {hosts.length} AI
            hosts installed · up {view ? duration(view.daemon.uptimeMs) : "—"} ·{" "}
            <code>{view?.daemon.url ?? url}</code>
          </span>
          <span className="spacer" />
          <RepoSelect />
          <button type="button" className="primary" onClick={onNew}>
            + New session
          </button>
        </div>
        {error ? <div className="banner">{error}</div> : null}
        <div className="kpis">
          <div className="kpi" data-testid="kpi-median">
            <div className="v">{a?.medianAnswerMs !== undefined ? duration(a.medianAnswerMs) : "—"}</div>
            <div className="l">median time from a question to its answer ({a?.answered ?? 0} answered)</div>
          </div>
          <div className="kpi" data-testid="kpi-inbox">
            <div className={`v ${fromInboxPct === undefined ? "" : fromInboxPct >= 80 ? "ok" : "bad"}`}>
              {fromInboxPct === undefined ? "—" : `${fromInboxPct}%`}
            </div>
            <div className="l">answered from the card, without opening the session (goal: 80% or more)</div>
          </div>
          <div className="kpi" data-testid="kpi-restarts">
            <div className="v">{a?.restarts ?? 0}</div>
            <div className="l">runs the daemon started again, last 24 h</div>
          </div>
          <div className="kpi" data-testid="kpi-nudges">
            <div className="v">{a?.nudges ?? 0}</div>
            <div className="l">reminders typed to an idle agent, last 24 h</div>
          </div>
        </div>
        <table className="fleet">
          <thead>
            <tr>
              {["run", "repo", "AI host", "working", "state", "uptime", "terminal", "last activity"].map(
                (h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {active.map((r) => {
              const s = sessions.get(r.runId);
              return (
                <tr key={`${r.repo ?? ""}:${r.runId}`}>
                  <td>
                    <button type="button" className="ghost link" onClick={() => onOpenSession(r.runId)}>
                      {r.task}
                    </button>
                  </td>
                  <td>{r.repo ?? "—"}</td>
                  <td>{r.host ?? "—"}</td>
                  <td>{r.driver === "human" ? (r.attachedBy ?? "person") : "agent"}</td>
                  <td>
                    <Dot attention={r.attention} /> {attentionLabel(r.attention)}
                    {r.died ? " · drive died" : ""}
                  </td>
                  <td>{duration(r.elapsedMs)}</td>
                  <td>{s ? (s.alive ? (s.idle ? "idle" : "live") : `exited ${s.exitCode ?? "?"}`) : "—"}</td>
                  <td className="dim">{r.last ? `${r.last.type}: ${r.last.text.slice(0, 60)}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {active.length === 0 ? <div className="empty">No open run.</div> : null}
      </div>
      <aside className="side policy">
        <div className="box">
          <h3>How the daemon looks after runs</h3>
          {view ? (
            <dl>
              <dt>runs waiting for you at most</dt>
              <dd>{view.policy.wipLimit}</dd>
              <dt>start a run again when its agent died</dt>
              <dd>
                {view.policy.respawn.enabled ? "on" : "off"} · {view.policy.respawn.maxAttempts} attempts
              </dd>
              <dt>idle after</dt>
              <dd>{duration(view.policy.idleThresholdMs)}</dd>
              <dt>host order</dt>
              <dd>{view.policy.hostOrder.join(" → ")}</dd>
              <dt>chat approvals</dt>
              <dd>{view.policy.chatApprovals}</dd>
              <dt>push</dt>
              <dd>always a person</dd>
              <dt>checks every</dt>
              <dd>{view.daemon.superviseMs > 0 ? duration(view.daemon.superviseMs) : "never"}</dd>
            </dl>
          ) : (
            <div className="muted">—</div>
          )}
          <div className="dim gap-top">
            edit in <code>metator.config.yml</code> → supervisor
          </div>
        </div>
        <div className="box">
          <h3>AI hosts</h3>
          {hosts.length === 0 ? <div className="muted">—</div> : null}
          {hosts.map((h) => (
            <div key={h.id} className="svc" data-testid={`host-${h.id}`}>
              <span>
                {h.id}
                {h.command && h.command !== h.id ? <span className="dim"> · {h.command}</span> : null}
              </span>
              <span className={h.installed ? "green" : "amber"}>
                {h.installed ? "installed" : "not installed"}
              </span>
            </div>
          ))}
          {hosts.length > 0 && installed.length === 0 ? (
            <div className="muted gap-top">{noHostText(hosts)}</div>
          ) : null}
        </div>
        <div className="box">
          <h3>Answers given always</h3>
          <div className="muted">
            answers given with <code>metator run answer --always</code>; list with{" "}
            <code>metator policy list</code>
          </div>
        </div>
      </aside>
    </div>
  );
}
