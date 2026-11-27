/**
 * The Daemon part of the Overview: four figures as tiles, the open runs with who works on each, the hosts and how the daemon looks after runs.
 *
 * Each part reads only its piece of the daemon's answer (ADR-0113); only the head and the fleet read the runs.
 */

import type { SupervisorView } from "../../shared/api/api.ts";
import { Glyph, StateWord } from "../../shared/components/glyph.tsx";
import { useDaemon, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { duration, plural } from "../../shared/model/format.ts";
import { routeHash } from "../../shared/model/route.ts";
import { type HostStatus, noHostText, openRuns, runStateOf } from "../../shared/model/runs.ts";
import { Button } from "../../ui/button.tsx";
import { exactDuration, runCounts, whoWorks } from "./model.ts";

export function DaemonPanel({ onOpenRun }: { onOpenRun(runId: string): void }) {
  return (
    <div className="supervisor">
      <div className="main">
        <Head />
        <SupervisorError />
        <Kpis />
        <Fleet onOpenRun={onOpenRun} />
      </div>
      <aside className="side policy">
        <div className="box">
          <h3>How the daemon looks after runs</h3>
          <Policy />
          <div className="dim gap-top" data-testid="policy-edit">
            change it in <a href={routeHash({ screen: "settings" })}>Settings › Options</a> → supervisor
          </div>
        </div>
        <div className="box">
          <h3>AI hosts</h3>
          <Hosts />
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

/** What the daemon says of itself, or `select`'s part of it (undefined before the first answer). */
function useSupervisor<R>(select: (view: SupervisorView | undefined) => R): R {
  const { client, repo } = useDaemon("client", "repo");
  return usePolledSelect(`supervisor:${repo ?? ""}`, () => client.supervisor(repo), 5000, select);
}

const hostsOf = (view: SupervisorView | undefined): readonly HostStatus[] =>
  view?.hostStatus ?? (view?.hosts ?? []).map((id) => ({ id, installed: true }));

function Head() {
  const { runs, url } = useDaemon("runs", "url");
  const running = useSupervisor((v) => v !== undefined);
  const uptime = useSupervisor((v) => v?.daemon.uptimeMs);
  const at = useSupervisor((v) => v?.daemon.url);
  const hosts = useSupervisor(hostsOf);
  // Every run that is not finished, escalated ones included: the same count the top bar reads.
  const counts = runCounts(runs);
  const installed = hosts.filter((h) => h.installed);
  return (
    <div className="head">
      <h2>Daemon</h2>
      <span className={`chip ${running ? "green" : "red"}`}>{running ? "running" : "no answer"}</span>
      <span className="dim">
        {plural(counts.open, "run")} · {counts.needYou} need you · {installed.length} of {hosts.length} AI
        hosts installed · up {uptime !== undefined ? duration(uptime) : "—"} · <code>{at ?? url}</code>
      </span>
    </div>
  );
}

function SupervisorError() {
  const { client, repo } = useDaemon("client", "repo");
  const { error } = usePolled(`supervisor:${repo ?? ""}`, () => client.supervisor(repo), 5000);
  return error ? <div className="banner">{error}</div> : null;
}

function Kpis() {
  const a = useSupervisor((v) => v?.acceptance);
  const fromInboxPct = a && a.answered > 0 ? Math.round((100 * a.fromInbox) / a.answered) : undefined;
  return (
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
  );
}

const NO_SESSIONS: NonNullable<SupervisorView["sessions"]> = [];

/** The open runs with who works on each and their terminal. */
function Fleet({ onOpenRun }: { onOpenRun(runId: string): void }) {
  const { runs } = useDaemon("runs");
  const list = useSupervisor((v) => v?.sessions ?? NO_SESSIONS);
  const active = openRuns(runs);
  const sessions = new Map(list.map((s) => [s.runId, s]));
  return (
    <>
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
                  <Button variant="ghost" className="link" onClick={() => onOpenRun(r.runId)}>
                    {r.task}
                  </Button>
                </td>
                <td>{r.repo ?? "—"}</td>
                <td>{r.host ?? "—"}</td>
                <td>{whoWorks(r, s?.alive === true)}</td>
                <td>
                  <Glyph kind="run" state={runStateOf(r)} /> <StateWord kind="run" state={runStateOf(r)} />
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
    </>
  );
}

function Policy() {
  const policy = useSupervisor((v) => v?.policy);
  const superviseMs = useSupervisor((v) => v?.daemon.superviseMs);
  return policy && superviseMs !== undefined ? (
    <dl>
      <dt>runs waiting for you at most</dt>
      <dd>{policy.wipLimit}</dd>
      <dt>start a run again when its agent died</dt>
      <dd>
        {policy.respawn.enabled ? "on" : "off"} · {policy.respawn.maxAttempts} attempts
      </dd>
      <dt>idle after</dt>
      <dd>{exactDuration(policy.idleThresholdMs)}</dd>
      <dt>host order</dt>
      <dd>{policy.hostOrder.join(" → ")}</dd>
      <dt>chat approvals</dt>
      <dd>{policy.chatApprovals}</dd>
      <dt>push</dt>
      <dd>always a person</dd>
      <dt>checks every</dt>
      <dd>{superviseMs > 0 ? exactDuration(superviseMs) : "never"}</dd>
    </dl>
  ) : (
    <div className="muted">—</div>
  );
}

function Hosts() {
  const hosts = useSupervisor(hostsOf);
  const installed = hosts.filter((h) => h.installed);
  return (
    <>
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
    </>
  );
}
