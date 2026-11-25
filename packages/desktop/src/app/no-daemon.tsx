/**
 * The main area when nothing answers at the daemon's address (D3).
 */

import { useEffect, useState } from "react";
import { useDaemon } from "../shared/daemon/daemon.tsx";
import { Button } from "../ui/button.tsx";

/**
 * The main area when nothing answers at the daemon's address (D3): what is wrong, the command
 * that starts the daemon, the address to try, and Retry. No screen draws over stale or empty data.
 */
export function NoDaemon() {
  const { url, error, setUrl, retry, startable, folder, starting, startError, start } = useDaemon(
    "url",
    "error",
    "setUrl",
    "retry",
    "startable",
    "folder",
    "starting",
    "startError",
    "start",
  );
  const [address, setAddress] = useState(url);
  useEffect(() => setAddress(url), [url]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText("metator serve")
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className="no-daemon" data-testid="no-daemon">
      <div className="panel">
        <h1>The daemon is not running</h1>
        <p>
          This app shows what the MetatorAI daemon reports, and nothing answers at <code>{url}</code>
          {error ? <span className="dim"> ({error})</span> : null}. Sessions, questions and terminals appear
          here once it does.
        </p>
        <h3>Start it</h3>
        {startable ? (
          <>
            <p className="muted">
              The app starts the daemon of {folder ? <code>{folder}</code> : "your repository"} itself, every
              time it opens.
            </p>
            {startError ? (
              <p className="dim" data-testid="start-error">
                The daemon did not start: {startError}
              </p>
            ) : null}
            <div className="addr">
              <Button
                variant="primary"
                disabled={starting || folder === ""}
                onClick={() => void start(folder)}
              >
                {starting ? "Starting…" : "Start it again"}
              </Button>
              <a className="button-link" href="#/add">
                Add repository…
              </a>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              In a terminal, in your repository or in a folder of repositories (new here?{" "}
              <a href="#/add">Add repository</a> lists every step):
            </p>
            <div className="cmd">
              <code>metator serve</code>
              <Button variant="ghost" onClick={copy}>
                {copied ? "copied" : "copy"}
              </Button>
            </div>
          </>
        )}
        <h3>Or point the app at a daemon that runs elsewhere</h3>
        <form
          className="addr"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim() !== "" && address.trim() !== url) setUrl(address);
            else retry();
          }}
        >
          <input
            aria-label="daemon address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="http://127.0.0.1:4310"
          />
          <Button type="submit" variant="primary">
            Retry
          </Button>
        </form>
        <p className="dim">The app also tries again by itself every two seconds.</p>
      </div>
    </div>
  );
}
