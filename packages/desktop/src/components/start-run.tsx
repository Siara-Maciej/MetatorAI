/**
 * Starting work on a run that nothing works on: "Open a session" starts its conductor in a pane
 * the person can watch and take; "Drive in background" drives it with no terminal. The host is
 * the first installed one of the repository's order, or the one chosen here.
 */
import { useState } from "react";
import { useDaemon, usePolled } from "../daemon.tsx";
import { type Action, useRunControls } from "../hooks.ts";
import { type HostStatus, hostChoice, type Run } from "../model.ts";

export function StartRun({
  run,
  action,
  compact = false,
  onStarted,
}: {
  readonly run: Run;
  readonly action: Action;
  /** One line (a row of the Inbox) instead of the bar under a run's head. */
  readonly compact?: boolean;
  /** The session was opened: the caller shows its terminal. */
  onStarted?: ((how: "session" | "drive") => void) | undefined;
}) {
  const { client } = useDaemon();
  const { openSession, drive } = useRunControls(run, action);
  const s = usePolled(`hosts:${run.repo ?? ""}`, () => client.supervisor(run.repo), 30_000);
  const hosts: readonly HostStatus[] =
    s.data?.hostStatus ?? (s.data?.hosts ?? []).map((id) => ({ id, installed: true }));
  const fallback = s.data ? hostChoice(s.data.policy.hostOrder, s.data.hostStatus, s.data.hosts) : undefined;
  const [chosen, setChosen] = useState<string>();
  const host = chosen ?? run.host ?? fallback;
  const start = async (how: "session" | "drive") => {
    if (await (how === "session" ? openSession(host) : drive(host))) onStarted?.(how);
  };
  return (
    <div className={compact ? "start-run compact" : "start-run"} data-testid={`start-${run.runId}`}>
      {compact ? null : <span className="note">Nothing works on this run. Start its agent:</span>}
      {hosts.length > 1 ? (
        <label className="host">
          <span className="faint">host</span>
          <select aria-label="host" value={host ?? ""} onChange={(e) => setChosen(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id} disabled={!h.installed}>
                {h.id}
                {h.installed ? "" : " (not installed)"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        type="button"
        className="primary"
        disabled={action.busy}
        title="Start the run's agent in a terminal you can watch and take"
        onClick={() => void start("session")}
      >
        Open a session
      </button>
      <button
        type="button"
        disabled={action.busy}
        title="Drive the run in the background, with no terminal"
        onClick={() => void start("drive")}
      >
        Drive in background
      </button>
    </div>
  );
}
