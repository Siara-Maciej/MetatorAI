/**
 * Starting work on a run that nothing works on: "Open a session" starts its conductor in a pane
 * the person can watch and take; "Drive in background" drives it with no terminal. The host is
 * the first installed one of the repository's order, or the one chosen here.
 *
 * The host chosen is the StartHost store's (ADR-0113); the hosts are read in the part that shows them.
 */

import { useDaemon, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import type { Action } from "../../shared/hooks.ts";
import { type HostStatus, hostChoice, type Run } from "../../shared/model/runs.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { useRunControls } from "./run-controls.ts";
import { StartHost, useStartHost } from "./run-parts-state.ts";

type Started = ((how: "session" | "drive") => void) | undefined;

export function StartRun({
  run,
  action,
  compact = false,
  sessionOnly = false,
  onStarted,
}: {
  /**
   * The run asks on a card and no session runs for it: only "Open a session" (its conductor in a
   * terminal; the question stays on its card), with why there is no drive to start.
   */
  readonly sessionOnly?: boolean;
  readonly run: Run;
  readonly action: Action;
  /** One line (a row of the Inbox) instead of the bar under a run's head. */
  readonly compact?: boolean;
  /** The session was opened: the caller shows its terminal. */
  onStarted?: Started;
}) {
  return (
    <ScopeProvider store={StartHost} init={undefined}>
      <div className={compact ? "start-run compact" : "start-run"} data-testid={`start-${run.runId}`}>
        {compact ? null : sessionOnly ? (
          <span className="note">
            Its question waits for you on Home, so nothing drives it until it is answered. You can open a
            session to talk to its conductor; the question stays on its card.
          </span>
        ) : (
          <span className="note">Nothing drives this run. Start its agent:</span>
        )}
        <HostChoice run={run} />
        <StartButton run={run} action={action} how="session" onStarted={onStarted} />
        {sessionOnly ? null : <StartButton run={run} action={action} how="drive" onStarted={onStarted} />}
      </div>
    </ScopeProvider>
  );
}

const NO_HOSTS: readonly HostStatus[] = [];

/** The repository's hosts and its default, or `select`'s part of them. */
function useHosts<R>(
  run: Run,
  select: (s: { hosts: readonly HostStatus[]; fallback: string | undefined }) => R,
): R {
  const { client } = useDaemon("client");
  return usePolledSelect(
    `hosts:${run.repo ?? ""}`,
    () => client.supervisor(run.repo),
    30_000,
    (d) =>
      select({
        hosts: d?.hostStatus ?? (d?.hosts ?? []).map((id) => ({ id, installed: true })),
        fallback: d ? hostChoice(d.policy.hostOrder, d.hostStatus, d.hosts) : undefined,
      }),
  );
}

/** The host a start goes to: the one chosen, else the run's, else the first installed one. */
function useHost(run: Run): string | undefined {
  const chosen = useStartHost((s) => s.chosen);
  const fallback = useHosts(run, (h) => h.fallback);
  return chosen ?? run.host ?? fallback;
}

function HostChoice({ run }: { readonly run: Run }) {
  const hosts = useHosts(run, (h) => (h.hosts.length > 0 ? h.hosts : NO_HOSTS));
  const host = useHost(run);
  const choose = useStartHost((s) => s.choose);
  return hosts.length > 1 ? (
    <label className="host">
      <span className="faint">host</span>
      <select aria-label="host" value={host ?? ""} onChange={(e) => choose(e.target.value)}>
        {hosts.map((h) => (
          <option key={h.id} value={h.id} disabled={!h.installed}>
            {h.id}
            {h.installed ? "" : " (not installed)"}
          </option>
        ))}
      </select>
    </label>
  ) : null;
}

function StartButton({
  run,
  action,
  how,
  onStarted,
}: {
  readonly run: Run;
  readonly action: Action;
  readonly how: "session" | "drive";
  readonly onStarted: Started;
}) {
  const { openSession, drive } = useRunControls(run, action);
  const host = useHost(run);
  const start = async () => {
    if (await (how === "session" ? openSession(host) : drive(host))) onStarted?.(how);
  };
  return how === "session" ? (
    <Button
      variant="primary"
      disabled={action.busy}
      title="Start the run's agent in a terminal you can watch and take"
      onClick={() => void start()}
    >
      Open a session
    </Button>
  ) : (
    <Button
      disabled={action.busy}
      title="Drive the run in the background, with no terminal"
      onClick={() => void start()}
    >
      Drive in background
    </Button>
  );
}
