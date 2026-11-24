/**
 * The panel of a dev container the window lost (round 21, ADR-0106): the container stopped, or
 * the link to its daemon dropped. Start starts the container and reconnects; Reconnect asks the
 * shell for the daemon again (`open_repo`: install check, serve, the tunnel). What it says is
 * `containerDown` (devcontainers.ts).
 */
import { useState } from "react";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { containerDown } from "./devcontainers.ts";
import { useRepos } from "./repos-context.tsx";

export function ContainerDown() {
  const repos = useRepos();
  const d = useDaemon("start", "startError");
  const [busy, setBusy] = useState<"start" | "reconnect">();
  const [why, setWhy] = useState<string>();
  const current = repos.current;
  if (!current?.devcontainer) return null;
  const panel = containerDown(current, repos.states);
  const local = current.devcontainer.localFolder;
  const reconnect = async () => {
    setBusy("reconnect");
    setWhy(undefined);
    const failed = await d.start(current.path);
    await repos.refreshContainers();
    setBusy(undefined);
    if (failed) setWhy(failed);
  };
  const start = async () => {
    setBusy("start");
    setWhy(undefined);
    const failed = await repos.startContainer(local);
    if (failed) {
      setBusy(undefined);
      setWhy(failed);
      return;
    }
    await reconnect();
  };
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
        {why ? (
          <p className="refusal" role="alert">
            {why}
          </p>
        ) : d.startError && !busy ? (
          <p className="dim" data-testid="start-error">
            {d.startError}
          </p>
        ) : null}
        <div className="actions">
          {panel.start ? (
            <button
              type="button"
              className="primary"
              disabled={busy !== undefined}
              onClick={() => void start()}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </button>
          ) : null}
          {panel.reconnect ? (
            <button
              type="button"
              className={panel.start ? "" : "primary"}
              disabled={busy !== undefined}
              onClick={() => void reconnect()}
            >
              {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
            </button>
          ) : null}
          <a className="button-link" href="#/add">
            Add repository…
          </a>
        </div>
      </div>
    </div>
  );
}
