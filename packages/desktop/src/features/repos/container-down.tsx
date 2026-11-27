/**
 * The panel of a dev container the window lost (round 21, ADR-0106): the container stopped, or
 * the link to its daemon dropped. Start starts the container and reconnects; Reconnect asks the
 * shell for the daemon again (`open_repo`: install check, serve, the tunnel). What it says is
 * `containerDown` (devcontainers.ts).
 */

import { useDaemon, useDaemonStore } from "../../shared/daemon/daemon.tsx";
import type { KnownRepo } from "../../shared/platform/tauri-commands.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { containerDown } from "./devcontainers.ts";
import { useRepos } from "./repos-context.tsx";
import { ContainerPanel, useContainerPanel } from "./state.ts";

export function ContainerDown() {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={ContainerPanel} init={{ startDaemon: (folder) => daemon.getState().start(folder) }}>
      <ContainerDownPanel />
    </ScopeProvider>
  );
}

function ContainerDownPanel() {
  const { current, states } = useRepos();
  if (!current?.devcontainer) return null;
  const panel = containerDown(current, states);
  const local = current.devcontainer.localFolder;
  return (
    <div className="no-daemon container-down" data-testid="container-down">
      <div className="panel">
        <h1>{panel.title}</h1>
        {panel.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <p className="dim">
          <code>{current.devcontainer.workspaceFolder}</code> in the container of <code>{local}</code>
        </p>
        <WhyNot />
        <div className="actions">
          {panel.start ? <StartButton current={current} local={local} /> : null}
          {panel.reconnect ? <ReconnectButton current={current} primary={!panel.start} /> : null}
          <a className="button-link" href="#/add">
            Add repository…
          </a>
        </div>
      </div>
    </div>
  );
}

/** Why the last start did not work: the panel's own, else the daemon's while nothing runs. */
function WhyNot() {
  const why = useContainerPanel((s) => s.why);
  const busy = useContainerPanel((s) => s.busy);
  const { startError } = useDaemon("startError");
  return why ? (
    <p className="refusal" role="alert">
      {why}
    </p>
  ) : startError && !busy ? (
    <p className="dim" data-testid="start-error">
      {startError}
    </p>
  ) : null;
}

function StartButton({ current, local }: { readonly current: KnownRepo; readonly local: string }) {
  const busy = useContainerPanel((s) => s.busy);
  const start = useContainerPanel((s) => s.start);
  return (
    <Button variant="primary" disabled={busy !== undefined} onClick={() => void start(local, current.path)}>
      {busy === "start" ? "Starting…" : "Start"}
    </Button>
  );
}

function ReconnectButton({ current, primary }: { readonly current: KnownRepo; readonly primary: boolean }) {
  const busy = useContainerPanel((s) => s.busy);
  const reconnect = useContainerPanel((s) => s.reconnect);
  return (
    <Button
      className={primary ? "primary" : ""}
      disabled={busy !== undefined}
      onClick={() => void reconnect(current.path)}
    >
      {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
    </Button>
  );
}
