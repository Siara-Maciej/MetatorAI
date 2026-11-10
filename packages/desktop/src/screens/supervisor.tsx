/** Screen 4: the daemon, the fleet, the policy and the acceptance criteria as tiles. */
import { useCallback, useEffect, useState } from "react";
import type { SupervisorView } from "../api.ts";
import { attentionLabel, Dot } from "../components/chips.tsx";
import { useDaemon } from "../daemon.tsx";
import { duration } from "../model.ts";

export function SupervisorScreen({
  onOpenSession,
  onNew,
}: {
  onOpenSession(runId: string): void;
  onNew(): void;
}) {
  const { client, runs, repos, url } = useDaemon();
  const [view, setView] = useState<SupervisorView>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const r = await client.supervisor(repos[0]?.name);
    if (r.ok && r.data) {
      setView(r.data);
      setError(undefined);
    } else setError(r.error?.message ?? "no supervisor view");
  }, [client, repos]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  const a = view?.acceptance;
  const fromInboxPct = a && a.answered > 0 ? Math.round((100 * a.fromInbox) / a.answered) : undefined;
  const active = runs.filter((r) => r.status === "active");
  const sessions = new Map((view?.sessions ?? []).map((s) => [s.runId, s]));
  return (
    <div className="supervisor">
      <div className="main">
        <div className="head">
          <h2>Supervisor</h2>
          <span className={`chip ${view ? "green" : "red"}`}>{view ? "daemon up" : "daemon down"}</span>
          <span className="dim">
            {active.length} sessions · {view?.hosts.length ?? 0} hosts · up{" "}
            {view ? duration(view.daemon.uptimeMs) : "—"} · <code>{view?.daemon.url ?? url}</code>
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="primary" onClick={onNew}>
            Spawn session
          </button>
        </div>
        {error ? <div className="banner">{error}</div> : null}
        <div className="kpis">
          <div className="kpi" data-testid="kpi-median">
            <div className={`v ${a?.medianAnswerMs !== undefined ? "" : ""}`}>
              {a?.medianAnswerMs !== undefined ? duration(a.medianAnswerMs) : "—"}
            </div>
            <div className="l">11a · median question → answer ({a?.answered ?? 0} answered)</div>
          </div>
          <div className="kpi" data-testid="kpi-inbox">
            <div className={`v ${fromInboxPct === undefined ? "" : fromInboxPct >= 80 ? "ok" : "bad"}`}>
              {fromInboxPct === undefined ? "—" : `${fromInboxPct}%`}
            </div>
            <div className="l">11a · answered from the card, session unopened (goal ≥ 80%)</div>
          </div>
          <div className="kpi" data-testid="kpi-restarts">
            <div className="v">{a?.restarts ?? 0}</div>
            <div className="l">11b · supervisor restarts, last 24 h (no manual revive)</div>
          </div>
          <div className="kpi" data-testid="kpi-nudges">
            <div className="v">{a?.nudges ?? 0}</div>
            <div className="l">idle nudges, last 24 h</div>
          </div>
        </div>
        <table className="fleet">
          <thead>
            <tr>
              <th>session</th>
              <th>repo</th>
              <th>host</th>
              <th>driver</th>
              <th>state</th>
              <th>uptime</th>
              <th>pty</th>
              <th>last activity</th>
            </tr>
          </thead>
          <tbody>
            {active.map((r) => {
              const s = sessions.get(r.runId);
              return (
                <tr key={r.runId} onClick={() => onOpenSession(r.runId)} style={{ cursor: "pointer" }}>
                  <td>{r.task}</td>
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
        {active.length === 0 ? <div className="empty">No active session.</div> : null}
      </div>
      <aside className="side policy">
        <div className="box">
          <h3>SupervisorPolicy</h3>
          {view ? (
            <dl>
              <dt>WIP limit</dt>
              <dd>{view.policy.wipLimit}</dd>
              <dt>restart with resume</dt>
              <dd>
                {view.policy.respawn.enabled ? "on" : "off"} · {view.policy.respawn.maxAttempts} attempts
              </dd>
              <dt>idle threshold</dt>
              <dd>{duration(view.policy.idleThresholdMs)}</dd>
              <dt>host order</dt>
              <dd>{view.policy.hostOrder.join(" → ")}</dd>
              <dt>chat approvals</dt>
              <dd>{view.policy.chatApprovals}</dd>
              <dt>push</dt>
              <dd>always a person</dd>
              <dt>ticks every</dt>
              <dd>{view.daemon.superviseMs > 0 ? duration(view.daemon.superviseMs) : "never"}</dd>
            </dl>
          ) : (
            <div className="muted">—</div>
          )}
          <div className="dim" style={{ marginTop: 6 }}>
            edit in <code>metator.config.yml</code> → supervisor
          </div>
        </div>
        <div className="box">
          <h3>Hosts</h3>
          <div>{view?.hosts.join(", ") ?? "—"}</div>
        </div>
        <div className="box">
          <h3>Learned policies</h3>
          <div className="muted">
            answers given with <code>metator run answer --always</code>; list with{" "}
            <code>metator policy list</code>
          </div>
        </div>
      </aside>
    </div>
  );
}
